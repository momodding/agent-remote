package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	runtimestore "github.com/agenticremote/agenticremote/backend/internal/runtime"
)

// TestBridgeCommandTimeoutWhenWedged verifies failure scenario 11:
// Bridge command timeout (SubmitPrompt/Abort/SetModel/SetThinking must not block
// forever if the bridge connection is wedged/unresponsive).
func TestBridgeCommandTimeoutWhenWedged(t *testing.T) {
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
		t.Fatalf("CreateAgent failed: %v", err)
	}

	secret := termMgr.createdReq.Env["AGENTIC_REMOTE_BRIDGE_SECRET"]
	conn, err := net.Dial("unix", svc.bridgeServer.SocketPath())
	if err != nil {
		t.Fatalf("failed to dial bridge socket: %v", err)
	}
	defer conn.Close()

	hello := BridgeHello{
		Type:         "hello",
		AgentID:      agent.ID,
		Secret:       secret,
		SessionID:    "session-1",
		SessionFile:  "/path/to/session.jsonl",
		Capabilities: []string{"prompt", "abort", "model", "thinking"},
	}
	helloBytes, _ := json.Marshal(hello)
	if _, err := conn.Write(append(helloBytes, '\n')); err != nil {
		t.Fatalf("failed to write hello frame: %v", err)
	}

	for i := 0; i < 50; i++ {
		if svc.bridgeServer.IsConnected(agent.ID) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !svc.bridgeServer.IsConnected(agent.ID) {
		t.Fatal("agent failed to authenticate via bridge")
	}

	// The mock bridge client is intentionally wedged: it reads nothing and responds with nothing.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	start := time.Now()
	err = svc.bridgeServer.SendCommand(ctx, agent.ID, "prompt", map[string]any{"prompt": "hello"})
	duration := time.Since(start)

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected context.DeadlineExceeded, got %v", err)
	}
	if duration > 500*time.Millisecond {
		t.Fatalf("command took too long to timeout: %v", duration)
	}

	// Verify pending map cleaned up
	svc.bridgeServer.mu.RLock()
	st := svc.bridgeServer.agents[agent.ID]
	svc.bridgeServer.mu.RUnlock()
	st.mu.Lock()
	pendingLen := len(st.pending)
	st.mu.Unlock()

	if pendingLen != 0 {
		t.Fatalf("expected 0 pending commands after timeout, got %d", pendingLen)
	}
}

// TestRuntimeDBWriteFailureDuringTranscriptCommit verifies scenario 1:
// When runtime DB write fails during transcript commit, tailer state must roll back,
// subsequent read/commit must recover and persist the exact event once without loss or duplicate.
func TestRuntimeDBWriteFailureDuringTranscriptCommit(t *testing.T) {
	stateDir := t.TempDir()
	store, err := runtimestore.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	agentID := "agent_db_fail_test"
	path := filepath.Join(t.TempDir(), "session.jsonl")
	tailer := NewTranscriptTailer(agentID, path, store)

	// Step 1: Write first event to file
	msg1 := `{"type":"message","id":"m1","message":{"role":"user","content":"first line"}}` + "\n"
	if err := os.WriteFile(path, []byte(msg1), 0o644); err != nil {
		t.Fatal(err)
	}

	before := tailer.snapshot()
	events, err := tailer.Read()
	if err != nil || len(events) != 1 {
		t.Fatalf("first read failed: len=%d, err=%v", len(events), err)
	}

	// Step 2: Simulate DB write failure by closing store
	_ = store.Close()

	inputs := []runtimestore.AgentTranscriptEvent{
		{EventID: events[0].EventID, Kind: events[0].Type, Payload: []byte(`{"text":"first line"}`)},
	}
	_, err = store.RecordAgentTranscript(agentID, inputs, tailer.checkpoint())
	if err == nil {
		t.Fatal("expected DB write error on closed store, got nil")
	}

	// Roll back tailer as adapter.go does on DB failure
	tailer.restore(before)

	// Step 3: Reopen database and verify recovery
	store2, err := runtimestore.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store2.Close()

	tailer.store = store2

	// Next read must re-read line 1 because offset was rolled back
	eventsRetry, err := tailer.Read()
	if err != nil || len(eventsRetry) != 1 {
		t.Fatalf("retry read failed: len=%d, err=%v", len(eventsRetry), err)
	}
	if eventsRetry[0].EventID != "m1:message" {
		t.Fatalf("unexpected event on retry: %+v", eventsRetry[0])
	}

	// Commit succeeds
	inputsRetry := []runtimestore.AgentTranscriptEvent{
		{EventID: eventsRetry[0].EventID, Kind: eventsRetry[0].Type, Payload: []byte(`{"text":"first line"}`)},
	}
	committed, err := store2.RecordAgentTranscript(agentID, inputsRetry, tailer.checkpoint())
	if err != nil || len(committed) != 1 {
		t.Fatalf("commit to reopened DB failed: committed=%+v, err=%v", committed, err)
	}
	if committed[0].Event.Cursor != 1 {
		t.Fatalf("expected cursor 1, got %d", committed[0].Event.Cursor)
	}

	// Step 4: Write second event to file
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	msg2 := `{"type":"message","id":"m2","message":{"role":"assistant","content":"second line"}}` + "\n"
	if _, err := f.WriteString(msg2); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()

	events2, err := tailer.Read()
	if err != nil || len(events2) != 1 {
		t.Fatalf("second read failed: len=%d, err=%v", len(events2), err)
	}
	if events2[0].EventID != "m2:message" {
		t.Fatalf("unexpected second event: %+v", events2[0])
	}

	inputs2 := []runtimestore.AgentTranscriptEvent{
		{EventID: events2[0].EventID, Kind: events2[0].Type, Payload: []byte(`{"text":"second line"}`)},
	}
	committed2, err := store2.RecordAgentTranscript(agentID, inputs2, tailer.checkpoint())
	if err != nil || len(committed2) != 1 {
		t.Fatalf("commit second event failed: committed=%+v, err=%v", committed2, err)
	}
	if committed2[0].Event.Cursor != 2 {
		t.Fatalf("expected cursor 2, got %d", committed2[0].Event.Cursor)
	}

	// Step 5: Read from DB to verify deterministic state
	allEvents, _, err := store2.AgentHistory(agentID)
	if err != nil {
		t.Fatal(err)
	}
	if len(allEvents) != 2 {
		t.Fatalf("expected exactly 2 events in store, got %d", len(allEvents))
	}
	if allEvents[0].EventID != "m1:message" || allEvents[1].EventID != "m2:message" {
		t.Fatalf("unexpected stored events: %+v", allEvents)
	}
}

