package agent

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/protocol"
	runtimestore "github.com/agenticremote/agenticremote/backend/internal/runtime"
)

type mockTermMgr struct {
	createdReq  protocol.CreateSessionRequest
	inputs      map[string][][]byte
	closed      map[string]bool
	subscribers map[string]func(protocol.PTYOutputEnvelope, protocol.SessionStateEnvelope)
}

func newMockTermMgr() *mockTermMgr {
	return &mockTermMgr{
		inputs:      make(map[string][][]byte),
		closed:      make(map[string]bool),
		subscribers: make(map[string]func(protocol.PTYOutputEnvelope, protocol.SessionStateEnvelope)),
	}
}

func (m *mockTermMgr) Create(_ context.Context, req protocol.CreateSessionRequest) (*protocol.SessionSummary, error) {
	m.createdReq = req
	now := time.Now().UTC()
	return &protocol.SessionSummary{
		ID:        "term-123",
		Name:      req.Name,
		Command:   req.Command,
		CWD:       req.CWD,
		State:     "running",
		CreatedAt: now,
		UpdatedAt: now,
	}, nil
}

func (m *mockTermMgr) Input(id string, b []byte) error {
	m.inputs[id] = append(m.inputs[id], b)
	return nil
}

func (m *mockTermMgr) Close(id string) error {
	m.closed[id] = true
	return nil
}

func (m *mockTermMgr) Subscribe(id string, fn func(protocol.PTYOutputEnvelope, protocol.SessionStateEnvelope)) (func(), error) {
	m.subscribers[id] = fn
	return func() { delete(m.subscribers, id) }, nil
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
	if !termMgr.closed["term-123"] {
		t.Fatal("terminal was not closed after shutdown won")
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

func TestRestoredAgentResumesTranscriptPolling(t *testing.T) {
	stateDir := t.TempDir()
	store, err := runtimestore.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Now().UTC()
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
