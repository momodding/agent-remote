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
	if agent.ID != "term-123" || agent.Adapter != "omp" || agent.State != "idle" {
		t.Fatalf("unexpected agent summary: %+v", agent)
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
}
