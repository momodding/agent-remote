package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"io"
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
	runtimestore "github.com/agenticremote/agenticremote/backend/internal/runtime"
	"github.com/agenticremote/agenticremote/backend/internal/security"
	"github.com/agenticremote/agenticremote/backend/internal/session"
	"github.com/coder/websocket"
)

type noopNotify struct{}

func (noopNotify) RegisterToken(context.Context, protocol.NotifyRegisterRequest) error { return nil }

type replayOverflowAgents struct{}

func (replayOverflowAgents) CreateAgentRequest(context.Context, protocol.CreateSessionRequest) (*protocol.AgentSession, error) {
	return nil, nil
}
func (replayOverflowAgents) GetAgent(string) (*protocol.AgentSession, error) { return nil, nil }
func (replayOverflowAgents) ListAgents() []protocol.AgentSession             { return nil }
func (replayOverflowAgents) SubmitPrompt(string, string) error               { return nil }
func (replayOverflowAgents) Abort(string) error                              { return nil }
func (replayOverflowAgents) Subscribe(_ string, fn func(protocol.AgentEvent)) (func(), error) {
	for i := range maxReplayLiveEvents + 1 {
		fn(protocol.AgentEvent{Type: "state", Cursor: int64(i + 1), State: "working"})
	}
	return func() {}, nil
}

type recordingAgents struct {
	replayOverflowAgents
	req protocol.CreateSessionRequest
}

func (a *recordingAgents) CreateAgentRequest(_ context.Context, req protocol.CreateSessionRequest) (*protocol.AgentSession, error) {
	a.req = req
	return &protocol.AgentSession{}, nil
}

type silentAgents struct{ replayOverflowAgents }

func (silentAgents) Subscribe(_ string, _ func(protocol.AgentEvent)) (func(), error) {
	return func() {}, nil
}

type replayOverflowRuntime struct {
	events     []runtimestore.Event
	ready      chan struct{}
	release    chan struct{}
	subscriber func(runtimestore.Event)
}

func (r *replayOverflowRuntime) RuntimeSnapshot() (*runtimestore.Snapshot, error) {
	return &runtimestore.Snapshot{Cursor: int64(len(r.events))}, nil
}
func (r *replayOverflowRuntime) RuntimeEvents(after int64, _ int) ([]runtimestore.Event, int64, error) {
	<-r.release
	if after != 0 {
		return nil, after, nil
	}
	return r.events, int64(len(r.events)), nil
}
func (r *replayOverflowRuntime) SubscribeRuntime(fn func(runtimestore.Event)) func() {
	r.subscriber = fn
	close(r.ready)
	return func() {}
}

type watcherOverflowRuntime struct {
	ready    chan struct{}
	overflow func()
}

func (w *watcherOverflowRuntime) RuntimeSnapshot() (*runtimestore.Snapshot, error) {
	return &runtimestore.Snapshot{Cursor: 0}, nil
}

func (w *watcherOverflowRuntime) RuntimeEvents(after int64, _ int) ([]runtimestore.Event, int64, error) {
	return nil, after, nil
}

func (w *watcherOverflowRuntime) SubscribeRuntime(fn func(runtimestore.Event)) func() {
	return func() {}
}

func (w *watcherOverflowRuntime) SubscribeRuntimeWithOverflow(fn func(runtimestore.Event), onOverflow func()) func() {
	w.overflow = onOverflow
	close(w.ready)
	return func() {}
}

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

func TestRuntimeSnapshotAndEventsRequireBearer(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	for _, path := range []string{"/v1/runtime/snapshot", "/v1/runtime/events?after=0&limit=1"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		resp := httptest.NewRecorder()
		srv.Handler().ServeHTTP(resp, req)
		if resp.Code != http.StatusUnauthorized {
			t.Fatalf("%s: expected 401, got %d", path, resp.Code)
		}
		req.Header.Set("Authorization", "Bearer "+testBearerToken(t, srv, pairings))
		resp = httptest.NewRecorder()
		srv.Handler().ServeHTTP(resp, req)
		if resp.Code != http.StatusOK {
			t.Fatalf("%s: expected 200, got %d: %s", path, resp.Code, resp.Body.String())
		}
	}
}

func TestRuntimeEventsExposeCreatedSession(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	summary, err := srv.sessions.Create(context.Background(), protocol.CreateSessionRequest{Name: "runtime", Command: "sh", Args: []string{"-c", "true"}})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/runtime/events?after=0&limit=100", nil)
	req.Header.Set("Authorization", "Bearer "+testBearerToken(t, srv, pairings))
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.Code, resp.Body.String())
	}
	var body struct {
		Events []runtimestore.Event `json:"events"`
		Cursor int64                `json:"cursor"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Cursor == 0 || len(body.Events) == 0 || body.Events[0].SurfaceID != summary.ID || body.Events[0].Kind != "terminal.created" {
		t.Fatalf("unexpected replay: %+v", body)
	}
}

func TestRuntimeWSReplaysEventsBeforeChannelOpened(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	if _, err := srv.sessions.Create(context.Background(), protocol.CreateSessionRequest{Name: "runtime", Command: "sh", Args: []string{"-c", "sleep 1"}}); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewTLSServer(srv.Handler())
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, ts.URL+"/v1/ws/runtime", &websocket.DialOptions{HTTPClient: ts.Client()})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	if err := wsWriteJSON(ctx, conn, protocol.AuthToken{Type: "auth.token", Token: testBearerToken(t, srv, pairings)}); err != nil {
		t.Fatal(err)
	}
	if err := wsWriteJSON(ctx, conn, protocol.ChannelOpenEnvelope{Type: "channel.open", RequestID: "request", ChannelID: "runtime", Kind: "runtime", TargetID: "runtime", After: 0}); err != nil {
		t.Fatal(err)
	}
	var frames []string
	for {
		var frame map[string]any
		if err := wsReadJSON(ctx, conn, &frame); err != nil {
			t.Fatal(err)
		}
		frames = append(frames, frame["type"].(string))
		if frame["type"] == "channel.opened" {
			break
		}
	}
	if len(frames) < 2 || frames[0] != "event" || frames[len(frames)-1] != "channel.opened" {
		t.Fatalf("runtime replay order = %v", frames)
	}
}

func TestRuntimeWSReplayHandoffAndReconnect(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	store := srv.runtime.(*session.Manager).RuntimeStore()
	first, err := store.RecordEvent("test", "test.first", map[string]string{"value": "first"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.RecordEvent("test", "test.second", map[string]string{"value": "second"})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewTLSServer(srv.Handler())
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	token := testBearerToken(t, srv, pairings)

	open := func(after int64) *websocket.Conn {
		conn, _, err := websocket.Dial(ctx, ts.URL+"/v1/ws/runtime", &websocket.DialOptions{HTTPClient: ts.Client()})
		if err != nil {
			t.Fatal(err)
		}
		if err := wsWriteJSON(ctx, conn, protocol.AuthToken{Type: "auth.token", Token: token}); err != nil {
			t.Fatal(err)
		}
		if err := wsWriteJSON(ctx, conn, protocol.ChannelOpenEnvelope{Type: "channel.open", RequestID: "request", ChannelID: "runtime", Kind: "runtime", TargetID: "runtime", After: after}); err != nil {
			t.Fatal(err)
		}
		return conn
	}
	readUntilOpened := func(conn *websocket.Conn) ([]int64, int64) {
		var cursors []int64
		for {
			var frame struct {
				Type   string `json:"type"`
				Cursor int64  `json:"cursor"`
			}
			if err := wsReadJSON(ctx, conn, &frame); err != nil {
				t.Fatal(err)
			}
			switch frame.Type {
			case "event":
				cursors = append(cursors, frame.Cursor)
			case "channel.opened":
				return cursors, frame.Cursor
			default:
				t.Fatalf("unexpected runtime frame: %+v", frame)
			}
		}
	}
	readEvent := func(conn *websocket.Conn) int64 {
		var frame struct {
			Type   string `json:"type"`
			Cursor int64  `json:"cursor"`
		}
		if err := wsReadJSON(ctx, conn, &frame); err != nil {
			t.Fatal(err)
		}
		if frame.Type != "event" {
			t.Fatalf("expected runtime event, got %+v", frame)
		}
		return frame.Cursor
	}

	conn := open(0)
	cursors, opened := readUntilOpened(conn)
	if fmt.Sprint(cursors) != fmt.Sprint([]int64{first, second}) || opened != second {
		t.Fatalf("initial replay = cursors %v opened %d", cursors, opened)
	}
	third, err := store.RecordEvent("test", "test.third", map[string]string{"value": "third"})
	if err != nil {
		t.Fatal(err)
	}
	if got := readEvent(conn); got != third {
		t.Fatalf("live handoff cursor = %d, want %d", got, third)
	}
	if err := conn.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatal(err)
	}

	conn = open(second)
	defer conn.Close(websocket.StatusNormalClosure, "")
	cursors, opened = readUntilOpened(conn)
	if fmt.Sprint(cursors) != fmt.Sprint([]int64{third}) || opened != third {
		t.Fatalf("reconnect replay = cursors %v opened %d", cursors, opened)
	}
	fourth, err := store.RecordEvent("test", "test.fourth", map[string]string{"value": "fourth"})
	if err != nil {
		t.Fatal(err)
	}
	if got := readEvent(conn); got != fourth {
		t.Fatalf("reconnected live cursor = %d, want %d", got, fourth)
	}
}

func TestAgentWSClosesOverflowedReplayForResync(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	srv.agents = replayOverflowAgents{}
	if _, err := srv.runtime.(*session.Manager).RuntimeStore().RecordEvent("agent-1", "state", protocol.AgentEvent{Type: "state", AgentID: "agent-1", State: "working"}); err != nil {
		t.Fatal(err)
	}
	assertReplayResync(t, srv, pairings, protocol.ChannelOpenEnvelope{Type: "channel.open", RequestID: "request", ChannelID: "agent-1", Kind: "agent", TargetID: "agent-1"})
}

func TestRuntimeWSClosesOverflowedReplayForResync(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	runtime := &replayOverflowRuntime{ready: make(chan struct{}), release: make(chan struct{})}
	for i := 1; i <= 500; i++ {
		runtime.events = append(runtime.events, runtimestore.Event{Cursor: int64(i), SurfaceID: "test", Kind: "test.event"})
	}
	srv.runtime = runtime
	ts := httptest.NewTLSServer(srv.Handler())
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, ts.URL+"/v1/ws/runtime", &websocket.DialOptions{HTTPClient: ts.Client()})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	if err := wsWriteJSON(ctx, conn, protocol.AuthToken{Type: "auth.token", Token: testBearerToken(t, srv, pairings)}); err != nil {
		t.Fatal(err)
	}
	if err := wsWriteJSON(ctx, conn, protocol.ChannelOpenEnvelope{Type: "channel.open", RequestID: "request", ChannelID: "runtime", Kind: "runtime", TargetID: "runtime"}); err != nil {
		t.Fatal(err)
	}
	<-runtime.ready
	for i := 0; i <= maxReplayLiveEvents; i++ {
		runtime.subscriber(runtimestore.Event{Cursor: int64(501 + i)})
	}
	close(runtime.release)
	assertChannelResync(t, ctx, conn)
}

func TestRuntimeWSClosesOverflowedWatcherForResync(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	runtime := &watcherOverflowRuntime{ready: make(chan struct{})}
	srv.runtime = runtime
	ts := httptest.NewTLSServer(srv.Handler())
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, ts.URL+"/v1/ws/runtime", &websocket.DialOptions{HTTPClient: ts.Client()})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	if err := wsWriteJSON(ctx, conn, protocol.AuthToken{Type: "auth.token", Token: testBearerToken(t, srv, pairings)}); err != nil {
		t.Fatal(err)
	}
	if err := wsWriteJSON(ctx, conn, protocol.ChannelOpenEnvelope{Type: "channel.open", RequestID: "request", ChannelID: "runtime", Kind: "runtime", TargetID: "runtime"}); err != nil {
		t.Fatal(err)
	}
	<-runtime.ready
	var opened protocol.ChannelOpenedEnvelope
	if err := wsReadJSON(ctx, conn, &opened); err != nil {
		t.Fatal(err)
	}
	if opened.Type != "channel.opened" {
		t.Fatalf("unexpected envelope: %+v", opened)
	}
	runtime.overflow()
	assertChannelResync(t, ctx, conn)
}

func assertReplayResync(t *testing.T, srv *Server, pairings *security.PairingStore, open protocol.ChannelOpenEnvelope) {
	t.Helper()
	ts := httptest.NewTLSServer(srv.Handler())
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, ts.URL+"/v1/ws/runtime", &websocket.DialOptions{HTTPClient: ts.Client()})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	if err := wsWriteJSON(ctx, conn, protocol.AuthToken{Type: "auth.token", Token: testBearerToken(t, srv, pairings)}); err != nil {
		t.Fatal(err)
	}
	if err := wsWriteJSON(ctx, conn, open); err != nil {
		t.Fatal(err)
	}
	assertChannelResync(t, ctx, conn)
}

func assertChannelResync(t *testing.T, ctx context.Context, conn *websocket.Conn) {
	t.Helper()
	for {
		var frame protocol.ChannelClosedEnvelope
		if err := wsReadJSON(ctx, conn, &frame); err != nil {
			t.Fatal(err)
		}
		if frame.Type == "channel.closed" {
			if frame.Reason != "resync_required" {
				t.Fatalf("close reason = %q", frame.Reason)
			}
			return
		}
	}
}
func TestAgentWSReplaysPersistedStateEvent(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	srv.agents = silentAgents{}
	if _, err := srv.runtime.(*session.Manager).RuntimeStore().RecordEvent("agent-1", "state", protocol.AgentEvent{Type: "state", AgentID: "agent-1", State: "working"}); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewTLSServer(srv.Handler())
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, ts.URL+"/v1/ws/runtime", &websocket.DialOptions{HTTPClient: ts.Client()})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	if err := wsWriteJSON(ctx, conn, protocol.AuthToken{Type: "auth.token", Token: testBearerToken(t, srv, pairings)}); err != nil {
		t.Fatal(err)
	}
	if err := wsWriteJSON(ctx, conn, protocol.ChannelOpenEnvelope{Type: "channel.open", RequestID: "request", ChannelID: "agent-1", Kind: "agent", TargetID: "agent-1"}); err != nil {
		t.Fatal(err)
	}
	var frame struct {
		Type  string              `json:"type"`
		Event protocol.AgentEvent `json:"event"`
	}
	if err := wsReadJSON(ctx, conn, &frame); err != nil {
		t.Fatal(err)
	}
	if frame.Type != "event" || frame.Event.Type != "state" || frame.Event.State != "working" || frame.Event.AgentID != "agent-1" {
		t.Fatalf("replayed frame = %+v", frame)
	}
}

func TestDaemonIdentityRequiresBearerAndReturnsCapabilities(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/daemon/identity", nil)
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.Code)
	}
	req.Header.Set("Authorization", "Bearer "+testBearerToken(t, srv, pairings))
	resp = httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.Code, resp.Body.String())
	}
	var result protocol.DaemonCapabilities
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.Identity.HostID != srv.tls.Fingerprint || result.Identity.ConnectionID != srv.tls.Fingerprint {
		t.Fatalf("unexpected identity: %#v", result.Identity)
	}
	if len(result.Capabilities) != 3 || result.Capabilities[0].Name != "sessions" || !result.Capabilities[0].Enabled || result.Capabilities[1].Name != "files" || !result.Capabilities[1].Enabled || result.Capabilities[2].Name != "vnc" {
		t.Fatalf("unexpected capabilities: %#v", result.Capabilities)
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
	t.Cleanup(func() { _ = manager.Shutdown() })
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
	t.Cleanup(func() { _ = manager.Shutdown() })
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

func TestHandleVNCProxyHalfClosesUpstreamOnClientClose(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	token := testBearerToken(t, srv, pairings)
	vncListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer vncListener.Close()
	srv.cfg.VNCPort = vncListener.Addr().(*net.TCPAddr).Port

	received := make(chan string, 1)
	go func() {
		conn, err := vncListener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 4)
		if _, err := io.ReadFull(conn, buf); err != nil {
			received <- "read error: " + err.Error()
			return
		}
		one := make([]byte, 1)
		if _, err := conn.Read(one); err != io.EOF {
			received <- fmt.Sprintf("expected EOF, got %v", err)
			return
		}
		received <- string(buf)
	}()

	ts := httptest.NewTLSServer(srv.Handler())
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, ts.URL+"/v1/ws/vnc?token="+token, &websocket.DialOptions{HTTPClient: ts.Client()})
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.Write(ctx, websocket.MessageBinary, []byte("PING")); err != nil {
		t.Fatal(err)
	}
	if err := conn.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatal(err)
	}
	if got := <-received; got != "PING" {
		t.Fatalf("upstream did not receive payload followed by EOF: %s", got)
	}
}

func TestHandleVNCProxyCleanCloseOnUpstreamClose(t *testing.T) {
	srv, pairings := newBootstrapServer(t)
	token := testBearerToken(t, srv, pairings)

	vncListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer vncListener.Close()
	srv.cfg.VNCPort = vncListener.Addr().(*net.TCPAddr).Port

	go func() {
		conn, err := vncListener.Accept()
		if err != nil {
			return
		}
		conn.Close() // simulate the VNC server ending the session
	}()

	ts := httptest.NewTLSServer(srv.Handler())
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, ts.URL+"/v1/ws/vnc?token="+token, &websocket.DialOptions{HTTPClient: ts.Client()})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()

	_, _, err = conn.Read(ctx)
	code := websocket.CloseStatus(err)
	if code != websocket.StatusNormalClosure {
		t.Fatalf("expected clean close (%d), got code=%d err=%v", websocket.StatusNormalClosure, code, err)
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

func TestAgentReplayAllowsThinkingEvents(t *testing.T) {
	if !isAgentEventKind("message.thinking") {
		t.Fatal("message.thinking must survive Agent replay")
	}
}

func TestRuntimeAgentCreateForwardsBackend(t *testing.T) {
	agents := &recordingAgents{}
	server := &Server{agents: agents}
	server.executeCommand(context.Background(), protocol.CommandEnvelope{Command: "agent.create", Args: map[string]any{"cwd": "/workspace", "name": "Agent", "backend": "tmux"}}, func(any) error { return nil })
	if agents.req.Backend != "tmux" {
		t.Fatalf("backend = %q, want tmux", agents.req.Backend)
	}
}

func TestCreateAgentRESTForwardsBackend(t *testing.T) {
	srv := newTestServer(t)
	agents := &recordingAgents{}
	srv.agents = agents
	req := httptest.NewRequest(http.MethodPost, "/v1/agents", strings.NewReader(`{"cwd":"/workspace","name":"Agent","backend":"tmux"}`))
	resp := httptest.NewRecorder()
	srv.handleAgents(resp, req)
	if resp.Code != http.StatusCreated || agents.req.Backend != "tmux" {
		t.Fatalf("status=%d backend=%q", resp.Code, agents.req.Backend)
	}
}

var _ = tls.VersionTLS12
