package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net"
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
