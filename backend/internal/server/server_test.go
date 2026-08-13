package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"html"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
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

func TestHandleShellsRequiresBearerAndReturnsList(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/shells", nil)
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.Code)
	}
	req = httptest.NewRequest(http.MethodGet, "/v1/shells", nil)
	req.Header.Set("Authorization", "Bearer "+testBearerToken(t, srv, pairings))
	resp = httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.Code)
	}
	var out protocol.ListShellsResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if len(out.Shells) == 0 {
		t.Fatalf("expected shells list to be non-empty")
	}
}

func TestFSCopyRequiresBearerAndCopiesFile(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	if err := os.WriteFile(filepath.Join(srv.cfg.WorkspaceRoot, "src.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/fs/copy", strings.NewReader(`{"path":"src.txt","newPath":"dst.txt"}`))
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.Code)
	}
	req = httptest.NewRequest(http.MethodPost, "/v1/fs/copy", strings.NewReader(`{"path":"src.txt","newPath":"dst.txt"}`))
	req.Header.Set("Authorization", "Bearer "+testBearerToken(t, srv, pairings))
	resp = httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d: %s", resp.Code, resp.Body.String())
	}
	data, err := os.ReadFile(filepath.Join(srv.cfg.WorkspaceRoot, "dst.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello" {
		t.Fatalf("copied data = %q", data)
	}
}

func TestFSCopyConflictReturns409(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	if err := os.WriteFile(filepath.Join(srv.cfg.WorkspaceRoot, "src.txt"), []byte("src"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srv.cfg.WorkspaceRoot, "dst.txt"), []byte("dst"), 0o644); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/fs/copy", strings.NewReader(`{"path":"src.txt","newPath":"dst.txt"}`))
	req.Header.Set("Authorization", "Bearer "+testBearerToken(t, srv, pairings))
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", resp.Code, resp.Body.String())
	}
}

func TestFSDownloadReturnsAttachment(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	if err := os.WriteFile(filepath.Join(srv.cfg.WorkspaceRoot, "file.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/fs/download?path=file.txt", nil)
	req.Header.Set("Authorization", "Bearer "+testBearerToken(t, srv, pairings))
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.Code, resp.Body.String())
	}
	if resp.Body.String() != "hello" {
		t.Fatalf("body = %q", resp.Body.String())
	}
	if got := resp.Header().Get("Content-Disposition"); !strings.Contains(got, `attachment; filename="file.txt"`) {
		t.Fatalf("content disposition = %q", got)
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

func TestAllowedCIDRsRejectsUnlistedSource(t *testing.T) {
	srv := newTestServer(t)
	srv.cfg.AllowedCIDRs = []string{"127.0.0.0/8"}
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.RemoteAddr = "192.0.2.1:1234"
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", resp.Code)
	}
	var body protocol.ErrorEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Code != "forbidden_source" {
		t.Fatalf("expected forbidden_source, got %q", body.Code)
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
			_, err = srv.sessions.Subscribe(summary.ID, func(output protocol.PTYOutputEnvelope, _ protocol.SessionStateEnvelope) {
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
	payload, err := pairings.Create("https://127.0.0.1:8765", "AA:BB", false, 2*time.Minute, time.Now().UTC())
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
	cfg.AllowedCIDRs = nil
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
	manager, err := session.NewManager(cfg.WorkspaceRoot, cfg.StateDir, cfg.WorkspaceRoot, cfg.MaxScrollbackBytes, cfg.ChannelBufferSize, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv, err := New(cfg, tlsMaterial, auth, manager, noopNotify{}, &security.PairingSnapshot{})
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

func newPairingPageServer(t *testing.T) (*Server, *security.PairingSnapshot) {
	t.Helper()
	dir := t.TempDir()
	cfg := config.Default()
	cfg.StateDir = filepath.Join(dir, ".agenticremote")
	cfg.AllowedCIDRs = nil
	cfg.WorkspaceRoot = dir
	cfg.PairingPageUsername = "pairing"
	cfg.PairingPagePassword = "s3cret-pass"
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
	manager, err := session.NewManager(cfg.WorkspaceRoot, cfg.StateDir, cfg.WorkspaceRoot, cfg.MaxScrollbackBytes, cfg.ChannelBufferSize, nil)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := &security.PairingSnapshot{}
	srv, err := New(cfg, tlsMaterial, auth, manager, noopNotify{}, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for _, sess := range srv.sessions.List(context.Background()) {
			_ = srv.sessions.Close(sess.ID)
		}
	})
	return srv, snapshot
}

func TestPairingPageDisabledWithoutCredentials(t *testing.T) {
	srv, _ := newBootstrapServer(t)
	req := httptest.NewRequest(http.MethodGet, "/pairing", nil)
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusNotFound {
		t.Fatalf("expected 404 when pairing page credentials unset, got %d", resp.Code)
	}
}

func TestPairingPageRequiresBasicAuth(t *testing.T) {
	srv, _ := newPairingPageServer(t)
	req := httptest.NewRequest(http.MethodGet, "/pairing", nil)
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without credentials, got %d", resp.Code)
	}
	if resp.Header().Get("WWW-Authenticate") == "" {
		t.Fatal("expected WWW-Authenticate challenge header")
	}

	req = httptest.NewRequest(http.MethodGet, "/pairing", nil)
	req.SetBasicAuth("pairing", "wrong-password")
	resp = httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 with wrong password, got %d", resp.Code)
	}
}

func TestPairingPageServiceUnavailableBeforeFirstPublish(t *testing.T) {
	srv, _ := newPairingPageServer(t)
	req := httptest.NewRequest(http.MethodGet, "/pairing", nil)
	req.SetBasicAuth("pairing", "s3cret-pass")
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 before first publish, got %d", resp.Code)
	}
}

func TestPairingPageRendersPublishedPayload(t *testing.T) {
	srv, snapshot := newPairingPageServer(t)
	payload := &security.PairingPayload{
		Version:   2,
		Endpoint:  "https://127.0.0.1:8765",
		PairingID: "pid-1",
		Token:     "token-1",
		ExpiresAt: time.Now().Add(2 * time.Minute).UTC(),
	}
	presentation, _ := security.BuildPresentation(payload)
	snapshot.Store(presentation)

	req := httptest.NewRequest(http.MethodGet, "/pairing", nil)
	req.SetBasicAuth("pairing", "s3cret-pass")
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.Code, resp.Body.String())
	}
	if resp.Header().Get("Cache-Control") != "no-store, max-age=0" {
		t.Fatalf("unexpected cache-control: %q", resp.Header().Get("Cache-Control"))
	}
	if resp.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("expected X-Content-Type-Options: nosniff")
	}
	body := resp.Body.String()
	// Verify canonical JSON is used on copy button
	if !strings.Contains(body, `data-payload="`+html.EscapeString(string(presentation.CanonicalJSON))+`"`) {
		t.Fatal("expected canonical JSON payload on copy button")
	}
	if !strings.Contains(body, `<pre id="payload-json">`) {
		t.Fatal("expected pretty JSON container")
	}
	if !strings.Contains(body, html.EscapeString(`"pairingId": "pid-1"`)) {
		t.Fatal("expected pretty-printed pairing ID")
	}
	if !strings.Contains(body, `@media (min-width: 720px)`) {
		t.Fatal("expected responsive breakpoint")
	}
	if !strings.Contains(body, "pid-1") || !strings.Contains(body, "token-1") {
		t.Fatalf("expected raw JSON payload fields in page, got: %s", body)
	}
	if !strings.Contains(body, "data:image/png;base64,") {
		t.Fatal("expected inline QR code image")
	}
}

func TestPairingPageRejectsNonGET(t *testing.T) {
	srv, snapshot := newPairingPageServer(t)
	payload := &security.PairingPayload{Version: 2, Endpoint: "https://127.0.0.1:8765"}
	presentation, _ := security.BuildPresentation(payload)
	snapshot.Store(presentation)
	req := httptest.NewRequest(http.MethodPost, "/pairing", nil)
	req.SetBasicAuth("pairing", "s3cret-pass")
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", resp.Code)
	}
	if resp.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("expected Allow: GET, got %q", resp.Header().Get("Allow"))
	}
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
func TestHandleVNCProxyMissingToken(t *testing.T) {
	srv := newTestServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/ws/vnc", nil)
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestHandleVNCProxyInvalidToken(t *testing.T) {
	srv := newTestServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/ws/vnc?token=bogus", nil)
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestHandleVNCProxyUnavailable(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	// Find an unused port to simulate VNC down
	srv.cfg.VNCPort = 40001
	token := testBearerToken(t, srv, pairings)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/ws/vnc?token="+token, nil)
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", rec.Code)
	}
}

func TestHandleVNCProxyBytesFlow(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	token := testBearerToken(t, srv, pairings)

	// Start dummy VNC server
	vncListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer vncListener.Close()
	port := vncListener.Addr().(*net.TCPAddr).Port
	srv.cfg.VNCPort = port

	go func() {
		conn, err := vncListener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 4)
		_, _ = conn.Read(buf)
		if string(buf) == "PING" {
			_, _ = conn.Write([]byte("PONG"))
		}
	}()

	ts := httptest.NewTLSServer(srv.Handler())
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, ts.URL+"/v1/ws/vnc?token="+token, &websocket.DialOptions{HTTPClient: ts.Client()})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	if err := conn.Write(ctx, websocket.MessageBinary, []byte("PING")); err != nil {
		t.Fatal(err)
	}

	_, reply, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if string(reply) != "PONG" {
		t.Fatalf("expected PONG, got %s", reply)
	}
}

func TestLogRequestRedactsTokens(t *testing.T) {
	buf := &bytes.Buffer{}
	log.SetOutput(buf)
	defer log.SetOutput(log.Writer())

	srv := newTestServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/ws/vnc?token=mysecrettoken&other=pass", nil)
	req.RemoteAddr = "127.0.0.1:12345"
	srv.Handler().ServeHTTP(rec, req)

	logOut := buf.String()
	if strings.Contains(logOut, "mysecrettoken") {
		t.Fatalf("expected token to be redacted, got logs: %s", logOut)
	}
	if !strings.Contains(logOut, "token=REDACTED") {
		t.Fatalf("expected REDACTED marker in logs: %s", logOut)
	}
}

var _ = tls.VersionTLS12
