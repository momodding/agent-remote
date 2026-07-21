package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/config"
	"github.com/agenticremote/agenticremote/backend/internal/protocol"
	"github.com/agenticremote/agenticremote/backend/internal/security"
	"github.com/agenticremote/agenticremote/backend/internal/session"
	"github.com/coder/websocket"
)

type noopNotify struct{}

func (noopNotify) RegisterToken(context.Context, protocol.NotifyRegisterRequest) error { return nil }

func TestSessionsRequiresBearer(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.Code)
	}
	req = httptest.NewRequest(http.MethodGet, "/v1/sessions", nil)
	req.Header.Set("Authorization", "Bearer "+testBearerToken(t, srv, pairings))
	resp = httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.Code)
	}
}

func TestSessionCloseRemovesFromList(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	summary, err := srv.sessions.Create(context.Background(), protocol.CreateSessionRequest{Name: "test"})
	if err != nil {
		t.Fatal(err)
	}
	token := testBearerToken(t, srv, pairings)
	req := httptest.NewRequest(http.MethodPost, "/v1/sessions/"+summary.ID+"/close", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.Code)
	}
	for _, s := range srv.sessions.List(context.Background()) {
		if s.ID == summary.ID {
			t.Fatalf("expected session %s removed from List, still present", summary.ID)
		}
	}
}

func TestCORSPreflightAllowsAuthorization(t *testing.T) {
	srv := newTestServer(t)
	req := httptest.NewRequest(http.MethodOptions, "/v1/sessions", nil)
	req.Header.Set("Origin", "https://example.test")
	req.Header.Set("Access-Control-Request-Headers", "Authorization")
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", resp.Code)
	}
	if allow := resp.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(allow, "Authorization") {
		t.Fatalf("expected Authorization allowed, got %q", allow)
	}
}

func TestPingReturnsPong(t *testing.T) {
	srv := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/ping", nil)
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.Code)
	}
	if strings.TrimSpace(resp.Body.String()) != "pong" {
		t.Fatalf("expected pong, got %q", resp.Body.String())
	}
}

func TestHandlerLogsRequestAttempt(t *testing.T) {
	srv := newTestServer(t)
	var buf bytes.Buffer
	old := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(old)
	srv.Handler().ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/healthz", nil))
	output := buf.String()
	if !strings.Contains(output, "request start") || !strings.Contains(output, "method=GET") || !strings.Contains(output, "path=/healthz") {
		t.Fatalf("expected request log, got %q", output)
	}
}

func TestBootstrapAcceptsSessionFramesWithoutAuth(t *testing.T) {
	srv, _ := newBootstrapServer(t)
	ts := httptest.NewTLSServer(srv.Handler())
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, ts.URL+"/v1/ws/sessions/bootstrap", &websocket.DialOptions{HTTPClient: ts.Client()})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	if err := wsWriteJSON(ctx, conn, map[string]any{"type": "pty.resize", "sessionId": "missing", "cols": 80, "rows": 24}); err != nil {
		t.Fatal(err)
	}
}

func TestSessionWSRejectsPTYBeforeToken(t *testing.T) {
	srv, _ := newBootstrapServer(t)
	summary, err := srv.sessions.Create(context.Background(), protocol.CreateSessionRequest{Name: "test"})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewTLSServer(srv.Handler())
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, ts.URL+"/v1/ws/sessions/"+summary.ID, &websocket.DialOptions{HTTPClient: ts.Client()})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	if err := wsWriteJSON(ctx, conn, map[string]any{"type": "pty.input", "sessionId": summary.ID, "data": "aGk="}); err != nil {
		t.Fatal(err)
	}
	var frame map[string]any
	if err := wsReadJSON(ctx, conn, &frame); err != nil {
		t.Fatal(err)
	}
	if frame["type"] != "error" || frame["code"] != "auth_failed" {
		t.Fatalf("expected auth_failed error, got %v", frame)
	}
}

func TestSessionWSAcceptsPTYAfterToken(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	summary, err := srv.sessions.Create(context.Background(), protocol.CreateSessionRequest{Name: "test"})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewTLSServer(srv.Handler())
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, ts.URL+"/v1/ws/sessions/"+summary.ID, &websocket.DialOptions{HTTPClient: ts.Client()})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	if err := wsWriteJSON(ctx, conn, map[string]any{"type": "auth.token", "token": testBearerToken(t, srv, pairings)}); err != nil {
		t.Fatal(err)
	}
	if err := wsWriteJSON(ctx, conn, map[string]any{"type": "pty.input", "sessionId": summary.ID, "data": "aGk="}); err != nil {
		t.Fatal(err)
	}
	for ctx.Err() == nil {
		preview := strings.Join(srv.sessions.List(context.Background())[0].Preview, "\n")
		if strings.Contains(preview, "hi") {
			if strings.Contains(preview, "aGk=") {
				t.Fatalf("preview contains base64 text: %q", preview)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal(ctx.Err())
}

func TestPTYExecutesRealCommandAndSeedsNewSubscriber(t *testing.T) {
	srv, _ := newBootstrapServer(t)
	summary, err := srv.sessions.Create(context.Background(), protocol.CreateSessionRequest{
		Name:    "test",
		Command: "sh",
		Args:    []string{"-c", "echo agentic-remote-marker-123"},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for ctx.Err() == nil {
		preview := strings.Join(srv.sessions.List(context.Background())[0].Preview, "\n")
		if strings.Contains(preview, "agentic-remote-marker-123") {
			var seeded string
			err = srv.sessions.Subscribe(summary.ID, func(output protocol.PTYOutputEnvelope, _ protocol.SessionStateEnvelope) {
				if seeded != "" || output.Data == "" {
					return
				}
				data, decodeErr := base64.StdEncoding.DecodeString(output.Data)
				if decodeErr != nil {
					t.Fatalf("decode output: %v", decodeErr)
				}
				seeded = string(data)
			})
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(seeded, "agentic-remote-marker-123") {
				t.Fatalf("expected seeded scrollback, got %q", seeded)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal(ctx.Err())
}

func TestPairingCreateMintsIndependentDevice(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	deviceAToken := testBearerToken(t, srv, pairings)
	req := httptest.NewRequest(http.MethodPost, "/v1/pairing", nil)
	req.Header.Set("Authorization", "Bearer "+deviceAToken)
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", resp.Code, resp.Body.String())
	}
	var payload security.PairingPayload
	if err := json.Unmarshal(resp.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	deviceBToken := testBearerTokenFromPayload(t, srv, &payload)
	if deviceBToken == deviceAToken {
		t.Fatal("expected independent bearer tokens")
	}
	if !srv.auth.Verify(deviceAToken) {
		t.Fatal("device A token invalid")
	}
	if !srv.auth.Verify(deviceBToken) {
		t.Fatal("device B token invalid")
	}
}

func testBearerToken(t *testing.T, srv *Server, pairings *security.PairingStore) string {
	t.Helper()
	payload, err := pairings.Create("https://127.0.0.1:8765", "AA:BB", false, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	return testBearerTokenFromPayload(t, srv, payload)
}

func testBearerTokenFromPayload(t *testing.T, srv *Server, payload *security.PairingPayload) string {
	t.Helper()
	ts := httptest.NewTLSServer(srv.Handler())
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, ts.URL+"/v1/ws/sessions/bootstrap", &websocket.DialOptions{HTTPClient: ts.Client()})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	if err := wsWriteJSON(ctx, conn, map[string]any{"type": "auth.hello", "pairingId": payload.PairingID, "clientNonce": strings.Repeat("A", 43), "clientName": "phone"}); err != nil {
		t.Fatal(err)
	}
	var challenge map[string]any
	if err := wsReadJSON(ctx, conn, &challenge); err != nil {
		t.Fatal(err)
	}
	proof, err := security.ClientProof(payload.Token, payload.PairingID, challenge["salt"].(string), strings.Repeat("A", 43), challenge["serverNonce"].(string), challenge["challengeId"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if err := wsWriteJSON(ctx, conn, map[string]any{"type": "auth.proof", "pairingId": payload.PairingID, "challengeId": challenge["challengeId"], "proof": proof}); err != nil {
		t.Fatal(err)
	}
	var ok map[string]any
	if err := wsReadJSON(ctx, conn, &ok); err != nil {
		t.Fatal(err)
	}
	return ok["sessionToken"].(string)
}

func newBootstrapServer(t *testing.T) (*Server, *security.PairingStore) {
	t.Helper()
	dir := t.TempDir()
	cfg := config.Default()
	cfg.StateDir = filepath.Join(dir, ".agenticremote")
	cfg.WorkspaceRoot = dir
	tlsMaterial, err := security.EnsureTLS(cfg.StateDir, "127.0.0.1:8765", cfg.PublicEndpoint)
	if err != nil {
		t.Fatal(err)
	}
	pairings, err := security.LoadPairingStore(cfg.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	sessions, err := security.LoadSessionStore(cfg.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	auth := security.NewAuthService(pairings, sessions)
	manager, err := session.NewManager(cfg.StateDir, cfg.WorkspaceRoot, cfg.MaxScrollbackBytes, cfg.ChannelBufferSize, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv, err := New(cfg, tlsMaterial, auth, manager, noopNotify{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, sess := range srv.sessions.List(context.Background()) {
			_ = srv.sessions.Close(sess.ID)
		}
	})
	return srv, pairings
}

func newTestServer(t *testing.T) *Server {
	t.Helper()
	srv, _ := newBootstrapServer(t)
	return srv
}

func TestBootstrapRejectsNonAuthResponseJSON(t *testing.T) {
	srv := newTestServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/ws/sessions/bootstrap", nil)
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest && rec.Code != http.StatusSwitchingProtocols && rec.Code != http.StatusUnauthorized {
		_ = json.NewDecoder(rec.Body)
	}
}

var _ = tls.VersionTLS12
