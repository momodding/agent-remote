package agent

import (
	"context"
	"errors"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"strings"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/protocol"
	runtimestore "github.com/agenticremote/agenticremote/backend/internal/runtime"
)

type mockTermMgr struct {
	createdReq  protocol.CreateSessionRequest
	inputs      map[string][][]byte
	closed      map[string]bool
	terminated  map[string]bool
	subscribers map[string]func(protocol.PTYOutputEnvelope, protocol.SessionStateEnvelope)
	sessions    map[string]*protocol.SessionSummary
}

func newMockTermMgr() *mockTermMgr {
	return &mockTermMgr{
		inputs:      make(map[string][][]byte),
		closed:      make(map[string]bool),
		terminated:  make(map[string]bool),
		subscribers: make(map[string]func(protocol.PTYOutputEnvelope, protocol.SessionStateEnvelope)),
		sessions:    make(map[string]*protocol.SessionSummary),
	}
}

func (m *mockTermMgr) Create(_ context.Context, req protocol.CreateSessionRequest) (*protocol.SessionSummary, error) {
	m.createdReq = req
	now := time.Now().UTC()
	summary := &protocol.SessionSummary{
		ID:        "term-123",
		Name:      req.Name,
		Command:   req.Command,
		CWD:       req.CWD,
		State:     "running",
		CreatedAt: now,
		UpdatedAt: now,
	}
	m.sessions[summary.ID] = summary
	return summary, nil
}

func (m *mockTermMgr) List(_ context.Context) []protocol.SessionSummary {
	var list []protocol.SessionSummary
	for _, s := range m.sessions {
		list = append(list, *s)
	}
	return list
}

func (m *mockTermMgr) Input(id string, b []byte) error {
	m.inputs[id] = append(m.inputs[id], b)
	return nil
}
func (m *mockTermMgr) Close(id string) error {
	m.closed[id] = true
	return nil
}

func (m *mockTermMgr) Terminate(_ context.Context, id string) error {
	m.terminated[id] = true
	return nil
}
func (m *mockTermMgr) Subscribe(id string, fn func(protocol.PTYOutputEnvelope, protocol.SessionStateEnvelope)) (func(), error) {
	m.subscribers[id] = fn
	return func() { delete(m.subscribers, id) }, nil
}
func (m *mockTermMgr) ToWorkspaceRelative(p string) string {
	ws := "/workspace"
	if p == ws || p == "" {
		return ""
	}
	if strings.HasPrefix(p, ws+"/") {
		return strings.TrimPrefix(p, ws+"/")
	}
	return p
}

type blockingTermMgr struct {
	*mockTermMgr
	started chan struct{}
	release chan struct{}
}

func (m *blockingTermMgr) Create(ctx context.Context, req protocol.CreateSessionRequest) (*protocol.SessionSummary, error) {
	close(m.started)
	select {
	case <-m.release:
		return m.mockTermMgr.Create(ctx, req)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func TestAgentServiceLifecycleAndPrompt(t *testing.T) {
	stateDir := t.TempDir()
	store, err := runtimestore.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	termMgr := newMockTermMgr()
	svc := NewService(termMgr, store, stateDir)
	defer svc.Close()

	agent, err := svc.CreateAgent(context.Background(), "/workspace", "Test Agent")
	if err != nil {
		t.Fatalf("unexpected error creating agent: %v", err)
	}
	if agent.ID == agent.TerminalSessionID || agent.TerminalSessionID != "term-123" || agent.Adapter != "omp" || agent.State != "idle" {
		t.Fatalf("unexpected agent summary: %+v", agent)
	}
	if len(agent.ID) <= len("agent_") || agent.ID[:len("agent_")] != "agent_" {
		t.Fatalf("agent ID = %q, want stable agent_ prefix", agent.ID)
	}

	// Transcript-only projection must not inject prompts or interrupts.
	if err := svc.SubmitPrompt(agent.ID, "hello world"); err == nil || err.Error() != "needs_terminal" {
		t.Fatalf("expected needs_terminal, got %v", err)
	}
	if err := svc.Abort(agent.ID); err == nil || err.Error() != "needs_terminal" {
		t.Fatalf("expected needs_terminal, got %v", err)
	}
	if len(termMgr.inputs["term-123"]) != 0 {
		t.Fatal("transcript-only service must not write terminal bytes")
	}
}

func TestAgentCreateRequestForwardsBackend(t *testing.T) {
	store, err := runtimestore.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	termMgr := newMockTermMgr()
	svc := NewService(termMgr, store, t.TempDir())
	defer svc.Close()
	if _, err := svc.CreateAgentRequest(context.Background(), protocol.CreateSessionRequest{CWD: "/workspace", Name: "Agent", Backend: "tmux"}); err != nil {
		t.Fatal(err)
	}
	if termMgr.createdReq.Backend != "tmux" {
		t.Fatalf("backend = %q, want tmux", termMgr.createdReq.Backend)
	}
}

func TestRestoredAgentAcceptsPersistedBridgeCredential(t *testing.T) {
	stateDir := t.TempDir()
	store, err := runtimestore.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	first := NewService(newMockTermMgr(), store, stateDir)
	agent, err := first.CreateAgent(context.Background(), "/workspace", "Agent")
	if err != nil {
		t.Fatal(err)
	}
	secret, err := loadBridgeSecret(stateDir, agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	bind, err := net.Dial("unix", first.bridgeServer.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	frame, _ := json.Marshal(BridgeHello{Type: "hello", AgentID: agent.ID, Secret: secret, SessionID: "omp-session", SessionFile: "/sessions/omp.jsonl"})
	if _, err := bind.Write(append(frame, '\n')); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(time.Second); !first.bridgeServer.IsConnected(agent.ID) && time.Now().Before(deadline); {
		time.Sleep(time.Millisecond)
	}
	if !first.bridgeServer.IsConnected(agent.ID) {
		t.Fatal("initial Agent bridge did not bind before restart")
	}
	_ = bind.Close()
	_ = first.Close()

	second := NewService(newMockTermMgr(), store, stateDir)
	defer second.Close()
	conn, err := net.Dial("unix", second.bridgeServer.SocketPath())

	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write(append(frame, '\n')); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(time.Second); !second.bridgeServer.IsConnected(agent.ID) && time.Now().Before(deadline); {
		time.Sleep(time.Millisecond)
	}
	if !second.bridgeServer.IsConnected(agent.ID) {
		t.Fatal("restored Agent rejected its matching persisted bridge identity")
	}
	mismatch, err := net.Dial("unix", second.bridgeServer.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	defer mismatch.Close()
	mismatchFrame, _ := json.Marshal(BridgeHello{Type: "hello", AgentID: agent.ID, Secret: secret, SessionID: "other-session", SessionFile: "/sessions/other.jsonl"})
	if _, err := mismatch.Write(append(mismatchFrame, '\n')); err != nil {
		t.Fatal(err)
	}
	_ = mismatch.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := mismatch.Read(make([]byte, 1)); err == nil {
		t.Fatal("mismatched persisted OMP identity was accepted")
	}
	if !second.bridgeServer.IsConnected(agent.ID) {
		t.Fatal("mismatched reconnect displaced the matching bridge")
	}
	snapshot, err := store.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Agents) != 1 || snapshot.Agents[0].OMPSessionID != "omp-session" || snapshot.Agents[0].OMPSessionFile != "/sessions/omp.jsonl" {
		t.Fatalf("persisted OMP association = %+v", snapshot.Agents)
	}
}
func TestBridgeHelloReplacesFallbackTranscriptTailer(t *testing.T) {
	stateDir := t.TempDir()
	store, err := runtimestore.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	svc := NewService(newMockTermMgr(), store, stateDir)
	defer svc.Close()
	agent, err := svc.CreateAgent(context.Background(), "/workspace", "Agent")
	if err != nil {
		t.Fatal(err)
	}
	svc.mu.RLock()
	inst := svc.agents[agent.ID]
	svc.mu.RUnlock()
	inst.mu.Lock()
	inst.tailer = NewTranscriptTailer(agent.ID, "/sessions/fallback.jsonl", store)
	inst.mu.Unlock()
	if !svc.handleBridgeHello(agent.ID, BridgeHello{SessionID: "omp-session", SessionFile: "/sessions/authoritative.jsonl"}) {
		t.Fatal("bridge hello rejected")
	}
	inst.mu.RLock()
	path := inst.tailer.path
	inst.mu.RUnlock()
	if path != "/sessions/authoritative.jsonl" {
		t.Fatalf("tailer path = %q, want authoritative OMP session file", path)
	}
}

func TestCreateAgentClosesTerminalWhenShutdownWins(t *testing.T) {
	store, err := runtimestore.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	termMgr := &blockingTermMgr{mockTermMgr: newMockTermMgr(), started: make(chan struct{}), release: make(chan struct{})}
	svc := NewService(termMgr, store, t.TempDir())
	result := make(chan error, 1)
	go func() { _, err := svc.CreateAgent(context.Background(), "/workspace", "Agent"); result <- err }()
	<-termMgr.started
	if err := svc.Close(); err != nil {
		t.Fatal(err)
	}
	close(termMgr.release)
	if err := <-result; err == nil || err.Error() != "service closing" {
		t.Fatalf("CreateAgent error = %v", err)
	}
	if !termMgr.terminated["term-123"] {
		t.Fatal("terminal was not terminated after shutdown won")
	}
	if agents := svc.ListAgents(); len(agents) != 0 {
		t.Fatalf("agents = %+v, want none", agents)
	}
}
func TestAgentServiceTranscriptIngestion(t *testing.T) {
	stateDir := t.TempDir()
	store, err := runtimestore.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	// Prepare session directory
	sessionsDir := ComputeDefaultSessionDir(stateDir, "/workspace")
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sessionFile := filepath.Join(sessionsDir, "2026-09-11_01.jsonl")
	if err := os.WriteFile(sessionFile, []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}

	termMgr := newMockTermMgr()
	svc := NewService(termMgr, store, stateDir)
	defer svc.Close()

	agent, err := svc.CreateAgent(context.Background(), "/workspace", "OMP Agent")
	if err != nil {
		t.Fatal(err)
	}

	received := make(chan protocol.AgentEvent, 5)
	unsub, err := svc.Subscribe(agent.ID, func(ev protocol.AgentEvent) {
		received <- ev
	})
	if err != nil {
		t.Fatal(err)
	}
	defer unsub()

	// Append assistant message to session file
	line := `{"type":"message","id":"msg-1","message":{"role":"assistant","content":[{"type":"text","text":"hello human"}]}}` + "\n"
	f, err := os.OpenFile(sessionFile, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(line)
	_ = f.Close()

	// Wait for event to be received by subscriber
	select {
	case ev := <-received:
		if ev.Type != "message.assistant" || ev.Text != "hello human" {
			t.Fatalf("unexpected event: %+v", ev)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for agent event from transcript")
	}

	line = `{"type":"message","id":"msg-2","message":{"role":"user","content":"continue"}}` + "\n"
	f, err = os.OpenFile(sessionFile, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(line)
	_ = f.Close()
	for {
		select {
		case ev := <-received:
			if ev.Type == "state" {
				if ev.State != "working" || ev.EventID == "" {
					t.Fatalf("unexpected state event: %+v", ev)
				}
				return
			}
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for agent state event")
		}
	}
}

func TestAgentServiceTranscriptSameKindCursors(t *testing.T) {
	stateDir := t.TempDir()
	store, err := runtimestore.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	sessionsDir := ComputeDefaultSessionDir(stateDir, "/workspace")
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sessionFile := filepath.Join(sessionsDir, "2026-09-11_01.jsonl")
	if err := os.WriteFile(sessionFile, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	svc := NewService(newMockTermMgr(), store, stateDir)
	defer svc.Close()
	agent, err := svc.CreateAgent(context.Background(), "/workspace", "OMP Agent")
	if err != nil {
		t.Fatal(err)
	}
	received := make(chan protocol.AgentEvent, 2)
	unsub, err := svc.Subscribe(agent.ID, func(ev protocol.AgentEvent) {
		if ev.Type == "message.assistant" {
			received <- ev
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer unsub()
	lines := "{\"type\":\"message\",\"id\":\"msg-1\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"one\"}]}}\n{\"type\":\"message\",\"id\":\"msg-2\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"two\"}]}}\n"
	if err := os.WriteFile(sessionFile, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}
	var first, second protocol.AgentEvent
	for i := 0; i < 2; i++ {
		select {
		case event := <-received:
			if i == 0 {
				first = event
			} else {
				second = event
			}
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for transcript events")
		}
	}
	if first.Cursor == 0 || second.Cursor <= first.Cursor || first.EventID == second.EventID {
		t.Fatalf("unexpected cursors: %+v %+v", first, second)
	}
}

func TestRestoredAgentResumesTranscriptPolling(t *testing.T) {
	stateDir := t.TempDir()
	now := time.Now().UTC()
	store, err := runtimestore.Open(stateDir)
	if err != nil {
	}
	defer func() { _ = store.Close() }()
	if err := store.RecordAgent(runtimestore.AgentSummary{ID: "agent_restored", Adapter: "omp", TerminalSessionID: "term-123", CWD: "/workspace", Capabilities: []byte("[]"), State: "idle", CreatedAt: now, UpdatedAt: now}, "agent.created"); err != nil {
		t.Fatal(err)
	}
	dir := ComputeDefaultSessionDir(stateDir, "/workspace")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "restored.jsonl")
	if err := os.WriteFile(file, []byte(`{"type":"message","id":"old","message":{"role":"assistant","content":"restored"}}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	termMgr := newMockTermMgr()
	termMgr.sessions["term-123"] = &protocol.SessionSummary{ID: "term-123", State: "running"}
	svc := NewService(termMgr, store, stateDir)
	received := make(chan protocol.AgentEvent, 1)
	unsub, err := svc.Subscribe("agent_restored", func(event protocol.AgentEvent) { received <- event })
	if err != nil {
		t.Fatal(err)
	}
	defer unsub()
	select {
	case event := <-received:
		if event.AgentID != "agent_restored" || event.Text != "restored" {
			t.Fatalf("unexpected restored event: %+v", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("restored agent did not resume transcript polling")
	}
	if err := svc.Close(); err != nil {
		t.Fatal(err)
	}
	if len(termMgr.subscribers) != 0 {
		t.Fatal("agent service retained terminal subscription after close")
	}
}

func TestRestoredAgentWithExitedDirectPTYBecomesExited(t *testing.T) {
	stateDir := t.TempDir()
	now := time.Now().UTC()
	store, err := runtimestore.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()

	// Agent was persisted in working state
	if err := store.RecordAgent(runtimestore.AgentSummary{
		ID:                "agent_working",
		Adapter:           "omp",
		TerminalSessionID: "term-pty-1",
		CWD:               "/workspace",
		Capabilities:      []byte("[]"),
		State:             "working",
		CreatedAt:         now,
		UpdatedAt:         now,
	}, "agent.created"); err != nil {
		t.Fatal(err)
	}

	// Terminal session cannot be reattached (e.g. direct PTY marked exited on restore)
	termMgr := newMockTermMgr()
	termMgr.sessions["term-pty-1"] = &protocol.SessionSummary{
		ID:        "term-pty-1",
		Name:      "OMP Terminal",
		Command:   "omp",
		CWD:       "/workspace",
		State:     "exited",
		CreatedAt: now,
		UpdatedAt: now,
	}

	svc := NewService(termMgr, store, stateDir)
	defer svc.Close()

	// In-memory state must be exited
	agent, err := svc.GetAgent("agent_working")
	if err != nil {
		t.Fatalf("GetAgent failed: %v", err)
	}
	if agent.State != "exited" {
		t.Fatalf("agent.State = %q, want %q", agent.State, "exited")
	}

	// Persisted SQLite state must be durably exited
	snap, err := store.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot failed: %v", err)
	}
	var found *runtimestore.AgentSummary
	for _, a := range snap.Agents {
		if a.ID == "agent_working" {
			found = &a
			break
		}
	}
	if found == nil {
		t.Fatal("agent_working not found in SQLite snapshot")
	}
	if found.State != "exited" {
		t.Fatalf("persisted agent state = %q, want %q", found.State, "exited")
	}

	// Verify semantic events recorded
	events, _, err := store.Events(0, 100)
	if err != nil {
		t.Fatalf("Events failed: %v", err)
	}
	var hasAgentUpdated, hasStateEvent bool
	for _, ev := range events {
		if ev.SurfaceID == "agent_working" {
			if ev.Kind == "agent.updated" {
				hasAgentUpdated = true
			}
			if ev.Kind == "state" {
				hasStateEvent = true
			}
		}
	}
	if !hasAgentUpdated {
		t.Fatal("expected agent.updated event for restored exited agent")
	}
	if !hasStateEvent {
		t.Fatal("expected state event for restored exited agent")
	}
}

func TestRestoredAgentWithReattachedTmuxRetainsState(t *testing.T) {
	stateDir := t.TempDir()
	now := time.Now().UTC()
	store, err := runtimestore.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()

	if err := store.RecordAgent(runtimestore.AgentSummary{
		ID:                "agent_tmux",
		Adapter:           "omp",
		TerminalSessionID: "term-tmux-1",
		CWD:               "/workspace",
		Capabilities:      []byte("[]"),
		State:             "working",
		CreatedAt:         now,
		UpdatedAt:         now,
	}, "agent.created"); err != nil {
		t.Fatal(err)
	}

	// Terminal session successfully reattached and is running
	termMgr := newMockTermMgr()
	termMgr.sessions["term-tmux-1"] = &protocol.SessionSummary{
		ID:        "term-tmux-1",
		Name:      "tmux Terminal",
		Command:   "omp",
		CWD:       "/workspace",
		State:     "running",
		CreatedAt: now,
		UpdatedAt: now,
	}

	svc := NewService(termMgr, store, stateDir)
	defer svc.Close()

	agent, err := svc.GetAgent("agent_tmux")
	if err != nil {
		t.Fatalf("GetAgent failed: %v", err)
	}
	if agent.State != "working" {
		t.Fatalf("agent.State = %q, want %q", agent.State, "working")
	}
}

func TestRestoredAgentWithMissingTerminalBecomesExited(t *testing.T) {
	stateDir := t.TempDir()
	now := time.Now().UTC()
	store, err := runtimestore.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()

	if err := store.RecordAgent(runtimestore.AgentSummary{
		ID:                "agent_orphaned",
		Adapter:           "omp",
		TerminalSessionID: "term-missing",
		CWD:               "/workspace",
		Capabilities:      []byte("[]"),
		State:             "idle",
		CreatedAt:         now,
		UpdatedAt:         now,
	}, "agent.created"); err != nil {
		t.Fatal(err)
	}

	termMgr := newMockTermMgr() // term-missing is not present
	svc := NewService(termMgr, store, stateDir)
	defer svc.Close()

	agent, err := svc.GetAgent("agent_orphaned")
	if err != nil {
		t.Fatalf("GetAgent failed: %v", err)
	}
	if agent.State != "exited" {
		t.Fatalf("agent.State = %q, want %q", agent.State, "exited")
	}
}

// Test RAR-045: Restored agent capabilities are fail-closed until bridge reconnects
func TestRestoredAgentCapabilitiesFailClosedUntilBridgeHello(t *testing.T) {
	stateDir := t.TempDir()
	now := time.Now().UTC()
	store, err := runtimestore.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()

	persistedCaps, _ := json.Marshal([]protocol.AgentCapability{
		{Name: "chat", Enabled: true},
		{Name: "prompt", Enabled: true},
		{Name: "abort", Enabled: true},
		{Name: "model", Enabled: true},
		{Name: "thinking", Enabled: true},
	})

	if err := store.RecordAgent(runtimestore.AgentSummary{
		ID:                "agent_restored_caps",
		Adapter:           "omp",
		TerminalSessionID: "term-caps-1",
		OMPSessionID:      "omp-sess-1",
		OMPSessionFile:    filepath.Join(stateDir, "sessions", "omp-sess-1.json"),
		CWD:               "/workspace",
		Capabilities:      persistedCaps,
		State:             "idle",
		CreatedAt:         now,
		UpdatedAt:         now,
	}, "agent.created"); err != nil {
		t.Fatal(err)
	}

	termMgr := newMockTermMgr()
	termMgr.sessions["term-caps-1"] = &protocol.SessionSummary{
		ID:        "term-caps-1",
		Name:      "tmux Terminal",
		Command:   "omp",
		CWD:       "/workspace",
		State:     "running",
		CreatedAt: now,
		UpdatedAt: now,
	}

	svc := NewService(termMgr, store, stateDir)
	defer svc.Close()

	// Immediately after service construction (pre-bridge-hello), capabilities must be fail-closed
	ag, err := svc.GetAgent("agent_restored_caps")
	if err != nil {
		t.Fatalf("GetAgent failed: %v", err)
	}

	checkCap := func(caps []protocol.AgentCapability, name string) bool {
		for _, c := range caps {
			if c.Name == name {
				return c.Enabled
			}
		}
		return false
	}

	if !checkCap(ag.Capabilities, "chat") {
		t.Errorf("expected chat=true, got false")
	}
	for _, name := range []string{"prompt", "abort", "model", "thinking"} {
		if checkCap(ag.Capabilities, name) {
			t.Errorf("pre-hello: expected %s=false, got true", name)
		}
	}

	// Also check that store reflects fail-closed capabilities
	snap, err := store.Snapshot()
	if err != nil {
		t.Fatalf("snapshot failed: %v", err)
	}
	var storedAg *runtimestore.AgentSummary
	for _, a := range snap.Agents {
		if a.ID == "agent_restored_caps" {
			storedAg = &a
			break
		}
	}
	if storedAg == nil {
		t.Fatal("agent not found in store snapshot")
	}
	var storedCaps []protocol.AgentCapability
	_ = json.Unmarshal(storedAg.Capabilities, &storedCaps)
	for _, name := range []string{"prompt", "abort", "model", "thinking"} {
		if checkCap(storedCaps, name) {
			t.Errorf("store snapshot: expected %s=false, got true", name)
		}
	}

	// Now simulate bridge hello
	ok := svc.handleBridgeHello("agent_restored_caps", BridgeHello{
		SessionID:    "omp-sess-1",
		SessionFile:  filepath.Join(stateDir, "sessions", "omp-sess-1.json"),
		Capabilities: []string{"prompt", "abort", "model", "thinking"},
	})
	if !ok {
		t.Fatal("handleBridgeHello returned false")
	}

	agPost, err := svc.GetAgent("agent_restored_caps")
	if err != nil {
		t.Fatalf("GetAgent post-hello failed: %v", err)
	}
	for _, name := range []string{"chat", "prompt", "abort", "model", "thinking"} {
		if !checkCap(agPost.Capabilities, name) {
			t.Errorf("post-hello: expected %s=true, got false", name)
		}
	}
}

func TestAgentSetModelAndThinking(t *testing.T) {
	tmpDir := t.TempDir()
	store, err := runtimestore.Open(tmpDir)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer func() { _ = store.Close() }()

	svc := NewService(newMockTermMgr(), store, tmpDir)
	defer svc.Close()

	agent, err := svc.CreateAgent(context.Background(), tmpDir, "Agent")
	if err != nil {
		t.Fatalf("CreateAgent failed: %v", err)
	}

	if err := svc.SetModel(agent.ID, "gpt-4"); err == nil {
		t.Fatal("expected error when model capability disabled or not connected")
	}
	if err := svc.SetThinking(agent.ID, "high"); err == nil {
		t.Fatal("expected error when thinking capability disabled or not connected")
	}
}

func TestAgentServiceTerminate(t *testing.T) {
	tmpDir := t.TempDir()
	store, err := runtimestore.Open(tmpDir)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer func() { _ = store.Close() }()

	termMgr := newMockTermMgr()
	svc := NewService(termMgr, store, tmpDir)
	defer svc.Close()

	agent, err := svc.CreateAgent(context.Background(), tmpDir, "Agent")
	if err != nil {
		t.Fatalf("CreateAgent failed: %v", err)
	}

	if agent.State != "idle" {
		t.Fatalf("expected state idle, got %s", agent.State)
	}
	if termMgr.closed[agent.TerminalSessionID] {
		t.Fatal("expected terminal not closed yet")
	}
	if termMgr.terminated[agent.TerminalSessionID] {
		t.Fatal("expected terminal not terminated yet")
	}

	// Terminate agent
	if err := svc.Terminate(agent.ID); err != nil {
		t.Fatalf("Terminate failed: %v", err)
	}

	if !termMgr.terminated[agent.TerminalSessionID] {
		t.Fatal("expected terminal terminated on agent termination")
	}
	if termMgr.closed[agent.TerminalSessionID] {
		t.Fatal("expected terminal Close not called on agent termination (only Terminate)")
	}

	ag, err := svc.GetAgent(agent.ID)
	if err != nil {
	}
	if ag.State != "exited" {
		t.Fatalf("expected state exited, got %s", ag.State)
	}

	for _, cap := range ag.Capabilities {
		if cap.Name == "chat" && !cap.Enabled {
			t.Fatal("chat capability should remain enabled")
		}
		if cap.Name != "chat" && cap.Enabled {
			t.Fatalf("capability %s should be disabled", cap.Name)
		}
	}

	// Idempotent terminate
	if err := svc.Terminate(agent.ID); err != nil {
		t.Fatalf("second Terminate failed: %v", err)
	}

	// Non-existent agent
	if err := svc.Terminate("nonexistent"); !errors.Is(err, ErrAgentNotFound) {
		t.Fatalf("expected ErrAgentNotFound, got %v", err)
	}
}

// Test RAR-037-A: handleBridgeSemantic does not mutate state on message events
func TestHandleBridgeSemanticNoStateOnMessage(t *testing.T) {
	svc := &Service{
		agents: make(map[string]*agentInstance),
	}

	inst := &agentInstance{
		meta: protocol.AgentSession{
			ID:    "agent-1",
			State: "idle",
		},
		subscribers: make(map[int]*AgentSubscriber),
		stopPoll:    make(chan struct{}),
	}
	svc.agents["agent-1"] = inst

	frame := BridgeSemanticFrame{
		Event: "message.user",
		Type:  "message",
		Text:  "test message",
	}

	svc.handleBridgeSemantic("agent-1", frame)

	// State should NOT change to "working"
	inst.mu.RLock()
	state := inst.meta.State
	inst.mu.RUnlock()

	if state != "idle" {
		t.Errorf("handleBridgeSemantic should not mutate state, expected idle got %s", state)
	}
}

func TestHandleBridgeSemanticDeliversToSubscribers(t *testing.T) {
	stateDir := t.TempDir()
	store, err := runtimestore.Open(stateDir)
	if err != nil {
		t.Fatalf("failed to open store: %v", err)
	}
	defer func() { _ = store.Close() }()

	now := time.Now().UTC()
	if err := store.RecordAgent(runtimestore.AgentSummary{
		ID:        "agent-sub-1",
		Capabilities: []byte("[]"),
		State:        "idle",
		CreatedAt:    now,
		UpdatedAt:    now,
	}, "agent.created"); err != nil {
		t.Fatalf("failed to record agent: %v", err)
	}

	svc := &Service{
		store:  store,
		agents: make(map[string]*agentInstance),
	}
	inst := &agentInstance{
		meta: protocol.AgentSession{
			ID:    "agent-sub-1",
			State: "idle",
		},
		subscribers: make(map[int]*AgentSubscriber),
		stopPoll:    make(chan struct{}),
	}
	svc.agents["agent-sub-1"] = inst

	received := make(chan protocol.AgentEvent, 5)
	unsub, err := svc.Subscribe("agent-sub-1", func(ev protocol.AgentEvent) {
		received <- ev
	})
	if err != nil {
		t.Fatalf("subscribe failed: %v", err)
	}
	defer unsub()

	frame := BridgeSemanticFrame{
		Event:   "message.assistant",
		EventID: "evt-msg-1",
		Type:    "message",
		Text:    "hello subscriber",
	}
	svc.handleBridgeSemantic("agent-sub-1", frame)

	select {
	case ev := <-received:
		if ev.EventID != "evt-msg-1" {
			t.Fatalf("expected EventID evt-msg-1, got %s", ev.EventID)
		}
		if ev.Text != "hello subscriber" {
			t.Fatalf("expected text 'hello subscriber', got %s", ev.Text)
		}
		if ev.Cursor == 0 {
			t.Fatal("expected non-zero cursor on committed event")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for subscriber event")
	}
}

func TestHandleBridgeSemanticDuplicateDedup(t *testing.T) {
	stateDir := t.TempDir()
	store, err := runtimestore.Open(stateDir)
	if err != nil {
		t.Fatalf("failed to open store: %v", err)
	}
	defer func() { _ = store.Close() }()

	now := time.Now().UTC()
	if err := store.RecordAgent(runtimestore.AgentSummary{
		ID:        "agent-sub-2",
		Capabilities: []byte("[]"),
		State:        "idle",
		CreatedAt:    now,
		UpdatedAt:    now,
	}, "agent.created"); err != nil {
		t.Fatalf("failed to record agent: %v", err)
	}

	svc := &Service{
		store:  store,
		agents: make(map[string]*agentInstance),
	}
	inst := &agentInstance{
		meta: protocol.AgentSession{
			ID:    "agent-sub-2",
			State: "idle",
		},
		subscribers: make(map[int]*AgentSubscriber),
		stopPoll:    make(chan struct{}),
	}
	svc.agents["agent-sub-2"] = inst

	received := make(chan protocol.AgentEvent, 5)
	unsub, err := svc.Subscribe("agent-sub-2", func(ev protocol.AgentEvent) {
		received <- ev
	})
	if err != nil {
		t.Fatalf("subscribe failed: %v", err)
	}
	defer unsub()

	frame := BridgeSemanticFrame{
		Event:   "message.assistant",
		EventID: "evt-msg-dup",
		Type:    "message",
		Text:    "hello once",
	}
	svc.handleBridgeSemantic("agent-sub-2", frame)

	select {
	case ev := <-received:
		if ev.EventID != "evt-msg-dup" {
			t.Fatalf("expected EventID evt-msg-dup, got %s", ev.EventID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for first subscriber event")
	}

	// Duplicate frame with same EventID
	svc.handleBridgeSemantic("agent-sub-2", frame)

	select {
	case ev := <-received:
		t.Fatalf("unexpected duplicate event received: %+v", ev)
	case <-time.After(200 * time.Millisecond):
		// Success: duplicate was deduped
	}
}

// Test RAR-037-B: handleBridgeLifecycle mutates state for lifecycle events only
func TestHandleBridgeLifecycleStateChange(t *testing.T) {
	svc := &Service{
		agents: make(map[string]*agentInstance),
	}

	inst := &agentInstance{
		meta: protocol.AgentSession{
			ID:    "agent-2",
			State: "idle",
		},
		subscribers: make(map[int]*AgentSubscriber),
	}
	svc.agents["agent-2"] = inst

	frame := BridgeLifecycleFrame{
		Event: "agent_start",
	}

	svc.handleBridgeLifecycle("agent-2", frame)

	inst.mu.RLock()
	state := inst.meta.State
	inst.mu.RUnlock()

	if state != "working" {
		t.Errorf("handleBridgeLifecycle should change state to working, got %s", state)
	}
}

// Test RAR-037-C: terminateAgentRuntime kills backend before mutating state
func TestTerminateAgentRuntimeOrderOfOperations(t *testing.T) {
	termMgr := newMockTermMgr()
	svc := &Service{
		agents:  make(map[string]*agentInstance),
		termMgr: termMgr,
	}

	inst := &agentInstance{
		meta: protocol.AgentSession{
			ID:                "agent-3",
			State:             "working",
			TerminalSessionID: "term-3",
		},
		subscribers: make(map[int]*AgentSubscriber),
		stopPoll:    make(chan struct{}),
	}
	svc.agents["agent-3"] = inst

	err := svc.terminateAgentRuntime(context.Background(), inst, "test termination")
	if err != nil {
		t.Errorf("terminateAgentRuntime returned unexpected error: %v", err)
	}

	if !termMgr.terminated["term-3"] {
		t.Error("terminateAgentRuntime should call termMgr.Terminate")
	}

	inst.mu.RLock()
	state := inst.meta.State
	inst.mu.RUnlock()

	if state != "exited" {
		t.Errorf("state should be exited after terminateAgentRuntime, got %s", state)
	}
}

type failingTermMgr struct {
	*mockTermMgr
}

func (f *failingTermMgr) Terminate(_ context.Context, _ string) error {
	return errors.New("backend kill failed")
}

// Test terminateAgentRuntime aborts state change on termMgr error
func TestTerminateAgentRuntimeErrorHandling(t *testing.T) {
	termMgr := &failingTermMgr{mockTermMgr: newMockTermMgr()}
	svc := &Service{
		agents:  make(map[string]*agentInstance),
		termMgr: termMgr,
	}

	inst := &agentInstance{
		meta: protocol.AgentSession{
			ID:                "agent-6",
			State:             "working",
			TerminalSessionID: "term-6",
		},
		subscribers: make(map[int]*AgentSubscriber),
		stopPoll:    make(chan struct{}),
	}

	err := svc.terminateAgentRuntime(context.Background(), inst, "test")
	if err == nil {
		t.Error("terminateAgentRuntime should return error when termMgr fails")
	}

	inst.mu.RLock()
	state := inst.meta.State
	inst.mu.RUnlock()

	if state == "exited" {
		t.Errorf("state should NOT be exited on termMgr error, got %s", state)
	}
}

func TestHandleBridgeHelloModelAndThinking(t *testing.T) {
	stateDir := t.TempDir()
	store, err := runtimestore.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	termMgr := newMockTermMgr()
	svc := NewService(termMgr, store, stateDir)
	defer svc.Close()

	agent, err := svc.CreateAgent(context.Background(), "/workspace", "Test Model Agent")
	if err != nil {
		t.Fatalf("CreateAgent failed: %v", err)
	}

	events := make(chan protocol.AgentEvent, 5)
	unsub, err := svc.Subscribe(agent.ID, func(ev protocol.AgentEvent) {
		if ev.Type == "state" {
			events <- ev
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer unsub()

	sessionFile := filepath.Join(stateDir, "session.jsonl")
	if err := os.WriteFile(sessionFile, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}

	hello := BridgeHello{
		AgentID:     agent.ID,
		Secret:      "test-secret",
		SessionID:   "session-123",
		SessionFile: sessionFile,
		Capabilities: []string{"prompt", "abort", "model", "thinking"},
		Model: &protocol.AgentModelInfo{
			ID:       "claude-3-7-sonnet",
			Name:     "Claude 3.7 Sonnet",
			Provider: "anthropic",
		},
		Thinking: "high",
		AvailableModels: []protocol.AgentModelInfo{
			{ID: "claude-3-7-sonnet", Name: "Claude 3.7 Sonnet", Provider: "anthropic"},
			{ID: "gpt-4o", Name: "GPT-4o", Provider: "openai"},
		},
		AvailableThinking: []string{"off", "low", "medium", "high", "max"},
	}

	svc.handleBridgeHello(agent.ID, hello)

	select {
	case ev := <-events:
		if ev.Model == nil || ev.Model.ID != "claude-3-7-sonnet" {
			t.Fatalf("expected model claude-3-7-sonnet, got %+v", ev.Model)
		}
		if ev.Thinking != "high" {
			t.Fatalf("expected thinking high, got %s", ev.Thinking)
		}
		if len(ev.AvailableModels) != 2 {
			t.Fatalf("expected 2 available models, got %d", len(ev.AvailableModels))
		}
		if len(ev.AvailableThinking) != 5 {
			t.Fatalf("expected 5 available thinking levels, got %d", len(ev.AvailableThinking))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for state event after hello")
	}

	updated, err := svc.GetAgent(agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Model == nil || updated.Model.ID != "claude-3-7-sonnet" {
		t.Fatalf("GetAgent model = %+v", updated.Model)
	}
	if updated.Thinking != "high" {
		t.Fatalf("GetAgent thinking = %s", updated.Thinking)
	}

	// Test disconnect preserves metadata
	svc.handleBridgeDisconnect(agent.ID)

	select {
	case ev := <-events:
		if ev.Model == nil || ev.Model.ID != "claude-3-7-sonnet" {
			t.Fatalf("expected model to be preserved after disconnect, got %+v", ev.Model)
		}
		if ev.Thinking != "high" {
			t.Fatalf("expected thinking to be preserved after disconnect, got %s", ev.Thinking)
		}
		for _, c := range ev.Capabilities {
			if c.Name == "model" && c.Enabled {
				t.Fatal("expected model capability to be disabled on disconnect")
			}
			if c.Name == "thinking" && c.Enabled {
				t.Fatal("expected thinking capability to be disabled on disconnect")
			}
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for state event after disconnect")
	}

	// Test handleBridgeMetadata updates fields
	svc.handleBridgeMetadata(agent.ID, BridgeMetadataFrame{
		Type: "metadata",
		Model: &protocol.AgentModelInfo{
			ID:       "gpt-4o",
			Name:     "GPT-4o",
			Provider: "openai",
		},
		Thinking: "low",
	})

	select {
	case ev := <-events:
		if ev.Model == nil || ev.Model.ID != "gpt-4o" {
			t.Fatalf("expected model gpt-4o after metadata frame, got %+v", ev.Model)
		}
		if ev.Thinking != "low" {
			t.Fatalf("expected thinking low after metadata frame, got %s", ev.Thinking)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for state event after metadata frame")
	}
}
