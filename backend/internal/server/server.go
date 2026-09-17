package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/config"
	fsservice "github.com/agenticremote/agenticremote/backend/internal/fs"
	"github.com/agenticremote/agenticremote/backend/internal/protocol"
	runtimestore "github.com/agenticremote/agenticremote/backend/internal/runtime"
	"github.com/agenticremote/agenticremote/backend/internal/security"
	"github.com/agenticremote/agenticremote/backend/internal/session"
	"github.com/coder/websocket"
)

const maxReplayLiveEvents = 64

type SessionAPI interface {
	List(context.Context) []protocol.SessionSummary
	Create(context.Context, protocol.CreateSessionRequest) (*protocol.SessionSummary, error)
	Input(string, []byte) error
	Resize(string, int, int) error
	Close(string) error
	Terminate(context.Context, string) error
	Subscribe(string, func(protocol.PTYOutputEnvelope, protocol.SessionStateEnvelope)) (func(), error)
}

type RuntimeAPI interface {
	RuntimeSnapshot() (*runtimestore.Snapshot, error)
	RuntimeEvents(after int64, limit int) ([]runtimestore.Event, int64, error)
	SubscribeRuntime(func(runtimestore.Event)) func()
}

type runtimeStoreProvider interface {
	RuntimeStore() *runtimestore.Store
}

type runtimeOverflowSubscriber interface {
	SubscribeRuntimeWithOverflow(func(runtimestore.Event), func()) func()
}
type AgentAPI interface {
	CreateAgentRequest(ctx context.Context, req protocol.CreateSessionRequest) (*protocol.AgentSession, error)
	GetAgent(agentID string) (*protocol.AgentSession, error)
	ListAgents() []protocol.AgentSession
	SubmitPrompt(agentID, prompt string) error
	Abort(agentID string) error
	SetModel(agentID, model string) error
	SetThinking(agentID, level string) error
	Terminate(agentID string) error
	Subscribe(agentID string, fn func(protocol.AgentEvent)) (func(), error)
	History(agentID string) (*protocol.AgentHistoryResponse, error)
}

type NotifyAPI interface {
	RegisterToken(context.Context, protocol.NotifyRegisterRequest) error
}

type tmuxAvailabilityProvider interface {
	TmuxAvailable() bool
}

type Server struct {
	cfg             config.Config
	fs              *fsservice.Service
	auth            *security.AuthService
	desktopTickets  *security.DesktopTicketStore
	sessions        SessionAPI
	runtime         RuntimeAPI
	agents          AgentAPI
	notify          NotifyAPI
	limits          *Limits
	tls             *security.TLSMaterial
	pairingSnapshot *security.PairingSnapshot
	ompAvailable    bool
}

func New(cfg config.Config, tlsMaterial *security.TLSMaterial, auth *security.AuthService, sessions SessionAPI, notify NotifyAPI, pairingSnapshot *security.PairingSnapshot) (*Server, error) {
	return NewWithAgents(cfg, tlsMaterial, auth, sessions, nil, notify, pairingSnapshot)
}

func NewWithAgents(cfg config.Config, tlsMaterial *security.TLSMaterial, auth *security.AuthService, sessions SessionAPI, agents AgentAPI, notify NotifyAPI, pairingSnapshot *security.PairingSnapshot) (*Server, error) {
	fsSvc, err := fsservice.NewService(cfg.WorkspaceRoot, filepath.Join(cfg.WorkspaceRoot, cfg.UploadDir), cfg.AllowDestructiveFiles)
	if err != nil {
		return nil, err
	}
	if mc, ok := sessions.(interface{ SetMaxSessions(int) }); ok {
		mc.SetMaxSessions(cfg.MaxSessions)
	}
	_, ompErr := exec.LookPath("omp")
	return &Server{cfg: cfg, fs: fsSvc, auth: auth, desktopTickets: security.NewDesktopTicketStore(), sessions: sessions, runtime: runtimeAPI(sessions), agents: agents, notify: notify, limits: NewLimits(cfg.MaxConnections, cfg.MaxSessions), tls: tlsMaterial, pairingSnapshot: pairingSnapshot, ompAvailable: ompErr == nil}, nil
}

func runtimeAPI(sessions SessionAPI) RuntimeAPI {
	runtime, _ := sessions.(RuntimeAPI)
	return runtime
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/ping", s.handlePing)
	mux.HandleFunc("/v1/sessions", s.withAuth(s.handleSessions))
	mux.HandleFunc("/v1/shells", s.withAuth(s.handleShells))
	mux.HandleFunc("/v1/sessions/", s.withAuth(s.handleSessionAction))
	mux.HandleFunc("/v1/agents", s.withAuth(s.handleAgents))
	mux.HandleFunc("/v1/agents/", s.withAuth(s.handleAgentAction))
	mux.HandleFunc("/v1/runtime/snapshot", s.withAuth(s.handleRuntimeSnapshot))
	mux.HandleFunc("/v1/runtime/events", s.withAuth(s.handleRuntimeEvents))
	mux.HandleFunc("/v1/pairing", s.withAuth(s.handlePairingCreate))
	mux.HandleFunc("/v1/fs/list", s.withAuth(s.handleFSList))
	mux.HandleFunc("/v1/fs/search", s.withAuth(s.handleFSSearch))
	mux.HandleFunc("/v1/fs/read", s.withAuth(s.handleFSRead))
	mux.HandleFunc("/v1/fs/write", s.withAuth(s.handleFSWrite))
	mux.HandleFunc("/v1/fs/delete", s.withAuth(s.handleFSDelete))
	mux.HandleFunc("/v1/fs/rename", s.withAuth(s.handleFSRename))
	mux.HandleFunc("/v1/fs/copy", s.withAuth(s.handleFSCopy))
	mux.HandleFunc("/v1/fs/download", s.withAuth(s.handleFSDownload))
	mux.HandleFunc("/v1/fs/upload", s.withAuth(s.handleFSUpload))
	mux.HandleFunc("/v1/git/status", s.withAuth(s.handleGitStatus))
	mux.HandleFunc("/v1/notify/register", s.withAuth(s.handleNotifyRegister))
	mux.HandleFunc("/v1/daemon/identity", s.withAuth(s.handleDaemonIdentity))
	mux.HandleFunc("/v1/desktop/sessions", s.withAuth(s.handleDesktopSessionCreate))
	if s.cfg.PairingPageUsername != "" && s.cfg.PairingPagePassword != "" {
		mux.HandleFunc("/pairing", s.handlePairingPage)
	}
	mux.HandleFunc("/v1/ws/sessions/", s.handleSessionWS)
	mux.HandleFunc("/v1/ws/runtime", s.handleRuntimeWS)
	mux.HandleFunc("/v1/ws/rfb", s.handleRFBProxy)
	return logRequests(cors(s.allowedCIDR(mux)))
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(data []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.ResponseWriter.Write(data)
}

func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()

		logURL := *r.URL
		q := logURL.Query()
		modified := false
		for _, key := range []string{"token", "ticket"} {
			if q.Has(key) {
				q.Set(key, "REDACTED")
				modified = true
			}
		}
		if modified {
			logURL.RawQuery = q.Encode()
		}
		uri := logURL.RequestURI()

		log.Printf("request start remote=%s method=%s path=%s", r.RemoteAddr, r.Method, uri)
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		if rec.status == 0 {
			rec.status = http.StatusOK
		}
		log.Printf("request complete remote=%s method=%s path=%s status=%d duration=%s", r.RemoteAddr, r.Method, uri, rec.status, time.Since(started))
	})
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) allowedCIDR(next http.Handler) http.Handler {
	if len(s.cfg.AllowedCIDRs) == 0 {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			writeJSON(w, http.StatusForbidden, protocol.ErrorEnvelope{Type: "error", Code: "forbidden_source", Message: "source address is not allowed"})
			return
		}
		ip := net.ParseIP(host)
		if ip == nil {
			writeJSON(w, http.StatusForbidden, protocol.ErrorEnvelope{Type: "error", Code: "forbidden_source", Message: "source address is not allowed"})
			return
		}
		for _, allowed := range s.cfg.AllowedCIDRs {
			_, network, err := net.ParseCIDR(allowed)
			if err == nil && network.Contains(ip) {
				next.ServeHTTP(w, r)
				return
			}
		}
		writeJSON(w, http.StatusForbidden, protocol.ErrorEnvelope{Type: "error", Code: "forbidden_source", Message: "source address is not allowed"})
	})
}

func (s *Server) TLSConfig() *tls.Config {
	return &tls.Config{Certificates: []tls.Certificate{s.tls.Certificate}, MinVersion: tls.VersionTLS12}
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, protocol.HealthResponse{OK: true, Version: "dev"})
}

func (s *Server) handlePing(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte("pong"))
}

func (s *Server) handleDaemonIdentity(w http.ResponseWriter, _ *http.Request) {
	vncAddr := fmt.Sprintf("127.0.0.1:%d", s.cfg.VNCPort)
	conn, err := net.DialTimeout("tcp", vncAddr, 100*time.Millisecond)
	if err == nil {
		_ = conn.Close()
	}
	tmuxAvailable := false
	if provider, ok := s.sessions.(tmuxAvailabilityProvider); ok {
		tmuxAvailable = provider.TmuxAvailable()
	}
	identity := protocol.HostIdentity{HostID: s.tls.Fingerprint, ConnectionID: s.tls.Fingerprint}
	writeJSON(w, http.StatusOK, protocol.DaemonCapabilities{
		Identity: identity,
		Capabilities: []protocol.Capability{
			{Name: "sessions", Enabled: true},
			{Name: "files", Enabled: true},
			{Name: "terminal.pty", Enabled: true},
			{Name: "terminal.tmux", Enabled: tmuxAvailable},
			{Name: "agent.omp", Enabled: s.ompAvailable},
			{Name: "vnc", Enabled: err == nil},
		},
	})
}

func (s *Server) handleRuntimeSnapshot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if s.runtime == nil {
		writeJSON(w, http.StatusNotImplemented, protocol.ErrorEnvelope{Type: "error", Code: "runtime_unavailable", Message: "runtime persistence unavailable"})
		return
	}
	snapshot, err := s.runtime.RuntimeSnapshot()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, protocol.ErrorEnvelope{Type: "error", Code: "runtime_snapshot_failed", Message: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) handleRuntimeEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if s.runtime == nil {
		writeJSON(w, http.StatusNotImplemented, protocol.ErrorEnvelope{Type: "error", Code: "runtime_unavailable", Message: "runtime persistence unavailable"})
		return
	}
	after, limit := int64(0), 100
	var err error
	if raw := r.URL.Query().Get("after"); raw != "" {
		after, err = strconv.ParseInt(raw, 10, 64)
	}
	if err != nil || after < 0 {
		writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "bad_cursor", Message: "after must be a non-negative integer"})
		return
	}
	if raw := r.URL.Query().Get("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
	}
	if err != nil || limit < 0 {
		writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "bad_limit", Message: "limit must be a non-negative integer"})
		return
	}
	events, cursor, err := s.runtime.RuntimeEvents(after, limit)
	if errors.Is(err, runtimestore.ErrCursorExpired) {
		writeJSON(w, http.StatusGone, protocol.ErrorEnvelope{Type: "error", Code: "cursor_expired", Message: err.Error()})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, protocol.ErrorEnvelope{Type: "error", Code: "runtime_events_failed", Message: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events, "cursor": cursor})
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.sessions.List(r.Context()))
	case http.MethodPost:
		var req protocol.CreateSessionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "bad_request", Message: err.Error()})
			return
		}
		summary, err := s.sessions.Create(r.Context(), req)
		if err != nil {
			if errors.Is(err, session.ErrTooManySessions) {
				writeJSON(w, http.StatusTooManyRequests, protocol.ErrorEnvelope{Type: "error", Code: "max_sessions", Message: session.ErrTooManySessions.Error()})
				return
			}
			if errors.Is(err, session.ErrWorkspaceEscape) {
				writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "workspace_escape", Message: err.Error()})
				return
			}
			writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "create_failed", Message: err.Error()})
			return
		}
		writeJSON(w, http.StatusCreated, summary)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleShells(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, protocol.ListShellsResponse{Shells: session.AvailableShells()})
}

func (s *Server) handleSessionAction(w http.ResponseWriter, r *http.Request) {
	if !strings.HasSuffix(r.URL.Path, "/close") || r.Method != http.MethodPost {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/sessions/"), "/close")
	if id == "" {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if err := s.sessions.Terminate(r.Context(), id); err != nil {
		writeJSON(w, http.StatusNotFound, protocol.ErrorEnvelope{Type: "error", Code: "session_not_found", Message: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleAgents(w http.ResponseWriter, r *http.Request) {
	if s.agents == nil {
		writeJSON(w, http.StatusNotImplemented, protocol.ErrorEnvelope{Type: "error", Code: "agents_unavailable", Message: "agent service unavailable"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.agents.ListAgents())
	case http.MethodPost:
		var req protocol.CreateSessionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "bad_request", Message: err.Error()})
			return
		}
		summary, err := s.agents.CreateAgentRequest(r.Context(), req)
		if err != nil {
			if errors.Is(err, session.ErrTooManySessions) {
				writeJSON(w, http.StatusTooManyRequests, protocol.ErrorEnvelope{Type: "error", Code: "max_sessions", Message: session.ErrTooManySessions.Error()})
				return
			}
			if errors.Is(err, session.ErrWorkspaceEscape) {
				writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "workspace_escape", Message: err.Error()})
				return
			}
			writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "create_failed", Message: err.Error()})
			return
		}
		writeJSON(w, http.StatusCreated, summary)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleAgentAction(w http.ResponseWriter, r *http.Request) {
	if s.agents == nil {
		writeJSON(w, http.StatusNotImplemented, protocol.ErrorEnvelope{Type: "error", Code: "agents_unavailable", Message: "agent service unavailable"})
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/v1/agents/")
	parts := strings.Split(path, "/")
	if len(parts) == 0 || parts[0] == "" {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	id := parts[0]
	if len(parts) == 1 && r.Method == http.MethodGet {
		summary, err := s.agents.GetAgent(id)
		if err != nil {
			writeJSON(w, http.StatusNotFound, protocol.ErrorEnvelope{Type: "error", Code: "agent_not_found", Message: err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, summary)
		return
	}
	if len(parts) == 2 && parts[1] == "history" && r.Method == http.MethodGet {
		history, err := s.agents.History(id)
		if err != nil {
			writeJSON(w, http.StatusNotFound, protocol.ErrorEnvelope{Type: "error", Code: "agent_not_found", Message: err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, history)
		return
	}
	if len(parts) == 2 && r.Method == http.MethodPost {
		switch parts[1] {
		case "prompt":
			var req struct {
				Prompt string `json:"prompt"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "bad_request", Message: err.Error()})
				return
			}
			if err := s.agents.SubmitPrompt(id, req.Prompt); err != nil {
				writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "prompt_failed", Message: err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		case "abort":
			if err := s.agents.Abort(id); err != nil {
				writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "abort_failed", Message: err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		case "model":
			var req struct {
				Model string `json:"model"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "bad_request", Message: err.Error()})
				return
			}
			if err := s.agents.SetModel(id, req.Model); err != nil {
				writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "model_failed", Message: err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		case "thinking":
			var req struct {
				Level string `json:"level"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "bad_request", Message: err.Error()})
				return
			}
			if err := s.agents.SetThinking(id, req.Level); err != nil {
				writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "thinking_failed", Message: err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		case "terminate":
			if err := s.agents.Terminate(id); err != nil {
				writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "terminate_failed", Message: err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
			return
		}
	}
	w.WriteHeader(http.StatusNotFound)
}

func (s *Server) handleFSList(w http.ResponseWriter, r *http.Request) {
	entries, err := s.fs.List(r.URL.Query().Get("path"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "fs_list_failed", Message: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, protocol.ListFilesResponse{Entries: entries})
}

func (s *Server) handleFSSearch(w http.ResponseWriter, r *http.Request) {
	entries, err := s.fs.Search(r.URL.Query().Get("path"), r.URL.Query().Get("q"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "fs_search_failed", Message: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, protocol.ListFilesResponse{Entries: entries})
}

func (s *Server) handleFSRead(w http.ResponseWriter, r *http.Request) {
	filePath := r.URL.Query().Get("path")
	if filePath == "" && r.Body != nil {
		var body struct {
			Path string `json:"path"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err == nil && body.Path != "" {
			filePath = body.Path
		}
	}
	resp, err := s.fs.ReadText(filePath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "fs_read_failed", Message: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleFSWrite(w http.ResponseWriter, r *http.Request) {
	var req protocol.WriteFileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "bad_request", Message: err.Error()})
		return
	}
	resp, err := s.fs.WriteText(req.Path, req.Content, req.ExpectedSHA256)
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "sha256 mismatch") {
			status = http.StatusConflict
		}
		writeJSON(w, status, protocol.ErrorEnvelope{Type: "error", Code: "fs_write_failed", Message: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleFSDelete(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if err := s.fs.Delete(path); err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, fsservice.ErrDestructiveDisabled) {
			status = http.StatusForbidden
		}
		writeJSON(w, status, protocol.ErrorEnvelope{Type: "error", Code: "fs_delete_failed", Message: err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleFSRename(w http.ResponseWriter, r *http.Request) {
	var req protocol.RenameFileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "bad_request", Message: err.Error()})
		return
	}
	if err := s.fs.Rename(req.Path, req.NewPath); err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, fsservice.ErrDestructiveDisabled) {
			status = http.StatusForbidden
		} else if errors.Is(err, fsservice.ErrDestinationExists) {
			status = http.StatusConflict
		}
		writeJSON(w, status, protocol.ErrorEnvelope{Type: "error", Code: "fs_rename_failed", Message: err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleFSCopy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var req protocol.CopyFileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "bad_request", Message: err.Error()})
		return
	}
	if err := s.fs.Copy(req.Path, req.NewPath); err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, fsservice.ErrDestinationExists) {
			status = http.StatusConflict
		}
		writeJSON(w, status, protocol.ErrorEnvelope{Type: "error", Code: "fs_copy_failed", Message: err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleFSDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	file, info, filename, err := s.fs.OpenDownload(r.URL.Query().Get("path"))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "fs_download_failed", Message: err.Error()})
		return
	}
	defer file.Close()
	contentType := mime.TypeByExtension(filepath.Ext(filename))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", "attachment; filename="+strconv.Quote(filename))
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	if _, err := io.Copy(w, file); err != nil {
		log.Printf("download copy failed path=%q err=%v", filename, err)
	}
}

func (s *Server) handleFSUpload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 50<<20)
	if err := r.ParseMultipartForm(50 << 20); err != nil {
		writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "fs_upload_failed", Message: err.Error()})
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "fs_upload_failed", Message: err.Error()})
		return
	}
	defer file.Close()
	stored, err := s.fs.Upload(r.URL.Query().Get("path"), file, header)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "fs_upload_failed", Message: err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"path": stored})
}

func (s *Server) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.fs.GitStatus(r.URL.Query().Get("path")))
}

func (s *Server) handleNotifyRegister(w http.ResponseWriter, r *http.Request) {
	var req protocol.NotifyRegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "bad_request", Message: err.Error()})
		return
	}
	if err := s.notify.RegisterToken(r.Context(), req); err != nil {
		writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "notify_register_failed", Message: err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handlePairingCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	lifetime := time.Duration(s.cfg.PairingRotationSeconds)*time.Second + 5*time.Second
	payload, err := s.auth.NewPairing(s.cfg.PublicEndpoint, s.tls.Fingerprint, s.cfg.SkipFingerprintVerification, lifetime, time.Now().UTC())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, protocol.ErrorEnvelope{Type: "error", Code: "pairing_failed", Message: err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, payload)
}

var pairingPageTemplate = template.Must(template.New("pairing").Parse(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>agenticRemote pairing</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #0A0A0A; color: #F0F0F0; }
main { max-width: 960px; margin: 0 auto; padding: 24px 20px 48px; }
h1 { margin: 0 0 4px; font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
p.lede { margin: 0 0 24px; color: #B8B8B8; }
.grid { display: grid; gap: 24px; grid-template-columns: 1fr; }
@media (min-width: 720px) { .grid { grid-template-columns: minmax(0, 384px) 1fr; align-items: start; } }
.qr { background: #F0F0F0; border-radius: 12px; padding: 12px; }
.qr img { display: block; width: 100%; height: auto; }
.meta { display: grid; gap: 10px; }
.meta dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; }
.meta dt { color: #B8B8B8; font-weight: 600; }
.meta dd { margin: 0; word-break: break-all; }
.payload { position: relative; background: #141414; border: 1px solid #2A2A2A; border-radius: 10px; }
.payload-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid #2A2A2A; }
.payload-head span { font-weight: 600; color: #B8B8B8; font-size: 13px; text-transform: none; }
.payload pre { margin: 0; padding: 14px; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #F0F0F0; white-space: pre-wrap; word-break: break-all; overflow-x: auto; }
button.copy { min-height: 36px; padding: 0 14px; border: 0; border-radius: 8px; background: #D19A2C; color: #0A0A0A; font-weight: 700; font-size: 13px; cursor: pointer; }
button.copy:disabled { background: #264E54; color: #F0F0F0; cursor: default; }
.hint { color: #B8B8B8; font-size: 13px; margin-top: 16px; }
</style>
</head>
<body>
<main>
  <h1>agenticRemote pairing</h1>
  <p class="lede">Scan the QR from the app or copy the JSON below. Rotates every few seconds.</p>
  <div class="grid">
    <div class="qr"><img src="data:image/png;base64,{{.QRBase64}}" alt="pairing QR code" width="384" height="384"></div>
    <div class="meta">
      <dl>
        <dt>Endpoint</dt><dd>{{.Endpoint}}</dd>
        <dt>Expires</dt><dd>{{.ExpiresAt}}</dd>
      </dl>
      <div class="payload">
        <div class="payload-head"><span>Pairing payload</span><button type="button" class="copy" id="copy-btn" data-payload="{{.RawJSON}}">Copy JSON</button></div>
        <pre id="payload-json">{{.PrettyJSON}}</pre>
      </div>
      <p class="hint">Auto-refreshes every 5 seconds; the token rotates on each refresh.</p>
    </div>
  </div>
</main>
<script>
(function () {
  var btn = document.getElementById('copy-btn');
  if (!btn) return;
  btn.addEventListener('click', async function () {
    var text = btn.getAttribute('data-payload') || '';
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
      }
      var original = btn.textContent;
      btn.textContent = 'Copied'; btn.disabled = true;
      setTimeout(function () { btn.textContent = original; btn.disabled = false; }, 1500);
    } catch (e) {
      btn.textContent = 'Copy failed';
      setTimeout(function () { btn.textContent = 'Copy JSON'; }, 1500);
    }
  });
})();
</script>
</body>
</html>
`))

const pairingPageUnavailableHTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>agenticRemote pairing</title>
<style>body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0A0A0A;color:#F0F0F0}main{max-width:640px;margin:0 auto;padding:48px 20px;text-align:center}h1{margin:0 0 8px;font-size:22px}p{margin:0;color:#B8B8B8}</style>
</head><body><main><h1>agenticRemote pairing</h1><p>No pairing payload has been published yet. This page refreshes automatically.</p></main></body></html>
`

func (s *Server) setPairingPageHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func (s *Server) handlePairingPage(w http.ResponseWriter, r *http.Request) {
	s.setPairingPageHeaders(w)
	username, password, ok := r.BasicAuth()
	wantUser := sha256.Sum256([]byte(s.cfg.PairingPageUsername))
	wantPass := sha256.Sum256([]byte(s.cfg.PairingPagePassword))
	gotUser := sha256.Sum256([]byte(username))
	gotPass := sha256.Sum256([]byte(password))
	if !ok || subtle.ConstantTimeCompare(wantUser[:], gotUser[:]) != 1 || subtle.ConstantTimeCompare(wantPass[:], gotPass[:]) != 1 {
		w.Header().Set("WWW-Authenticate", `Basic realm="agenticRemote pairing", charset="UTF-8"`)
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	presentation, ok := s.pairingSnapshot.Load()
	if !ok {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, pairingPageUnavailableHTML)
		return
	}
	prettyJSON, err := json.MarshalIndent(presentation.Payload, "", "  ")
	if err != nil {
		log.Printf("pairing page pretty marshal failed: %v", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := pairingPageTemplate.Execute(w, struct {
		QRBase64   string
		Endpoint   string
		ExpiresAt  string
		RawJSON    string
		PrettyJSON string
	}{
		QRBase64:   base64.StdEncoding.EncodeToString(presentation.QRPng),
		Endpoint:   presentation.Payload.Endpoint,
		ExpiresAt:  presentation.Payload.ExpiresAt.Format(time.RFC3339),
		RawJSON:    string(presentation.CanonicalJSON),
		PrettyJSON: string(prettyJSON),
	}); err != nil {
		log.Printf("pairing page render failed: %v", err)
	}
}

func (s *Server) handleSessionWS(w http.ResponseWriter, r *http.Request) {
	if err := s.limits.AcquireWS(r.Context()); err != nil {
		writeJSON(w, http.StatusTooManyRequests, protocol.ErrorEnvelope{Type: "error", Code: "max_connections", Message: err.Error()})
		return
	}
	defer s.limits.ReleaseWS()
	sessionID := strings.TrimPrefix(r.URL.Path, "/v1/ws/sessions/")
	connType := "Terminal"
	if sessionID == "bootstrap" {
		connType = "Auth-Bootstrap"
	}
	log.Printf("[INFO] Connection opened | Type: %s | IP: %s | Endpoint: %s", connType, r.RemoteAddr, r.URL.Path)
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	ctx := r.Context()
	if sessionID == "bootstrap" {
		s.handleBootstrapWS(ctx, conn)
		return
	}
	s.handlePTYWS(ctx, conn, sessionID)
}

func (s *Server) handleBootstrapWS(ctx context.Context, conn *websocket.Conn) {
	for {
		var frame map[string]any
		if err := wsReadJSON(ctx, conn, &frame); err != nil {
			log.Printf("bootstrap auth: read frame: %v", err)
			return
		}
		switch frame["type"] {
		case "auth.hello":
			var hello protocol.AuthHello
			if err := mapToStruct(frame, &hello); err != nil {
				log.Printf("bootstrap auth: invalid hello frame: %v", err)
				_ = wsWriteJSON(ctx, conn, protocol.ErrorEnvelope{Type: "error", Code: "bad_request", Message: "invalid auth hello"})
				return
			}
			challenge, err := s.auth.Begin(security.HelloMessage{PairingID: hello.PairingID, ClientNonce: hello.ClientNonce, ClientName: hello.ClientName})
			if err != nil {
				log.Printf("bootstrap auth: hello rejected for pairingId=%s: %v", hello.PairingID, err)
				_ = wsWriteJSON(ctx, conn, protocol.ErrorEnvelope{Type: "error", Code: "auth_failed", Message: err.Error()})
				return
			}
			_ = wsWriteJSON(ctx, conn, protocol.AuthChallenge{Type: "auth.challenge", ServerNonce: challenge.ServerNonce, ChallengeID: challenge.ChallengeID, Salt: challenge.Salt})
		case "auth.proof":
			var proof protocol.AuthProof
			if err := mapToStruct(frame, &proof); err != nil {
				log.Printf("bootstrap auth: invalid proof frame: %v", err)
				_ = wsWriteJSON(ctx, conn, protocol.ErrorEnvelope{Type: "error", Code: "bad_request", Message: "invalid auth proof"})
				return
			}
			token, err := s.auth.Complete(proof.PairingID, proof.ChallengeID, proof.Proof)
			if err != nil {
				log.Printf("bootstrap auth: proof rejected for pairingId=%s: %v", proof.PairingID, err)
				_ = wsWriteJSON(ctx, conn, protocol.ErrorEnvelope{Type: "error", Code: "auth_failed", Message: err.Error()})
				return
			}
			log.Printf("bootstrap auth: pairing succeeded for pairingId=%s", proof.PairingID)
			_ = wsWriteJSON(ctx, conn, protocol.AuthOK{Type: "auth.ok", SessionToken: token})
			return
		default:
			log.Printf("bootstrap auth: unsupported frame type=%q", frame["type"])
			_ = wsWriteJSON(ctx, conn, protocol.ErrorEnvelope{Type: "error", Code: "auth_failed", Message: "authentication failed"})
			return
		}
	}
}

func (s *Server) handlePTYWS(ctx context.Context, conn *websocket.Conn, sessionID string) {
	var token protocol.AuthToken
	if err := wsReadJSON(ctx, conn, &token); err != nil || token.Type != "auth.token" || !s.authSession(token.Token) {
		_ = wsWriteJSON(ctx, conn, protocol.ErrorEnvelope{Type: "error", Code: "auth_failed", Message: "authentication failed"})
		return
	}
	var writeMu sync.Mutex
	write := func(v any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return wsWriteJSON(ctx, conn, v)
	}
	unsubscribe, err := s.sessions.Subscribe(sessionID, func(output protocol.PTYOutputEnvelope, state protocol.SessionStateEnvelope) {
		if output.Type != "" {
			_ = write(output)
		}
		if state.Type != "" {
			_ = write(state)
		}
	})
	if err != nil {
		_ = write(protocol.ErrorEnvelope{Type: "error", Code: "session_not_found", Message: err.Error()})
		return
	}
	defer unsubscribe()
	for {
		var frame map[string]any
		if err := wsReadJSON(ctx, conn, &frame); err != nil {
			return
		}
		switch frame["type"] {
		case "pty.input":
			var env protocol.PTYInputEnvelope
			if err := mapToStruct(frame, &env); err == nil {
				data, err := base64.StdEncoding.DecodeString(env.Data)
				if err != nil {
					_ = write(protocol.ErrorEnvelope{Type: "error", Code: "bad_request", Message: "invalid pty input data"})
					continue
				}
				_ = s.sessions.Input(sessionID, data)
			}
		case "pty.resize":
			var env protocol.PTYResizeEnvelope
			if err := mapToStruct(frame, &env); err == nil {
				_ = s.sessions.Resize(sessionID, env.Cols, env.Rows)
			}
		default:
			_ = write(protocol.ErrorEnvelope{Type: "error", Code: "unsupported", Message: "unsupported frame"})
		}
	}
}

func (s *Server) handleRuntimeWS(w http.ResponseWriter, r *http.Request) {
	if err := s.limits.AcquireWS(r.Context()); err != nil {
		writeJSON(w, http.StatusTooManyRequests, protocol.ErrorEnvelope{Type: "error", Code: "max_connections", Message: err.Error()})
		return
	}
	defer s.limits.ReleaseWS()

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	ctx := r.Context()

	var token protocol.AuthToken
	if err := wsReadJSON(ctx, conn, &token); err != nil || token.Type != "auth.token" || !s.authSession(token.Token) {
		_ = wsWriteJSON(ctx, conn, protocol.ErrorEnvelope{Type: "error", Code: "auth_failed", Message: "authentication failed"})
		return
	}

	var writeMu sync.Mutex
	write := func(v any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return wsWriteJSON(ctx, conn, v)
	}

	var channelsMu sync.Mutex
	channels := make(map[string]func())
	defer func() {
		channelsMu.Lock()
		for _, unsub := range channels {
			unsub()
		}
		channelsMu.Unlock()
	}()

	for {
		var frame map[string]any
		if err := wsReadJSON(ctx, conn, &frame); err != nil {
			return
		}
		typ, _ := frame["type"].(string)
		switch typ {
		case "channel.open":
			var env protocol.ChannelOpenEnvelope
			if err := mapToStruct(frame, &env); err != nil {
				_ = write(protocol.ErrorEnvelope{Type: "error", Code: "bad_request", Message: "invalid channel.open"})
				continue
			}
			if env.Kind == "agent" && s.agents != nil {
				channelID := env.ChannelID
				var liveMu sync.Mutex
				replaying := true
				liveEvents := make([]protocol.AgentEvent, 0, maxReplayLiveEvents)
				overflowed := false
				unsub, err := s.agents.Subscribe(env.TargetID, func(ev protocol.AgentEvent) {
					liveMu.Lock()
					if replaying {
						if len(liveEvents) == cap(liveEvents) {
							overflowed = true
						} else {
							liveEvents = append(liveEvents, ev)
						}
						liveMu.Unlock()
						return
					}
					liveMu.Unlock()
					_ = write(protocol.RuntimeEventEnvelope{Type: "event", ChannelID: channelID, Cursor: ev.Cursor, Event: ev})
				})
				if err != nil {
					_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: env.RequestID, OK: false, Error: err.Error()})
					continue
				}
				channelsMu.Lock()
				if prev, ok := channels[env.ChannelID]; ok {
					prev()
				}
				channels[env.ChannelID] = unsub
				channelsMu.Unlock()

				cursor := env.After
				replayFailed := false
				if s.runtime != nil {
					snapshot, err := s.runtime.RuntimeSnapshot()
					if err != nil {
						replayFailed = true
						_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: env.RequestID, OK: false, Error: err.Error()})
					} else {
						cursor = snapshot.Cursor
						replayAfter := env.After
						for replayAfter < cursor {
							events, next, err := s.runtime.RuntimeEvents(replayAfter, 500)
							if err != nil {
								replayFailed = true
								_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: env.RequestID, OK: false, Error: err.Error()})
								break
							}
							for _, event := range events {
								if !isAgentEventKind(event.Kind) {
									continue
								}
								if event.Cursor > cursor || event.SurfaceID != env.TargetID {
									continue
								}
								var agentEvent protocol.AgentEvent
								if json.Unmarshal(event.Payload, &agentEvent) != nil {
									continue
								}
								agentEvent.Cursor = event.Cursor
								_ = write(protocol.RuntimeEventEnvelope{Type: "event", ChannelID: channelID, Cursor: event.Cursor, Event: agentEvent})
							}
							if len(events) == 0 || next <= replayAfter {
								replayFailed = true
								_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: env.RequestID, OK: false, Error: "runtime replay incomplete"})
								break
							}
							replayAfter = next
						}
					}
				}
				if replayFailed {
					unsub()
					channelsMu.Lock()
					delete(channels, env.ChannelID)
					channelsMu.Unlock()
					continue
				}

				liveMu.Lock()
				if overflowed {
					replaying = false
					liveMu.Unlock()
					unsub()
					channelsMu.Lock()
					delete(channels, env.ChannelID)
					channelsMu.Unlock()
					_ = write(protocol.ChannelClosedEnvelope{Type: "channel.closed", ChannelID: channelID, Reason: "resync_required"})
					continue
				}
				liveMu.Unlock()

				// Events arriving after high-water were buffered while replay ran.
				for {
					liveMu.Lock()
					pending := liveEvents
					liveEvents = make([]protocol.AgentEvent, 0, maxReplayLiveEvents)
					if overflowed {
						replaying = false
						liveMu.Unlock()
						unsub()
						channelsMu.Lock()
						delete(channels, env.ChannelID)
						channelsMu.Unlock()
						_ = write(protocol.ChannelClosedEnvelope{Type: "channel.closed", ChannelID: channelID, Reason: "resync_required"})
						break
					}
					if len(pending) == 0 {
						_ = write(protocol.ChannelOpenedEnvelope{Type: "channel.opened", RequestID: env.RequestID, ChannelID: channelID, Cursor: cursor})
						replaying = false
						liveMu.Unlock()
						break
					}
					liveMu.Unlock()
					for _, event := range pending {
						if event.Cursor > cursor {
							_ = write(protocol.RuntimeEventEnvelope{Type: "event", ChannelID: channelID, Cursor: event.Cursor, Event: event})
						}
					}
				}
			} else if env.Kind == "runtime" && s.runtime != nil {
				channelID := env.ChannelID
				toEnvelope := func(event runtimestore.Event) protocol.RuntimeEventEnvelope {
					return protocol.RuntimeEventEnvelope{Type: "event", ChannelID: channelID, Cursor: event.Cursor, Event: protocol.RuntimeLifecycleEvent{SurfaceID: event.SurfaceID, Type: event.Kind, Payload: event.Payload}}
				}
				var liveMu sync.Mutex
				replaying := true
				liveEvents := make([]runtimestore.Event, 0, maxReplayLiveEvents)
				overflowed := false
				var unsub func()
				handleOverflow := func() {
					liveMu.Lock()
					if replaying {
						overflowed = true
						liveMu.Unlock()
						return
					}
					liveMu.Unlock()
					channelsMu.Lock()
					_, ok := channels[channelID]
					if ok {
						delete(channels, channelID)
					}
					channelsMu.Unlock()
					if ok {
						if unsub != nil {
							unsub()
						}
						_ = write(protocol.ChannelClosedEnvelope{
							Type:      "channel.closed",
							ChannelID: channelID,
							Reason:    "resync_required",
						})
					}
				}
				onEvent := func(event runtimestore.Event) {
					liveMu.Lock()
					if replaying {
						if len(liveEvents) == cap(liveEvents) {
							overflowed = true
						} else {
							liveEvents = append(liveEvents, event)
						}
						liveMu.Unlock()
						return
					}
					liveMu.Unlock()
					_ = write(toEnvelope(event))
				}
				if provider, ok := s.runtime.(runtimeStoreProvider); ok && provider.RuntimeStore() != nil {
					unsub = provider.RuntimeStore().Subscribe(onEvent, handleOverflow)
				} else if overflowSub, ok := s.runtime.(runtimeOverflowSubscriber); ok {
					unsub = overflowSub.SubscribeRuntimeWithOverflow(onEvent, handleOverflow)
				} else {
					unsub = s.runtime.SubscribeRuntime(onEvent)
				}
				channelsMu.Lock()
				if prev, ok := channels[channelID]; ok {
					prev()
				}
				channels[channelID] = unsub
				channelsMu.Unlock()

				snapshot, err := s.runtime.RuntimeSnapshot()
				if err != nil {
					unsub()
					channelsMu.Lock()
					delete(channels, channelID)
					channelsMu.Unlock()
					_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: env.RequestID, OK: false, Error: err.Error()})
					continue
				}
				cursor := snapshot.Cursor
				replayAfter := env.After
				replayFailed := false
				for replayAfter < cursor {
					events, next, err := s.runtime.RuntimeEvents(replayAfter, 500)
					if err != nil {
						replayFailed = true
						_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: env.RequestID, OK: false, Error: err.Error()})
						break
					}
					for _, event := range events {
						if event.Cursor <= cursor {
							_ = write(toEnvelope(event))
						}
					}
					if len(events) == 0 || next <= replayAfter {
						replayFailed = true
						_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: env.RequestID, OK: false, Error: "runtime replay incomplete"})
						break
					}
					replayAfter = next
				}
				if replayFailed {
					unsub()
					channelsMu.Lock()
					delete(channels, channelID)
					channelsMu.Unlock()
					continue
				}
				liveMu.Lock()
				if overflowed {
					replaying = false
					liveMu.Unlock()
					unsub()
					channelsMu.Lock()
					delete(channels, channelID)
					channelsMu.Unlock()
					_ = write(protocol.ChannelClosedEnvelope{Type: "channel.closed", ChannelID: channelID, Reason: "resync_required"})
					continue
				}
				liveMu.Unlock()

				for {
					liveMu.Lock()
					pending := liveEvents
					liveEvents = make([]runtimestore.Event, 0, maxReplayLiveEvents)
					if overflowed {
						replaying = false
						liveMu.Unlock()
						unsub()
						channelsMu.Lock()
						delete(channels, channelID)
						channelsMu.Unlock()
						_ = write(protocol.ChannelClosedEnvelope{Type: "channel.closed", ChannelID: channelID, Reason: "resync_required"})
						break
					}
					if len(pending) == 0 {
						_ = write(protocol.ChannelOpenedEnvelope{Type: "channel.opened", RequestID: env.RequestID, ChannelID: channelID, Cursor: cursor})
						replaying = false
						liveMu.Unlock()
						break
					}
					liveMu.Unlock()
					for _, event := range pending {
						if event.Cursor > cursor {
							_ = write(toEnvelope(event))
						}
					}
				}
			} else {
				_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: env.RequestID, OK: false, Error: "unsupported channel kind"})
			}
		case "channel.close":
			var env protocol.ChannelCloseEnvelope
			if err := mapToStruct(frame, &env); err != nil {
				continue
			}
			channelsMu.Lock()
			if unsub, ok := channels[env.ChannelID]; ok {
				unsub()
				delete(channels, env.ChannelID)
			}
			channelsMu.Unlock()
			_ = write(protocol.ChannelClosedEnvelope{
				Type:      "channel.closed",
				ChannelID: env.ChannelID,
				Reason:    "closed_by_client",
			})
		case "command":
			var env protocol.CommandEnvelope
			if err := mapToStruct(frame, &env); err != nil {
				_ = write(protocol.ErrorEnvelope{Type: "error", Code: "bad_request", Message: "invalid command"})
				continue
			}
			s.executeCommand(ctx, env, write)
		default:
			_ = write(protocol.ErrorEnvelope{Type: "error", Code: "unsupported", Message: "unsupported frame type"})
		}
	}
}

func isAgentEventKind(kind string) bool {
	switch kind {
	case "message.user", "message.assistant", "message.system", "message.thinking", "tool.call", "tool.result", "state":
		return true
	default:
		return false
	}
}

func (s *Server) executeCommand(ctx context.Context, cmd protocol.CommandEnvelope, write func(any) error) {
	switch cmd.Command {
	case "agent.create":
		if s.agents == nil {
			_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: false, Error: "agent service unavailable"})
			return
		}
		var args struct {
			CWD     string   `json:"cwd"`
			Name    string   `json:"name"`
			Args    []string `json:"args"`
			Backend string   `json:"backend"`
		}
		if cmd.Args != nil {
			if m, ok := cmd.Args.(map[string]any); ok {
				_ = mapToStruct(m, &args)
			}
		}
		summary, err := s.agents.CreateAgentRequest(ctx, protocol.CreateSessionRequest{CWD: args.CWD, Name: args.Name, Args: args.Args, Backend: args.Backend})
		if err != nil {
			_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: false, Error: err.Error()})
			return
		}
		_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: true, Result: summary})
	case "agent.prompt":
		if s.agents == nil {
			_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: false, Error: "agent service unavailable"})
			return
		}
		var args struct {
			Prompt string `json:"prompt"`
		}
		if cmd.Args != nil {
			if m, ok := cmd.Args.(map[string]any); ok {
				_ = mapToStruct(m, &args)
			}
		}
		err := s.agents.SubmitPrompt(cmd.TargetID, args.Prompt)
		if err != nil {
			_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: false, Error: err.Error()})
			return
		}
		_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: true})
	case "agent.abort":
		if s.agents == nil {
			_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: false, Error: "agent service unavailable"})
			return
		}
		err := s.agents.Abort(cmd.TargetID)
		if err != nil {
			_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: false, Error: err.Error()})
			return
		}
		_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: true})
	case "agent.model":
		if s.agents == nil {
			_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: false, Error: "agent service unavailable"})
			return
		}
		var args struct {
			Model string `json:"model"`
		}
		if cmd.Args != nil {
			if m, ok := cmd.Args.(map[string]any); ok {
				_ = mapToStruct(m, &args)
			}
		}
		err := s.agents.SetModel(cmd.TargetID, args.Model)
		if err != nil {
			_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: false, Error: err.Error()})
			return
		}
		_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: true})
	case "agent.thinking":
		if s.agents == nil {
			_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: false, Error: "agent service unavailable"})
			return
		}
		var args struct {
			Level string `json:"level"`
		}
		if cmd.Args != nil {
			if m, ok := cmd.Args.(map[string]any); ok {
				_ = mapToStruct(m, &args)
			}
		}
		err := s.agents.SetThinking(cmd.TargetID, args.Level)
		if err != nil {
			_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: false, Error: err.Error()})
			return
		}
		_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: true})
	case "agent.terminate":
		if s.agents == nil {
			_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: false, Error: "agent service unavailable"})
			return
		}
		err := s.agents.Terminate(cmd.TargetID)
		if err != nil {
			_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: false, Error: err.Error()})
			return
		}
		_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: true})
	case "terminal.create":
		var req protocol.CreateSessionRequest
		if cmd.Args != nil {
			if m, ok := cmd.Args.(map[string]any); ok {
				_ = mapToStruct(m, &req)
			}
		}
		summary, err := s.sessions.Create(ctx, req)
		if err != nil {
			_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: false, Error: err.Error()})
			return
		}
		_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: true, Result: summary})
	case "terminal.resize":
		var args struct {
			Cols int `json:"cols"`
			Rows int `json:"rows"`
		}
		if cmd.Args != nil {
			if m, ok := cmd.Args.(map[string]any); ok {
				_ = mapToStruct(m, &args)
			}
		}
		err := s.sessions.Resize(cmd.TargetID, args.Cols, args.Rows)
		if err != nil {
			_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: false, Error: err.Error()})
			return
		}
		_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: true})
	case "terminal.close":
		err := s.sessions.Terminate(ctx, cmd.TargetID)
		if err != nil {
			_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: false, Error: err.Error()})
			return
		}
		_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: true})
	default:
		_ = write(protocol.CommandResultEnvelope{Type: "command.result", RequestID: cmd.RequestID, OK: false, Error: "unknown command: " + cmd.Command})
	}
}

func (s *Server) handleDesktopSessionCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, protocol.ErrorEnvelope{Type: "error", Code: "method_not_allowed", Message: "method not allowed"})
		return
	}

	vncAddr := fmt.Sprintf("127.0.0.1:%d", s.cfg.VNCPort)
	conn, err := net.DialTimeout("tcp", vncAddr, 100*time.Millisecond)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, protocol.ErrorEnvelope{Type: "error", Code: "vnc_unavailable", Message: "VNC server is not running"})
		return
	}
	_ = conn.Close()

	ticket, expiresAt, err := s.desktopTickets.Issue("desktop:connect", 60*time.Second, time.Now())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, protocol.ErrorEnvelope{Type: "error", Code: "internal_error", Message: "failed to generate ticket"})
		return
	}

	wsBase := s.cfg.PublicEndpoint
	if strings.HasPrefix(wsBase, "https://") {
		wsBase = "wss://" + strings.TrimPrefix(wsBase, "https://")
	} else if strings.HasPrefix(wsBase, "http://") {
		wsBase = "ws://" + strings.TrimPrefix(wsBase, "http://")
	}
	wsBase = strings.TrimRight(wsBase, "/")
	wsUrl := fmt.Sprintf("%s/v1/ws/rfb?ticket=%s", wsBase, url.QueryEscape(ticket))

	writeJSON(w, http.StatusOK, protocol.DesktopSessionResponse{
		Ticket:    ticket,
		WSUrl:     wsUrl,
		ExpiresAt: expiresAt,
	})
}

func (s *Server) handleRFBProxy(w http.ResponseWriter, r *http.Request) {
	// 1. Validate desktop ticket before resource acquisition or backend dial (fail closed)
	ticketPlain := r.URL.Query().Get("ticket")
	if ticketPlain == "" || s.desktopTickets == nil || !s.desktopTickets.Valid(ticketPlain, "desktop:connect", time.Now()) {
		writeJSON(w, http.StatusUnauthorized, protocol.ErrorEnvelope{Type: "error", Code: "unauthorized", Message: "authentication failed"})
		return
	}

	log.Printf("[INFO] Connection opened | Type: noVNC | IP: %s | Endpoint: %s", r.RemoteAddr, r.URL.Path)

	// 2. Resource limits
	if err := s.limits.AcquireWS(r.Context()); err != nil {
		writeJSON(w, http.StatusTooManyRequests, protocol.ErrorEnvelope{Type: "error", Code: "max_connections", Message: err.Error()})
		return
	}
	defer s.limits.ReleaseWS()

	// 3. Backend availability
	vncAddr := fmt.Sprintf("127.0.0.1:%d", s.cfg.VNCPort)
	tcpConn, err := net.DialTimeout("tcp", vncAddr, 5*time.Second)
	if err != nil {
		log.Printf("[ERROR] VNC proxy: cannot reach %s: %v", vncAddr, err)
		writeJSON(w, http.StatusServiceUnavailable, protocol.ErrorEnvelope{Type: "error", Code: "vnc_unavailable", Message: "VNC server is not running"})
		return
	}
	defer tcpConn.Close()

	// 4. Disable global write timeouts on the HTTP connection
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})

	// 5. Upgrade
	acceptOpts := &websocket.AcceptOptions{InsecureSkipVerify: true}
	if h := r.Header.Get("Sec-WebSocket-Protocol"); h != "" {
		for _, p := range strings.Split(h, ",") {
			acceptOpts.Subprotocols = append(acceptOpts.Subprotocols, strings.TrimSpace(p))
		}
	}
	wsConn, err := websocket.Accept(w, r, acceptOpts)
	if err != nil {
		log.Printf("[ERROR] VNC proxy: websocket accept: %v", err)
		return
	}
	wsConn.SetReadLimit(32 * 1024 * 1024)

	// 6. Consume ticket atomically after successful WebSocket upgrade
	if !s.desktopTickets.Consume(ticketPlain, "desktop:connect", time.Now()) {
		_ = wsConn.Close(websocket.StatusPolicyViolation, "ticket already consumed")
		return
	}

	// 7. Bridge: keep TCP reads alive after a clean WebSocket close.
	var wsMux sync.Mutex
	tcpToWS := make(chan struct{})
	go func() {
		defer close(tcpToWS)
		buf := make([]byte, 32*1024)
		for {
			n, err := tcpConn.Read(buf)
			if err != nil {
				if err != io.EOF {
					log.Printf("[DEBUG] VNC proxy: TCP read error: %v", err)
				}
				wsMux.Lock()
				_ = wsConn.Close(websocket.StatusNormalClosure, "")
				wsMux.Unlock()
				return
			}
			if n == 0 {
				continue
			}
			wsMux.Lock()
			writeErr := wsConn.Write(r.Context(), websocket.MessageBinary, buf[:n])
			wsMux.Unlock()
			if writeErr != nil {
				log.Printf("[DEBUG] VNC proxy: WebSocket write error: %v", writeErr)
				return
			}
		}
	}()

	for {
		msgType, data, err := wsConn.Read(r.Context())
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure {
				if tcpTCP, ok := tcpConn.(*net.TCPConn); ok {
					_ = tcpTCP.CloseWrite()
				}
				<-tcpToWS
				return
			}
			log.Printf("[DEBUG] VNC proxy: WebSocket read error: %v", err)
			return
		}
		if msgType != websocket.MessageBinary {
			wsMux.Lock()
			_ = wsConn.Close(websocket.StatusUnsupportedData, "binary frames required")
			wsMux.Unlock()
			return
		}
		if len(data) == 0 {
			continue
		}
		if _, err := tcpConn.Write(data); err != nil {
			log.Printf("[DEBUG] VNC proxy: TCP write error: %v", err)
			return
		}
	}
}

func (s *Server) withAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authorized(r) {
			writeJSON(w, http.StatusUnauthorized, protocol.ErrorEnvelope{Type: "error", Code: "unauthorized", Message: "authentication failed"})
			return
		}
		next(w, r)
	}
}

func (s *Server) authorized(r *http.Request) bool {
	header := r.Header.Get("Authorization")
	if header == "" || !strings.HasPrefix(header, "Bearer ") {
		return false
	}
	return s.auth != nil && s.authSession(strings.TrimPrefix(header, "Bearer "))
}

func (s *Server) authSession(token string) bool {
	return token != "" && s.auth != nil && s.authSessionsVerify(token)
}

func (s *Server) authSessionsVerify(token string) bool {
	return s.auth != nil && s.auth.Verify(token)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func wsWriteJSON(ctx context.Context, conn *websocket.Conn, v any) error {
	return conn.Write(ctx, websocket.MessageText, mustJSON(v))
}

func wsReadJSON(ctx context.Context, conn *websocket.Conn, v any) error {
	_, data, err := conn.Read(ctx)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func mapToStruct(src map[string]any, dest any) error {
	data, err := json.Marshal(src)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, dest)
}

func mustJSON(v any) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return data
}

func SaveUpload(file multipart.File, out string) error {
	target, err := os.Create(out)
	if err != nil {
		return err
	}
	defer target.Close()
	_, err = io.Copy(target, file)
	return err
}
