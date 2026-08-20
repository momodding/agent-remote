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
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/config"
	fsservice "github.com/agenticremote/agenticremote/backend/internal/fs"
	"github.com/agenticremote/agenticremote/backend/internal/protocol"
	"github.com/agenticremote/agenticremote/backend/internal/security"
	"github.com/agenticremote/agenticremote/backend/internal/session"
	"github.com/coder/websocket"
)

type SessionAPI interface {
	List(context.Context) []protocol.SessionSummary
	Create(context.Context, protocol.CreateSessionRequest) (*protocol.SessionSummary, error)
	Resize(string, int, int) error
	Input(string, []byte) error
	Close(string) error
	Subscribe(string, func(protocol.PTYOutputEnvelope, protocol.SessionStateEnvelope)) (func(), error)
}

type NotifyAPI interface {
	RegisterToken(context.Context, protocol.NotifyRegisterRequest) error
}

type Server struct {
	cfg             config.Config
	fs              *fsservice.Service
	auth            *security.AuthService
	sessions        SessionAPI
	notify          NotifyAPI
	limits          *Limits
	tls             *security.TLSMaterial
	pairingSnapshot *security.PairingSnapshot
}

func New(cfg config.Config, tlsMaterial *security.TLSMaterial, auth *security.AuthService, sessions SessionAPI, notify NotifyAPI, pairingSnapshot *security.PairingSnapshot) (*Server, error) {
	fsSvc, err := fsservice.NewService(cfg.WorkspaceRoot, filepath.Join(cfg.WorkspaceRoot, cfg.UploadDir), cfg.AllowDestructiveFiles)
	if err != nil {
		return nil, err
	}
	return &Server{cfg: cfg, fs: fsSvc, auth: auth, sessions: sessions, notify: notify, limits: NewLimits(cfg.MaxConnections, cfg.MaxSessions), tls: tlsMaterial, pairingSnapshot: pairingSnapshot}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/ping", s.handlePing)
	mux.HandleFunc("/v1/sessions", s.withAuth(s.handleSessions))
	mux.HandleFunc("/v1/shells", s.withAuth(s.handleShells))
	mux.HandleFunc("/v1/sessions/", s.withAuth(s.handleSessionAction))
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
	if s.cfg.PairingPageUsername != "" && s.cfg.PairingPagePassword != "" {
		mux.HandleFunc("/pairing", s.handlePairingPage)
	}
	mux.HandleFunc("/v1/ws/sessions/", s.handleSessionWS)
	mux.HandleFunc("/v1/ws/vnc", s.handleVNCProxy)
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
		if q := logURL.Query(); q.Has("token") {
			q.Set("token", "REDACTED")
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

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.sessions.List(r.Context()))
	case http.MethodPost:
		if !s.limits.TryStartSession() {
			writeJSON(w, http.StatusTooManyRequests, protocol.ErrorEnvelope{Type: "error", Code: "max_sessions", Message: ErrTooManySessions.Error()})
			return
		}
		defer func() {
			if recover() != nil {
				s.limits.EndSession()
			}
		}()
		var req protocol.CreateSessionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, protocol.ErrorEnvelope{Type: "error", Code: "bad_request", Message: err.Error()})
			return
		}
		summary, err := s.sessions.Create(r.Context(), req)
		if err != nil {
			s.limits.EndSession()
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
	if err := s.sessions.Close(id); err != nil {
		writeJSON(w, http.StatusNotFound, protocol.ErrorEnvelope{Type: "error", Code: "session_not_found", Message: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
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
	resp, err := s.fs.ReadText(r.URL.Query().Get("path"))
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

func (s *Server) handleVNCProxy(w http.ResponseWriter, r *http.Request) {
	// 1. Auth via query token (VNC-only)
	token := r.URL.Query().Get("token")
	if token == "" || s.auth == nil || !s.authSession(token) {
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

	// 6. Bridge: concurrent pump loops with half-close semantics
	var wsMux sync.Mutex
	errc := make(chan error, 1)

	// TCP → WebSocket pump (in goroutine)
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := tcpConn.Read(buf)
			if err != nil {
				if err != io.EOF {
					log.Printf("[DEBUG] VNC proxy: TCP read error: %v", err)
				}
				wsMux.Lock()
				wsConn.Close(websocket.StatusNormalClosure, "")
				wsMux.Unlock()
				return
			}
			if n > 0 {
				wsMux.Lock()
				writeErr := wsConn.Write(r.Context(), websocket.MessageBinary, buf[:n])
				wsMux.Unlock()
				if writeErr != nil {
					log.Printf("[DEBUG] VNC proxy: WebSocket write error: %v", writeErr)
					return
				}
			}
		}
	}()

	// WebSocket → TCP pump (foreground)
	for {
		_, data, err := wsConn.Read(r.Context())
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure {
				// Half-close TCP write side to allow remaining data to flush
				if tcpTCP, ok := tcpConn.(*net.TCPConn); ok {
					_ = tcpTCP.CloseWrite()
				}
				// Let TCP→WS loop continue until EOF
				errc <- nil
				return
			}
			log.Printf("[DEBUG] VNC proxy: WebSocket read error: %v", err)
			errc <- err
			return
		}

		if len(data) > 0 {
			_, writeErr := tcpConn.Write(data)
			if writeErr != nil {
				log.Printf("[DEBUG] VNC proxy: TCP write error: %v", writeErr)
				errc <- writeErr
				return
			}
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
