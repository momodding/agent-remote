package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/protocol"
	runtimestore "github.com/agenticremote/agenticremote/backend/internal/runtime"
	"github.com/agenticremote/agenticremote/backend/internal/session"
)

func TestBridgeUnknownSecretRejected(t *testing.T) {
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

	if svc.bridgeServer == nil {
		t.Fatal("bridgeServer is nil")
	}

	conn, err := net.Dial("unix", svc.bridgeServer.SocketPath())
	if err != nil {
		t.Fatalf("failed to dial bridge socket: %v", err)
	}
	defer conn.Close()

	hello := BridgeHello{
		Type:         "hello",
		AgentID:      agent.ID,
		Secret:       "invalid-secret-value",
		SessionID:    "session-1",
		SessionFile:  "/path/to/session.jsonl",
		Capabilities: []string{"prompt", "abort"},
	}
	helloBytes, _ := json.Marshal(hello)
	helloBytes = append(helloBytes, '\n')
	if _, err := conn.Write(helloBytes); err != nil {
		t.Fatalf("failed to write hello frame: %v", err)
	}

	// Server should reject and close connection
	buf := make([]byte, 1024)
	_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	_, err = conn.Read(buf)
	if err == nil {
		t.Fatal("expected connection to be closed on invalid secret, but read succeeded")
	}

	if svc.bridgeServer.IsConnected(agent.ID) {
		t.Fatal("expected agent not to be authenticated with invalid secret")
	}

	if err := svc.SubmitPrompt(agent.ID, "hello"); err == nil || err.Error() != "needs_terminal" {
		t.Fatalf("expected needs_terminal, got %v", err)
	}
}

func TestBridgeCommandErrorPropagation(t *testing.T) {
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
	if secret == "" {
		t.Fatal("missing AGENTIC_REMOTE_BRIDGE_SECRET in created request env")
	}

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
	helloBytes = append(helloBytes, '\n')
	if _, err := conn.Write(helloBytes); err != nil {
		t.Fatalf("failed to write hello frame: %v", err)
	}

	// Wait for hello to register
	for i := 0; i < 50; i++ {
		if svc.bridgeServer.IsConnected(agent.ID) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !svc.bridgeServer.IsConnected(agent.ID) {
		t.Fatal("agent failed to authenticate via bridge")
	}

	promptErrCh := make(chan error, 1)
	go func() {
		promptErrCh <- svc.SubmitPrompt(agent.ID, "test prompt")
	}()

	reader := bufio.NewReader(conn)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	line, err := reader.ReadBytes('\n')
	if err != nil {
		t.Fatalf("failed to read command frame from bridge client: %v", err)
	}

	var cmd BridgeCommand
	if err := json.Unmarshal(line, &cmd); err != nil {
		t.Fatalf("failed to unmarshal command frame: %v", err)
	}
	if cmd.Command != "prompt" {
		t.Fatalf("expected command prompt, got %s", cmd.Command)
	}

	// Respond with ok: false and specific error
	res := BridgeCommandResult{
		Type:      "command.result",
		RequestID: cmd.RequestID,
		OK:        false,
		Error:     "context window limit exceeded",
	}
	resBytes, _ := json.Marshal(res)
	resBytes = append(resBytes, '\n')
	if _, err := conn.Write(resBytes); err != nil {
		t.Fatalf("failed to write command.result: %v", err)
	}

	select {
	case pErr := <-promptErrCh:
		if pErr == nil || pErr.Error() != "context window limit exceeded" {
			t.Fatalf("expected 'context window limit exceeded', got %v", pErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for SubmitPrompt to return propagated error")
	}
}

func TestBridgeDisconnectMakesCommandsUnavailable(t *testing.T) {
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

	hello := BridgeHello{
		Type:         "hello",
		AgentID:      agent.ID,
		Secret:       secret,
		SessionID:    "session-1",
		SessionFile:  "/path/to/session.jsonl",
		Capabilities: []string{"prompt", "abort", "model", "thinking"},
	}
	helloBytes, _ := json.Marshal(hello)
	helloBytes = append(helloBytes, '\n')
	if _, err := conn.Write(helloBytes); err != nil {
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

	ag, err := svc.GetAgent(agent.ID)
	if err != nil {
		t.Fatalf("GetAgent failed: %v", err)
	}
	var promptCap *protocol.AgentCapability
	for i := range ag.Capabilities {
		if ag.Capabilities[i].Name == "prompt" {
			promptCap = &ag.Capabilities[i]
		}
	}
	if promptCap == nil || !promptCap.Enabled {
		t.Fatalf("expected prompt capability enabled, got %+v", ag.Capabilities)
	}

	// Close client connection to simulate disconnect
	_ = conn.Close()

	for i := 0; i < 50; i++ {
		if !svc.bridgeServer.IsConnected(agent.ID) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if svc.bridgeServer.IsConnected(agent.ID) {
		t.Fatal("agent should not be connected after socket close")
	}

	ag, err = svc.GetAgent(agent.ID)
	if err != nil {
		t.Fatalf("GetAgent failed: %v", err)
	}
	for i := range ag.Capabilities {
		if ag.Capabilities[i].Name == "prompt" && ag.Capabilities[i].Enabled {
			t.Fatal("prompt capability should be disabled after disconnect")
		}
	}

	if err := svc.SubmitPrompt(agent.ID, "hello"); err == nil || err.Error() != "needs_terminal" {
		t.Fatalf("expected needs_terminal after disconnect, got %v", err)
	}
}

func TestManagedLaunchArgsAndInternalEnv(t *testing.T) {
	stateDir := t.TempDir()
	store, err := runtimestore.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	termMgr := newMockTermMgr()
	svc := NewService(termMgr, store, stateDir)
	defer svc.Close()

	agent, err := svc.CreateAgent(context.Background(), "/workspace", "Test Agent", "--model", "anthropic/claude-3-5-sonnet")
	if err != nil {
		t.Fatalf("CreateAgent failed: %v", err)
	}

	req := termMgr.createdReq
	if req.Command != "omp" {
		t.Fatalf("req.Command = %q, want 'omp'", req.Command)
	}
	if len(req.Args) < 5 {
		t.Fatalf("req.Args length = %d, want at least 5", len(req.Args))
	}
	if req.Args[0] != "--no-extensions" {
		t.Fatalf("req.Args[0] = %q, want '--no-extensions'", req.Args[0])
	}
	if req.Args[1] != "-e" {
		t.Fatalf("req.Args[1] = %q, want '-e'", req.Args[1])
	}
	bridgePath := req.Args[2]
	if !strings.HasSuffix(bridgePath, "bridge.ts") {
		t.Fatalf("req.Args[2] = %q, want path ending with 'bridge.ts'", bridgePath)
	}
	info, err := os.Stat(bridgePath)
	if err != nil {
		t.Fatalf("bridge file does not exist: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("bridge file perm = %o, want 0600", info.Mode().Perm())
	}
	if req.Args[3] != "--model" || req.Args[4] != "anthropic/claude-3-5-sonnet" {
		t.Fatalf("req.Args suffix = %v, want [--model anthropic/claude-3-5-sonnet]", req.Args[3:])
	}

	if req.Env == nil {
		t.Fatal("req.Env is nil")
	}
	if req.Env["AGENTIC_REMOTE_BRIDGE_SOCKET"] != svc.bridgeServer.SocketPath() {
		t.Fatalf("socket env = %q, want %q", req.Env["AGENTIC_REMOTE_BRIDGE_SOCKET"], svc.bridgeServer.SocketPath())
	}
	if req.Env["AGENTIC_REMOTE_BRIDGE_AGENT_ID"] != agent.ID {
		t.Fatalf("agent ID env = %q, want %q", req.Env["AGENTIC_REMOTE_BRIDGE_AGENT_ID"], agent.ID)
	}
	secret := req.Env["AGENTIC_REMOTE_BRIDGE_SECRET"]
	if len(secret) != 64 {
		t.Fatalf("secret length = %d, want 64 hex chars", len(secret))
	}

	// Test user argument protection
	forbiddenArgs := [][]string{
		{"-e", "/tmp/malicious.ts"},
		{"--extension", "/tmp/malicious.ts"},
		{"--extension=/tmp/malicious.ts"},
		{"--trusted-extension", "/tmp/malicious.ts"},
		{"--mode", "rpc"},
		{"--mode=rpc"},
		{"--print"},
		{"--export", "out.json"},
	}
	for _, fArgs := range forbiddenArgs {
		_, err := svc.CreateAgent(context.Background(), "/workspace", "Bad Agent", fArgs...)
		if err == nil {
			t.Fatalf("expected error for forbidden args %v, got nil", fArgs)
		}
	}
}

func TestBridgeReplacementDoesNotDisconnectLiveConnection(t *testing.T) {
	var disconnected atomic.Uint32
	server, err := NewBridgeServer(t.TempDir()+"/bridge.sock", nil, func(string) { disconnected.Add(1) })
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	server.RegisterAgent("agent", "secret")
	dial := func() net.Conn {
		conn, err := net.Dial("unix", server.SocketPath())
		if err != nil {
			t.Fatal(err)
		}
		frame, _ := json.Marshal(BridgeHello{Type: "hello", AgentID: "agent", Secret: "secret"})
		if _, err := conn.Write(append(frame, '\n')); err != nil {
			t.Fatal(err)
		}
		return conn
	}
	first := dial()
	defer first.Close()
	for !server.IsConnected("agent") {
		time.Sleep(time.Millisecond)
	}
	second := dial()
	defer second.Close()
	_ = first.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := first.Read(make([]byte, 1)); err == nil {
		t.Fatal("replacement did not close the first bridge connection")
	}
	time.Sleep(50 * time.Millisecond)
	if disconnected.Load() != 0 || !server.IsConnected("agent") {
		t.Fatalf("stale close disconnected replacement: calls=%d connected=%t", disconnected.Load(), server.IsConnected("agent"))
	}
	_ = second.Close()
	for i := 0; i < 100 && disconnected.Load() == 0; i++ {
		time.Sleep(time.Millisecond)
	}
	if disconnected.Load() != 1 {
		t.Fatalf("live close calls=%d, want 1", disconnected.Load())
	}
}

// TestRealOMPBridgeLifecycle joins the real managed extension to the production
// BridgeServer. It is opt-in because CI intentionally has no reachable OMP model.
func TestRealOMPBridgeLifecycle(t *testing.T) {
	modelsFile := os.Getenv("AGENTICREMOTE_OMP_MODELS_FILE")
	if modelsFile == "" {
		t.Skip("set AGENTICREMOTE_OMP_MODELS_FILE to run against installed OMP")
	}
	if _, err := exec.LookPath("omp"); err != nil {
		t.Skip("installed omp is required")
	}
	models, err := os.ReadFile(modelsFile)
	if err != nil {
		t.Fatal(err)
	}
	workDir := t.TempDir()
	piDir := filepath.Join(t.TempDir(), "omp")
	if err := os.MkdirAll(piDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(piDir, "models.yml"), models, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PI_CODING_AGENT_DIR", piDir)

	termMgr, err := session.NewManager(workDir, filepath.Join(t.TempDir(), "terminals"), workDir, 1<<20, 64, nil)
	if err != nil {
		t.Fatal(err)
	}
	agentState := t.TempDir()
	store, err := runtimestore.Open(agentState)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	svc := NewService(termMgr, store, agentState)
	defer svc.Close()

	created, err := svc.CreateAgentRequest(context.Background(), protocol.CreateSessionRequest{CWD: workDir, Name: "real omp"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = termMgr.Close(created.TerminalSessionID) })
	deadline := time.Now().Add(15 * time.Second)
	for !svc.bridgeServer.IsConnected(created.ID) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if !svc.bridgeServer.IsConnected(created.ID) {
		t.Fatal("real OMP extension never authenticated with production BridgeServer")
	}
	if err := svc.SetThinking(created.ID, "low"); err != nil {
		t.Fatalf("thinking command through real bridge: %v", err)
	}
	if err := svc.Abort(created.ID); err != nil {
		t.Fatalf("abort command through real bridge: %v", err)
	}
	current, err := svc.GetAgent(created.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, capability := range current.Capabilities {
		if capability.Name == "prompt" && !capability.Enabled {
			t.Fatal("authenticated extension did not enable prompt capability")
		}
	}
}
