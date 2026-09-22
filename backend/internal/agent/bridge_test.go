package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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

func TestBridgePromptSemanticEventIsDurableAndDeduplicated(t *testing.T) {
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
		t.Fatal(err)
	}

	conn, err := net.Dial("unix", svc.bridgeServer.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	hello, _ := json.Marshal(BridgeHello{Type: "hello", AgentID: agent.ID, Secret: termMgr.createdReq.Env["AGENTIC_REMOTE_BRIDGE_SECRET"], SessionID: "session-1", SessionFile: "/path/to/session.jsonl", Capabilities: []string{"prompt"}})
	if _, err := conn.Write(append(hello, '\n')); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(time.Second); !svc.bridgeServer.IsConnected(agent.ID) && time.Now().Before(deadline); {
		time.Sleep(time.Millisecond)
	}
	if !svc.bridgeServer.IsConnected(agent.ID) {
		t.Fatal("bridge did not authenticate")
	}

	received := make(chan protocol.AgentEvent, 1)
	unsubscribe, err := svc.Subscribe(agent.ID, func(event protocol.AgentEvent) {
		if event.Type == "message.user" {
			received <- event
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()

	promptErr := make(chan error, 1)
	go func() { promptErr <- svc.SubmitPrompt(agent.ID, "prompt now") }()
	reader := bufio.NewReader(conn)
	commandLine, err := reader.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var command BridgeCommand
	if err := json.Unmarshal(commandLine, &command); err != nil {
		t.Fatal(err)
	}
	semantic := BridgeSemanticFrame{Type: "semantic", Event: "message.user", EventID: "bridge:prompt:" + command.RequestID, Text: "prompt now"}
	semanticLine, _ := json.Marshal(semantic)
	if _, err := conn.Write(append(semanticLine, '\n')); err != nil {
		t.Fatal(err)
	}
	resultLine, _ := json.Marshal(BridgeCommandResult{Type: "command.result", RequestID: command.RequestID, OK: true})
	if _, err := conn.Write(append(resultLine, '\n')); err != nil {
		t.Fatal(err)
	}
	if err := <-promptErr; err != nil {
		t.Fatalf("SubmitPrompt() = %v", err)
	}
	select {
	case event := <-received:
		if event.EventID != semantic.EventID || event.Text != "prompt now" {
			t.Fatalf("unexpected prompt event: %+v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("prompt semantic event was not observable")
	}

	if _, err := conn.Write(append(semanticLine, '\n')); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	history, err := svc.History(agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(history.Events) != 1 || history.Events[0].EventID != semantic.EventID {
		t.Fatalf("prompt history = %+v, want one durable semantic event", history.Events)
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
	stateEvents := make(chan protocol.AgentEvent, 2)
	unsubscribe, err := svc.Subscribe(agent.ID, func(event protocol.AgentEvent) {
		if event.Type == "state" {
			stateEvents <- event
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()

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
	select {
	case event := <-stateEvents:
		if !hasEnabledCapability(event.Capabilities, "prompt") {
			t.Fatalf("connected state event missing prompt capability: %+v", event.Capabilities)
		}
	case <-time.After(time.Second):
		t.Fatal("missing connected state event")
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
	select {
	case event := <-stateEvents:
		if hasEnabledCapability(event.Capabilities, "prompt") {
			t.Fatalf("disconnected state event retained prompt capability: %+v", event.Capabilities)
		}
	case <-time.After(time.Second):
		t.Fatal("missing disconnected state event")
	}

	if err := svc.SubmitPrompt(agent.ID, "hello"); err == nil || err.Error() != "needs_terminal" {
		t.Fatalf("expected needs_terminal after disconnect, got %v", err)
	}
}

func hasEnabledCapability(capabilities []protocol.AgentCapability, name string) bool {
	for _, capability := range capabilities {
		if capability.Name == name {
			return capability.Enabled
		}
	}
	return false
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
	server, err := NewBridgeServer(t.TempDir()+"/bridge.sock", nil, func(string) { disconnected.Add(1) }, nil, nil, nil)
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
	_ = os.MkdirAll(filepath.Join(piDir, "agent"), 0o700)
	_ = os.WriteFile(filepath.Join(piDir, "agent", "models.yml"), models, 0o600)
	agentState := filepath.Join(t.TempDir(), "agent-state")
	if err := os.MkdirAll(agentState, 0o700); err != nil {
		t.Fatalf("mkdir agentState: %v", err)
	}
	if err := os.WriteFile(filepath.Join(agentState, "models.yml"), models, 0o600); err != nil {
		t.Fatalf("write models.yml to agentState: %v", err)
	}
	_ = os.MkdirAll(filepath.Join(agentState, "agent"), 0o700)
	_ = os.WriteFile(filepath.Join(agentState, "agent", "models.yml"), models, 0o600)
	t.Setenv("PI_CODING_AGENT_DIR", piDir)
	t.Setenv("OMP_AGENT_MODELS_FILE", filepath.Join(piDir, "models.yml"))
	ompPID := func() string {
		output, err := exec.Command("ps", "-o", "pid=,ppid=,comm=", "-e").Output()
		if err != nil {
			t.Fatal(err)
		}
		parentPID := strconv.Itoa(os.Getpid())
		for _, line := range strings.Split(string(output), "\n") {
			fields := strings.Fields(line)
			if len(fields) == 3 && fields[1] == parentPID && fields[2] == "omp" {
				return fields[0]
			}
		}
		t.Fatal("managed OMP is not a direct child of the terminal runtime")
		return ""
	}

	termMgr, err := session.NewManager(workDir, filepath.Join(t.TempDir(), "terminals"), workDir, 1<<20, 64, nil)
	if err != nil {
		t.Fatal(err)
	}
	store, err := runtimestore.Open(agentState)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewService(termMgr, store, agentState)
	defer svc.Close()

	created, err := svc.CreateAgentRequest(context.Background(), protocol.CreateSessionRequest{CWD: workDir, Name: "real omp"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = termMgr.Close(created.TerminalSessionID) })
	deadline := time.Now().Add(45 * time.Second)
	for !svc.bridgeServer.IsConnected(created.ID) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if !svc.bridgeServer.IsConnected(created.ID) {
		t.Fatal("real OMP extension never authenticated with production BridgeServer")
	}
	capabilityEnabled := func(name string) bool {
		current, err := svc.GetAgent(created.ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, capability := range current.Capabilities {
			if capability.Name == name {
				return capability.Enabled
			}
		}
		return false
	}
	if !capabilityEnabled("prompt") {
		t.Fatal("authenticated extension did not enable prompt capability")
	}

	svc.bridgeServer.mu.RLock()
	bridgeState := svc.bridgeServer.agents[created.ID]
	svc.bridgeServer.mu.RUnlock()
	bridgeState.mu.Lock()
	beforeSessionID, beforeSessionFile, bridgeConn := bridgeState.sessionID, bridgeState.sessionFile, bridgeState.conn
	bridgeState.mu.Unlock()
	beforePID := ompPID()
	if beforeSessionID == "" || beforeSessionFile == "" || bridgeConn == nil {
		t.Fatal("authenticated bridge has no session identity, session file, or connection")
	}
	if err := bridgeConn.Close(); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(15 * time.Second)
	for (svc.bridgeServer.IsConnected(created.ID) || capabilityEnabled("prompt")) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if svc.bridgeServer.IsConnected(created.ID) || capabilityEnabled("prompt") {
		t.Fatal("bridge loss did not disable interactive capabilities")
	}
	deadline = time.Now().Add(15 * time.Second)
	for !svc.bridgeServer.IsConnected(created.ID) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if !svc.bridgeServer.IsConnected(created.ID) || !capabilityEnabled("prompt") {
		t.Fatal("real OMP extension did not reconnect and restore capabilities")
	}
	bridgeState.mu.Lock()
	afterSessionID, afterSessionFile := bridgeState.sessionID, bridgeState.sessionFile
	bridgeState.mu.Unlock()
	if afterSessionID != beforeSessionID || afterSessionFile != beforeSessionFile {
		t.Fatalf("bridge reconnect identity = (%q, %q), want (%q, %q)", afterSessionID, afterSessionFile, beforeSessionID, beforeSessionFile)
	}
	if afterPID := ompPID(); afterPID != beforePID {
		t.Fatalf("bridge reconnect OMP PID = %s, want %s", afterPID, beforePID)
	}
}

func TestBridgeLifecycleStateTransitions(t *testing.T) {
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

	stateEvents := make(chan protocol.AgentEvent, 10)
	unsubscribe, err := svc.Subscribe(agent.ID, func(event protocol.AgentEvent) {
		if event.Type == "state" {
			stateEvents <- event
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribe()

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
	helloBytes = append(helloBytes, '\n')
	if _, err := conn.Write(helloBytes); err != nil {
		t.Fatalf("failed to write hello frame: %v", err)
	}

	for range 50 {
		if svc.bridgeServer.IsConnected(agent.ID) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !svc.bridgeServer.IsConnected(agent.ID) {
		t.Fatal("agent failed to authenticate via bridge")
	}

	// Drain the state event emitted by the hello handshake itself before
	// asserting on lifecycle-driven transitions below.
	select {
	case <-stateEvents:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for hello state event")
	}

	sendLifecycle := func(event, state string) {
		frame := BridgeLifecycleFrame{
			Type:  "lifecycle",
			Event: event,
			State: state,
		}
		b, _ := json.Marshal(frame)
		b = append(b, '\n')
		if _, err := conn.Write(b); err != nil {
			t.Fatalf("failed to write lifecycle frame: %v", err)
		}
	}

	// 1. turn_start -> working
	sendLifecycle("turn_start", "working")
	select {
	case ev := <-stateEvents:
		if ev.State != "working" {
			t.Fatalf("expected state working, got %s", ev.State)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for turn_start state event")
	}

	// 2. tool_approval_requested -> needsYou
	sendLifecycle("approval_requested", "needsYou")
	select {
	case ev := <-stateEvents:
		if ev.State != "needsYou" {
			t.Fatalf("expected state needsYou, got %s", ev.State)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for approval_requested state event")
	}

	// 3. tool_approval_resolved -> working
	sendLifecycle("approval_resolved", "working")
	select {
	case ev := <-stateEvents:
		if ev.State != "working" {
			t.Fatalf("expected state working, got %s", ev.State)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for approval_resolved state event")
	}

	// 4. turn_end -> idle
	sendLifecycle("turn_end", "idle")
	select {
	case ev := <-stateEvents:
		if ev.State != "idle" {
			t.Fatalf("expected state idle, got %s", ev.State)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for turn_end state event")
	}

	// 5. session_shutdown -> exited
	sendLifecycle("session_shutdown", "exited")
	select {
	case ev := <-stateEvents:
		if ev.State != "exited" {
			t.Fatalf("expected state exited, got %s", ev.State)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for session_shutdown state event")
	}
}

func TestBridgeAuthorityOverTranscriptPolling(t *testing.T) {
	stateDir := t.TempDir()
	store, err := runtimestore.Open(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	termMgr := newMockTermMgr()
	svc := NewService(termMgr, store, stateDir)
	defer svc.Close()

	sessionFile := filepath.Join(stateDir, "session.jsonl")
	if err := os.WriteFile(sessionFile, nil, 0o600); err != nil {
		t.Fatal(err)
	}

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
		SessionFile:  sessionFile,
		Capabilities: []string{"prompt", "abort"},
	}
	helloBytes, _ := json.Marshal(hello)
	helloBytes = append(helloBytes, '\n')
	if _, err := conn.Write(helloBytes); err != nil {
		t.Fatalf("failed to write hello frame: %v", err)
	}

	for range 50 {
		if svc.bridgeServer.IsConnected(agent.ID) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Set state to needsYou via bridge
	frame := BridgeLifecycleFrame{
		Type:  "lifecycle",
		Event: "approval_requested",
		State: "needsYou",
	}
	b, _ := json.Marshal(frame)
	_, _ = conn.Write(append(b, '\n'))
	time.Sleep(50 * time.Millisecond)

	ag, err := svc.GetAgent(agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ag.State != "needsYou" {
		t.Fatalf("expected state needsYou, got %s", ag.State)
	}

	// Simulate transcript event appended
	userMsg := `{"type":"message","id":"msg1","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}` + "\n"
	if err := os.WriteFile(sessionFile, []byte(userMsg), 0o600); err != nil {
		t.Fatal(err)
	}

	svc.mu.RLock()
	inst := svc.agents[agent.ID]
	svc.mu.RUnlock()
	svc.checkTranscript(inst)

	// Since bridge is connected, state should remain needsYou, NOT overwritten by transcript
	ag, err = svc.GetAgent(agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ag.State != "needsYou" {
		t.Fatalf("expected state to remain needsYou under bridge authority, got %s", ag.State)
	}

	// Disconnect bridge
	_ = conn.Close()
	for range 50 {
		if !svc.bridgeServer.IsConnected(agent.ID) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Append assistant message in transcript
	asstMsg := `{"type":"message","id":"msg2","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}` + "\n"
	f, _ := os.OpenFile(sessionFile, os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.Write([]byte(asstMsg))
	_ = f.Close()

	svc.checkTranscript(inst)

	// Now disconnected: transcript should derive idle state
	ag, err = svc.GetAgent(agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ag.State != "idle" {
		t.Fatalf("expected state idle after transcript fallback, got %s", ag.State)
	}
}

func TestBridgeSessionChangedTerminatesRuntime(t *testing.T) {
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
		SessionFile:  "/path/to/session1.jsonl",
		Capabilities: []string{"prompt", "abort"},
	}
	helloBytes, _ := json.Marshal(hello)
	helloBytes = append(helloBytes, '\n')
	if _, err := conn.Write(helloBytes); err != nil {
		t.Fatalf("failed to write hello frame: %v", err)
	}

	for range 50 {
		if svc.bridgeServer.IsConnected(agent.ID) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Send session_changed event with different session
	frame := BridgeLifecycleFrame{
		Type:        "lifecycle",
		Event:       "session_changed",
		SessionID:   "session-2",
		SessionFile: "/path/to/session2.jsonl",
	}
	b, _ := json.Marshal(frame)
	_, _ = conn.Write(append(b, '\n'))
	for range 50 {
		ag, _ := svc.GetAgent(agent.ID)
		if ag != nil && ag.State == "exited" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	ag, err := svc.GetAgent(agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ag.State != "exited" {
		t.Fatalf("expected state exited on session change, got %s", ag.State)
	}
	if svc.bridgeServer.IsConnected(agent.ID) {
		t.Fatal("expected bridge to be unregistered after runtime termination")
	}
}

func TestBridgeModelAndThinkingCommands(t *testing.T) {
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
		SessionFile:  "/path/to/session1.jsonl",
		Capabilities: []string{"prompt", "abort", "model", "thinking"},
		Model: &protocol.AgentModelInfo{
			ID:       "claude-3-7-sonnet",
			Name:     "Claude 3.7 Sonnet",
			Provider: "anthropic",
		},
		Thinking: "off",
		AvailableModels: []protocol.AgentModelInfo{
			{ID: "claude-3-7-sonnet", Name: "Claude 3.7 Sonnet", Provider: "anthropic"},
			{ID: "claude-3-5-haiku", Name: "Claude 3.5 Haiku", Provider: "anthropic"},
		},
		AvailableThinking: []string{"off", "low", "medium", "high", "max"},
	}
	helloBytes, _ := json.Marshal(hello)
	helloBytes = append(helloBytes, '\n')
	if _, err := conn.Write(helloBytes); err != nil {
		t.Fatalf("failed to write hello frame: %v", err)
	}

	for range 50 {
		if svc.bridgeServer.IsConnected(agent.ID) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	reader := bufio.NewReader(conn)
	go func() {
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			var cmd BridgeCommand
			if err := json.Unmarshal(line, &cmd); err != nil {
				continue
			}
			if cmd.Type == "command" {
				res := BridgeCommandResult{
					Type:      "command.result",
					RequestID: cmd.RequestID,
					OK:        true,
				}
				resBytes, _ := json.Marshal(res)
				resBytes = append(resBytes, '\n')
				_, _ = conn.Write(resBytes)
			}
		}
	}()

	if err := svc.SetModel(agent.ID, "claude-3-5-haiku"); err != nil {
		t.Fatalf("SetModel failed: %v", err)
	}
	ag, err := svc.GetAgent(agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ag.Model == nil || ag.Model.ID != "claude-3-5-haiku" {
		t.Fatalf("expected model claude-3-5-haiku, got %+v", ag.Model)
	}

	if err := svc.SetThinking(agent.ID, "high"); err != nil {
		t.Fatalf("SetThinking failed: %v", err)
	}
	ag, err = svc.GetAgent(agent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ag.Thinking != "high" {
		t.Fatalf("expected thinking high, got %s", ag.Thinking)
	}
}
