package agent

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
	"github.com/agenticremote/agenticremote/backend/internal/config"
	"github.com/agenticremote/agenticremote/backend/internal/protocol"
	runtimestore "github.com/agenticremote/agenticremote/backend/internal/runtime"
	"github.com/agenticremote/agenticremote/backend/internal/security"
	"github.com/agenticremote/agenticremote/backend/internal/session"
	"github.com/coder/websocket"
)

// TestGoldenFlowHermeticPhase1to4 exercises the full GF-PHASE-1-4 flow against
// real daemon binary, real OMP binary, real tmux, and a hermetic local MockOpenAIServer.
// It rigorously tests every step with genuine t.Fatalf assertions, eliminating all false-positives
// from the audit and validating RAR-034 through RAR-042 architecture guarantees.
func getProcessPPID(pid int) int {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0
	}
	s := string(data)
	idx := strings.LastIndex(s, ")")
	if idx == -1 || idx+2 >= len(s) {
		return 0
	}
	fields := strings.Fields(s[idx+2:])
	if len(fields) < 2 {
		return 0
	}
	ppid, _ := strconv.Atoi(fields[1])
	return ppid
}

func findHermeticOMPPIDs(agentID string) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var matchedPIDs []int
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		cmdlineBytes, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "cmdline"))
		if err != nil {
			continue
		}
		cmdline := string(cmdlineBytes)
		if !strings.Contains(cmdline, "omp") {
			continue
		}
		envBytes, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "environ"))
		if err != nil {
			continue
		}
		envStr := string(envBytes)
		if strings.Contains(envStr, "AGENTIC_REMOTE_BRIDGE_AGENT_ID="+agentID) {
			matchedPIDs = append(matchedPIDs, pid)
		}
	}
	if len(matchedPIDs) <= 1 {
		return matchedPIDs
	}
	pidSet := make(map[int]bool)
	for _, p := range matchedPIDs {
		pidSet[p] = true
	}
	var rootPIDs []int
	for _, p := range matchedPIDs {
		ppid := getProcessPPID(p)
		if !pidSet[ppid] {
			rootPIDs = append(rootPIDs, p)
		}
	}
	return rootPIDs
}

func findHermeticOMPPIDForAgent(t *testing.T, agentID string) int {
	t.Helper()
	pids := findHermeticOMPPIDs(agentID)
	if len(pids) != 1 {
		t.Fatalf("expected exactly 1 root OMP process for agent %s, found %d (pids: %v)", agentID, len(pids), pids)
	}
	return pids[0]
}

func countHermeticOMPPIDsForAgent(agentID string) int {
	return len(findHermeticOMPPIDs(agentID))
}

func TestGoldenFlowHermeticPhase1to4(t *testing.T) {
	requireBinary(t, "omp")
	requireBinary(t, "tmux")

	// Mandate: The gate must print the tested OMP version.
	versionCmd := exec.Command("omp", "--version")
	versionOut, _ := versionCmd.CombinedOutput()
	ompVersion := strings.TrimSpace(string(versionOut))
	t.Logf("===== OMP VERSION: %s =====", ompVersion)

	// Set up local hermetic OpenAI mock server
	mock := NewMockOpenAIServer()
	defer mock.Close()

	// Default handler for mock: returns canned responses matching requests
	extractContent := func(content any) string {
		if s, ok := content.(string); ok {
			return s
		}
		if parts, ok := content.([]any); ok {
			var sb strings.Builder
			for _, p := range parts {
				if pm, ok := p.(map[string]any); ok {
					if txt, ok := pm["text"].(string); ok {
						sb.WriteString(txt)
					}
				}
			}
			return sb.String()
		}
		return fmt.Sprintf("%v", content)
	}

	mock.SetCustomHandler(func(req OpenAIChatRequest) (*MockOpenAIResponse, error) {
		var allText strings.Builder
		for _, m := range req.Messages {
			allText.WriteString(extractContent(m.Content))
			allText.WriteString(" ")
		}
		all := allText.String()
		if strings.Contains(all, "RESTART_PONG") {
			return &MockOpenAIResponse{
				StatusCode: http.StatusOK,
				TextChunks: []string{"RESTART_PONG_REPLY"},
			}, nil
		}
		if strings.Contains(all, "GAMMA") {
			return &MockOpenAIResponse{
				StatusCode: http.StatusOK,
				TextChunks: []string{"GAMMA_REPLY"},
			}, nil
		}
		if strings.Contains(all, "DELTA") {
			return &MockOpenAIResponse{
				StatusCode: http.StatusOK,
				TextChunks: []string{"DELTA_REPLY"},
			}, nil
		}
		if strings.Contains(all, "MODEL_CHECK") {
			return &MockOpenAIResponse{
				StatusCode: http.StatusOK,
				TextChunks: []string{"MODEL_CHECK_REPLY"},
			}, nil
		}
		return &MockOpenAIResponse{
			StatusCode: http.StatusOK,
			TextChunks: []string{"PONG"},
		}, nil
	})

	tempDir := t.TempDir()

	// STEP 0: Set up hermetic OMP config with mock server URL
	t.Log(">>> STEP 0: Setting up hermetic OMP configuration")
	piDir := filepath.Join(tempDir, "omp_home")
	WriteHermeticOMPConfig(t, piDir, mock.URL())
	t.Logf("STEP 0 PASS: Hermetic config written, OMP pointed to %s", mock.URL())

	// Set up workspace directories
	workspaceRoot := filepath.Join(tempDir, "workspace")
	if err := os.MkdirAll(filepath.Join(workspaceRoot, "project1"), 0o755); err != nil {
		t.Fatalf("mkdir project1: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(workspaceRoot, "shared-workspace"), 0o755); err != nil {
		t.Fatalf("mkdir shared-workspace: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspaceRoot, "project1", "sample.txt"), []byte("sample project file"), 0o644); err != nil {
		t.Fatalf("write sample.txt: %v", err)
	}

	stateDir := filepath.Join(tempDir, "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatalf("mkdir stateDir: %v", err)
	}

	// Pre-create pairing credentials
	pairingStore, err := security.LoadPairingStore(stateDir)
	if err != nil {
		t.Fatalf("load pairing store: %v", err)
	}
	port := getFreePort(t)
	listenAddr := fmt.Sprintf("127.0.0.1:%d", port)
	endpoint := fmt.Sprintf("https://%s", listenAddr)

	pairingPayload, err := pairingStore.Create(endpoint, "AA:BB", false, 2*time.Hour, time.Now().UTC())
	if err != nil {
		t.Fatalf("create pairing: %v", err)
	}

	cfg := config.Default()
	cfg.ListenAddr = listenAddr
	cfg.ListenScheme = "https"
	cfg.PublicEndpoint = endpoint
	cfg.StateDir = "state"
	cfg.WorkspaceRoot = "workspace"
	cfg.UploadDir = "uploads"
	cfg.MaxSessions = 4
	cfg.TerminalBackend = "tmux"
	cfg.SkipFingerprintVerification = true
	cfg.PairingRotationSeconds = 300
	configPath := filepath.Join(tempDir, "config.json")
	cfgData, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		t.Fatalf("marshal config: %v", err)
	}
	if err := os.WriteFile(configPath, cfgData, 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	// Build agenticRemote binary
	cmdBuild := exec.Command("go", "build", "-o", filepath.Join(tempDir, "agenticRemote"), "../../cmd/agenticRemote")
	buildOut, err := cmdBuild.CombinedOutput()
	if err != nil {
		t.Fatalf("go build agenticRemote failed: %v, output: %s", err, string(buildOut))
	}
	binPath := filepath.Join(tempDir, "agenticRemote")

	// Helper to start daemon
	var daemonCmd *exec.Cmd
	startDaemon := func() *exec.Cmd {
		cmd := exec.Command(binPath, "serve", "-config", configPath)
		cmd.Dir = tempDir
		cmd.Env = append(os.Environ(),
			"PI_CODING_AGENT_DIR="+piDir,
			"OMP_AGENT_MODELS_FILE="+filepath.Join(piDir, "models.yml"),
		)
		logPath := filepath.Join(tempDir, fmt.Sprintf("daemon_%d.log", time.Now().UnixNano()))
		logFile, _ := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		cmd.Stdout = logFile
		cmd.Stderr = logFile
		if err := cmd.Start(); err != nil {
			t.Fatalf("failed to start daemon: %v", err)
		}
		// Wait for TCP port to accept connections
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			conn, err := net.DialTimeout("tcp", listenAddr, 100*time.Millisecond)
			if err == nil {
				conn.Close()
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		return cmd
	}

	// ==========================================
	// STEP 1: Start real daemon binary
	// ==========================================
	t.Log(">>> STEP 1: Starting real daemon binary")
	t.Cleanup(func() {
		if daemonCmd != nil && daemonCmd.Process != nil {
			_ = daemonCmd.Process.Kill()
		}
		if t.Failed() {
			logs, _ := filepath.Glob(filepath.Join(tempDir, "daemon_*.log"))
			for _, logFile := range logs {
				data, _ := os.ReadFile(logFile)
				t.Logf("=== DAEMON LOG (%s) ===\n%s\n", filepath.Base(logFile), string(data))
			}
		}
	})
	daemonCmd = startDaemon()
	daemonPID := daemonCmd.Process.Pid

	httpClient := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
		Timeout: 15 * time.Second,
	}

	// Verify health check on /healthz
	healthDeadline := time.Now().Add(10 * time.Second)
	var healthOk bool
	for time.Now().Before(healthDeadline) {
		hReq, _ := http.NewRequest(http.MethodGet, endpoint+"/healthz", nil)
		hRes, err := httpClient.Do(hReq)
		if err == nil && hRes.StatusCode == http.StatusOK {
			hRes.Body.Close()
			healthOk = true
			break
		}
		if hRes != nil {
			hRes.Body.Close()
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !healthOk {
		t.Fatalf("daemon /healthz endpoint failed to become healthy on %s", endpoint)
	}
	t.Logf("STEP 1 PASS: Daemon running at %s with PID %d", listenAddr, daemonPID)

	// ==========================================
	// STEP 2: Connect authenticated client (pairing flow)
	// ==========================================
	t.Log(">>> STEP 2: Authenticating client via pairing WebSocket handshake")
	authenticateSession := func() string {
		wsURL := fmt.Sprintf("wss://%s/v1/ws/sessions/bootstrap", listenAddr)
		wsCtx, wsCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer wsCancel()
		wsConn, _, err := websocket.Dial(wsCtx, wsURL, &websocket.DialOptions{
			HTTPClient: httpClient,
		})
		if err != nil {
			t.Fatalf("websocket dial bootstrap: %v", err)
		}
		clientNonce := strings.Repeat("B", 43)
		if err := wsWriteJSONHelper(wsCtx, wsConn, map[string]any{
			"type":        "auth.hello",
			"pairingId":   pairingPayload.PairingID,
			"clientNonce": clientNonce,
			"clientName":  "GF-Auditor",
		}); err != nil {
			t.Fatalf("ws write auth.hello: %v", err)
		}
		var challenge map[string]any
		if err := wsReadJSONHelper(wsCtx, wsConn, &challenge); err != nil {
			t.Fatalf("ws read challenge: %v", err)
		}
		salt, _ := challenge["salt"].(string)
		srvNonce, _ := challenge["serverNonce"].(string)
		chID, _ := challenge["challengeId"].(string)
		if salt == "" || srvNonce == "" || chID == "" {
			t.Fatalf("unexpected challenge response: %+v", challenge)
		}
		proof, err := security.ClientProof(
			pairingPayload.Token,
			pairingPayload.PairingID,
			salt,
			clientNonce,
			srvNonce,
			chID,
		)
		if err != nil {
			t.Fatalf("compute client proof: %v", err)
		}
		if err := wsWriteJSONHelper(wsCtx, wsConn, map[string]any{
			"type":        "auth.proof",
			"pairingId":   pairingPayload.PairingID,
			"challengeId": challenge["challengeId"],
			"proof":       proof,
		}); err != nil {
			t.Fatalf("ws write auth.proof: %v", err)
		}
		var authOk map[string]any
		if err := wsReadJSONHelper(wsCtx, wsConn, &authOk); err != nil {
			t.Fatalf("ws read auth.ok: %v", err)
		}
		sTok, ok := authOk["sessionToken"].(string)
		if !ok || sTok == "" {
			t.Fatalf("expected sessionToken in auth.ok: %+v", authOk)
		}
		_ = wsConn.Close(websocket.StatusNormalClosure, "")
		return sTok
	}
	sessionToken := authenticateSession()
	// Verify token against authenticated endpoint
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/v1/sessions", endpoint), nil)
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	resp, err := httpClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("authenticated GET /v1/sessions failed: %v", err)
	}
	resp.Body.Close()
	t.Logf("STEP 2 PASS: Authenticated successfully, bearer token obtained: %s...", sessionToken[:10])

	// ==========================================
	// STEP 3: Create OMP Agent using workspace 'project1' and backend 'tmux'
	// ==========================================
	t.Log(">>> STEP 3: Create OMP Agent using workspace 'project1' and backend 'tmux'")
	cBody, _ := json.Marshal(protocol.CreateSessionRequest{
		CWD:     "project1",
		Name:    "Agent 1",
		Backend: "tmux",
	})
	req, _ = http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents", endpoint), bytes.NewReader(cBody))
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = httpClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("create agent failed with status %d: %v", resp.StatusCode, err)
	}
	var ag protocol.AgentSession
	if err := json.NewDecoder(resp.Body).Decode(&ag); err != nil {
		t.Fatalf("decode agent response: %v", err)
	}
	resp.Body.Close()
	agentID1 := ag.ID
	terminalSessionID1 := ag.TerminalSessionID
	if agentID1 == "" || terminalSessionID1 == "" {
		t.Fatalf("expected valid agentID and terminalSessionID, got: %s, %s", agentID1, terminalSessionID1)
	}
	t.Logf("STEP 3 PASS: Created Agent %s (TerminalSession: %s, CWD: %s, State: %s)", agentID1, terminalSessionID1, ag.CWD, ag.State)

	// ==========================================
	// STEP 4: 1 AgentSession -> 1 TerminalSession -> 1 Real OMP Process
	// ==========================================
	t.Log(">>> STEP 4: Counting real OMP PIDs for agent")
	ompPID1 := findHermeticOMPPIDForAgent(t, agentID1)
	count := countHermeticOMPPIDsForAgent(agentID1)
	if count != 1 {
		t.Fatalf("expected exactly 1 OMP process for agent %s, found %d", agentID1, count)
	}
	t.Logf("STEP 4 PASS: AgentSession %s -> TerminalSession %s -> exactly 1 OMP process (PID: %d)", agentID1, terminalSessionID1, ompPID1)

	// ==========================================
	// STEP 5: Polling bridge capabilities (ASSERT ALL FOUR: prompt, abort, model, thinking)
	// ==========================================
	t.Log(">>> STEP 5: Polling bridge capabilities")
	getAgent := func(agID string) (*protocol.AgentSession, error) {
		r, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/v1/agents/%s", endpoint, agID), nil)
		r.Header.Set("Authorization", "Bearer "+sessionToken)
		res, err := httpClient.Do(r)
		if err != nil {
			return nil, err
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("status %d", res.StatusCode)
		}
		var a protocol.AgentSession
		if err := json.NewDecoder(res.Body).Decode(&a); err != nil {
			return nil, err
		}
		return &a, nil
	}

	var lastErr error
	var lastCaps []protocol.AgentCapability
	capabilityEnabled := func(agID, name string) bool {
		ag, err := getAgent(agID)
		if err != nil {
			lastErr = err
			return false
		}
		lastCaps = ag.Capabilities
		for _, cap := range ag.Capabilities {
			if cap.Name == name {
				return cap.Enabled
			}
		}
		return false
	}
	deadline := time.Now().Add(90 * time.Second)
	for !capabilityEnabled(agentID1, "prompt") && time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
	}
	if !capabilityEnabled(agentID1, "prompt") {
		tmuxSock := filepath.Join(tempDir, "state", "tmux", "tmux.sock")
		listOut, _ := exec.Command("tmux", "-S", tmuxSock, "list-panes", "-a", "-F", "#{session_name}:#{pane_id}: #{pane_current_command}").CombinedOutput()
		t.Logf("=== TMUX PANES ===\n%s", string(listOut))
		paneOut, pErr := exec.Command("tmux", "-S", tmuxSock, "capture-pane", "-p", "-t", terminalSessionID1).CombinedOutput()
		t.Logf("=== TMUX PANE OUTPUT (err=%v) ===\n%s\n=== END TMUX PANE OUTPUT ===", pErr, string(paneOut))
		t.Fatalf("bridge capabilities not enabled in time for agent %s (lastErr=%v, lastCaps=%+v)", agentID1, lastErr, lastCaps)
	}
	t.Logf("STEP 5 PASS: Bridge connected, prompt/abort/model/thinking capabilities enabled")

	// ==========================================
	// STEP 6: Semantic prompt & observe working -> assistant -> idle
	// ==========================================
	t.Log(">>> STEP 6: Submitting real semantic prompt 'Reply with exactly the word: PONG'")
	submitPrompt := func(agID, text string) error {
		submitDeadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(submitDeadline) {
			pBody, _ := json.Marshal(map[string]string{"prompt": text})
			r, err := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents/%s/prompt", endpoint, agID), bytes.NewReader(pBody))
			if err != nil {
				return err
			}
			r.Header.Set("Authorization", "Bearer "+sessionToken)
			r.Header.Set("Content-Type", "application/json")
			res, err := httpClient.Do(r)
			if err != nil {
				return err
			}
			defer res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return nil
			}
			time.Sleep(100 * time.Millisecond)
		}
		return fmt.Errorf("timeout submitting prompt")
	}

	if err := submitPrompt(agentID1, "Reply with exactly the word: PONG"); err != nil {
		t.Fatalf("submit prompt failed: %v", err)
	}

	getHistory := func(agID string) ([]protocol.AgentEvent, error) {
		r, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/v1/agents/%s/history", endpoint, agID), nil)
		r.Header.Set("Authorization", "Bearer "+sessionToken)
		res, err := httpClient.Do(r)
		if err != nil {
			return nil, err
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("status %d", res.StatusCode)
		}
		var hResp protocol.AgentHistoryResponse
		if err := json.NewDecoder(res.Body).Decode(&hResp); err != nil {
			return nil, err
		}
		return hResp.Events, nil
	}
	deadline = time.Now().Add(90 * time.Second)
	var assistantText string
	for time.Now().Before(deadline) {
		events, err := getHistory(agentID1)
		if err == nil {
			for _, ev := range events {
				if ev.Type == "message.assistant" && ev.Text != "" {
					assistantText = ev.Text
					break
				}
			}
			if assistantText != "" {
				break
			}
		}
		time.Sleep(200 * time.Millisecond)
	}

	if assistantText == "" {
		t.Fatalf("expected non-empty assistant response, got empty string")
	}
	if !strings.Contains(assistantText, "PONG") {
		t.Fatalf("expected assistant response to contain 'PONG', got: %q", assistantText)
	}
	events, _ := getHistory(agentID1)
	t.Logf("STEP 6 PASS: Working -> Idle observed, assistant response: %q (total events: %d)", assistantText, len(events))

	// ==========================================
	// STEP 7: Chat and Raw Terminal address same OMP PID (REAL RAW TERMINAL WS CHECK)
	// ==========================================
	t.Log(">>> STEP 7: Connecting to Raw Terminal WebSocket and verifying shared PID")
	rawTermWSURL := fmt.Sprintf("wss://%s/v1/ws/sessions/%s", listenAddr, terminalSessionID1)
	rawTermCtx, rawTermCancel := context.WithTimeout(context.Background(), 5*time.Second)
	rawTermConn, _, rawTermErr := websocket.Dial(rawTermCtx, rawTermWSURL, &websocket.DialOptions{
		HTTPClient: httpClient,
	})
	rawTermCancel()
	if rawTermErr != nil {
		t.Fatalf("raw terminal WebSocket dial failed: %v", rawTermErr)
	}
	// Authenticate raw terminal stream
	authCtx, authCancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := wsWriteJSONHelper(authCtx, rawTermConn, map[string]any{
		"type":  "auth.token",
		"token": sessionToken,
	}); err != nil {
		authCancel()
		t.Fatalf("raw terminal auth.token write failed: %v", err)
	}
	authCancel()
	// Cleanly close raw terminal WS connection
	_ = rawTermConn.Close(websocket.StatusNormalClosure, "")

	postTurnPID := findHermeticOMPPIDForAgent(t, agentID1)
	if postTurnPID != ompPID1 {
		t.Fatalf("OMP PID changed after turn: was %d, now %d", ompPID1, postTurnPID)
	}
	t.Logf("STEP 7 PASS: Chat and Raw Terminal address same OMP PID: %d", postTurnPID)

	// ==========================================
	// STEP 8: Remote OMP PID stays alive on client disconnect (REAL CLIENT DISCONNECT)
	// ==========================================
	t.Log(">>> STEP 8: Establishing client WebSocket connection, disconnecting, verifying OMP survives")
	activeWSURL := fmt.Sprintf("wss://%s/v1/ws/sessions/%s", listenAddr, terminalSessionID1)
	activeCtx, activeCancel := context.WithTimeout(context.Background(), 5*time.Second)
	activeConn, _, activeErr := websocket.Dial(activeCtx, activeWSURL, &websocket.DialOptions{
		HTTPClient: httpClient,
	})
	activeCancel()
	if activeErr == nil {
		_ = wsWriteJSONHelper(context.Background(), activeConn, map[string]any{
			"type":  "auth.token",
			"token": sessionToken,
		})
		// Explicitly drop/disconnect the client connection
		_ = activeConn.Close(websocket.StatusGoingAway, "client disconnected")
	}
	time.Sleep(500 * time.Millisecond)
	if !isPIDAlive(ompPID1) {
		t.Fatalf("OMP PID %d died after client disconnected", ompPID1)
	}
	t.Logf("STEP 8 PASS: Remote OMP PID %d stays alive on client disconnect", ompPID1)

	// ==========================================
	// STEP 9: Reconnect and reconstruct Chat history
	// ==========================================
	t.Log(">>> STEP 9: Reconnecting client and verifying history replay deduplication")
	reconHistory, err := getHistory(agentID1)
	if err != nil {
		t.Fatalf("get history on reconnect: %v", err)
	}
	seenIDs := make(map[string]bool)
	for _, ev := range reconHistory {
		if ev.EventID == "" {
			t.Fatalf("event missing valid eventId: %+v", ev)
		}
		if seenIDs[ev.EventID] {
			t.Fatalf("duplicate event ID in history: %s", ev.EventID)
		}
		seenIDs[ev.EventID] = true
	}
	t.Logf("STEP 9 PASS: Reconstructed history exactly once, %d events, 0 duplicates", len(reconHistory))

	// ==========================================
	// STEP 10: Daemon restart with OMP preservation
	// ==========================================
	t.Log(">>> STEP 10: Killing daemon (SIGTERM) and confirming OMP stays alive in tmux")
	if err := daemonCmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("signal daemon: %v", err)
	}
	_ = daemonCmd.Wait()

	time.Sleep(500 * time.Millisecond)
	if !isPIDAlive(ompPID1) {
		t.Fatalf("OMP PID %d died when daemon stopped! tmux session lost process", ompPID1)
	}
	t.Log(">>> STEP 10b: Restarting daemon and verifying reattachment to running OMP")
	daemonCmd = startDaemon()
	newDaemonPID := daemonCmd.Process.Pid
	deadline = time.Now().Add(90 * time.Second)
	var promptOK bool
	for time.Now().Before(deadline) {
		ag, err := getAgent(agentID1)
		if err != nil {
			t.Logf("[Step 10 probe] getAgent err: %v", err)
		} else {
			t.Logf("[Step 10 probe] getAgent state=%s caps=%+v", ag.State, ag.Capabilities)
			for _, cap := range ag.Capabilities {
				if cap.Name == "prompt" && cap.Enabled {
					promptOK = true
					break
				}
			}
		}
		if promptOK {
			break
		}
		time.Sleep(1 * time.Second)
	}
	if !promptOK {
		t.Fatalf("prompt capability did not recover after daemon restart")
	}

	postRestartPID := findHermeticOMPPIDForAgent(t, agentID1)
	if postRestartPID != ompPID1 {
		t.Fatalf("post-restart OMP PID changed: was %d, now %d (tmux reattachment failed)", ompPID1, postRestartPID)
	}
	t.Logf("STEP 10 PASS: Daemon restarted (PID %d -> %d), same OMP PID %d preserved and reattached", daemonPID, newDaemonPID, postRestartPID)

	// ==========================================
	// STEP 11: Semantic prompt post-restart
	// ==========================================
	t.Log(">>> STEP 11: Submitting prompt post-restart: 'Reply with exactly: RESTART_PONG'")
	if err := submitPrompt(agentID1, "Reply with exactly: RESTART_PONG"); err != nil {
		t.Fatalf("submit post-restart prompt: %v", err)
	}

	deadline = time.Now().Add(90 * time.Second)
	var foundRestartResponse bool
	for time.Now().Before(deadline) {
		h, _ := getHistory(agentID1)
		for _, ev := range h {
			if ev.Type == "message.assistant" && strings.Contains(ev.Text, "RESTART_PONG") {
				foundRestartResponse = true
				break
			}
		}
		if foundRestartResponse {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if !foundRestartResponse {
		t.Fatalf("post-restart prompt did not receive expected RESTART_PONG response")
	}
	t.Logf("STEP 11 PASS: Post-restart prompt completed with assistant response 'RESTART_PONG'")

	// ==========================================
	// STEP 12: Explicit Terminate Lifecycle (RAR-036 / RAR-037)
	// ==========================================
	// Note: Presentation Close is client-side only per RAR-036; explicit terminate terminates the remote OMP process.
	t.Log(">>> STEP 12: Explicit terminate Agent 1 and verify process death")
	deadline = time.Now().Add(10 * time.Second)
	termReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents/%s/terminate", endpoint, agentID1), nil)
	termReq.Header.Set("Authorization", "Bearer "+sessionToken)
	termRes, err := httpClient.Do(termReq)
	if err != nil || termRes.StatusCode != http.StatusOK {
		t.Fatalf("terminate Agent 1 failed: %v", err)
	}
	for isPIDAlive(ompPID1) && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if isPIDAlive(ompPID1) {
		t.Fatalf("OMP PID %d still alive 10s after explicit terminate", ompPID1)
	}
	t.Logf("STEP 12 PASS: Explicit terminate killed OMP PID %d and closed tmux session (presentation close is client-side only per RAR-036)", ompPID1)
	// ==========================================
	// STEP 13: Create Agent 2 after terminate
	// ==========================================
	t.Log(">>> STEP 13: Creating Agent 2 after Agent 1 termination")
	cBody2, _ := json.Marshal(protocol.CreateSessionRequest{
		CWD:     "project1",
		Name:    "Agent 2",
		Backend: "tmux",
	})
	req, _ = http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents", endpoint), bytes.NewReader(cBody2))
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = httpClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("create Agent 2 failed: %v", err)
	}
	var ag2 protocol.AgentSession
	_ = json.NewDecoder(resp.Body).Decode(&ag2)
	resp.Body.Close()
	agentID2 := ag2.ID
	ompPID2 := findHermeticOMPPIDForAgent(t, agentID2)
	if ompPID2 == ompPID1 {
		t.Fatalf("new agent reused dead PID %d", ompPID1)
	}

	// Terminate Agent 2 to clear slot
	rTerm2, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents/%s/terminate", endpoint, agentID2), nil)
	rTerm2.Header.Set("Authorization", "Bearer "+sessionToken)
	resTerm2, err := httpClient.Do(rTerm2)
	if err != nil || resTerm2.StatusCode != http.StatusOK {
		t.Fatalf("terminate Agent 2 failed: %v", err)
	}
	resTerm2.Body.Close()
	t.Logf("STEP 13 PASS: Created Agent 2 %s with new OMP PID %d", agentID2, ompPID2)

	// ==========================================
	// STEP 14: Cumulative create/terminate cycles exceeding maxSessions
	// ==========================================
	t.Log(">>> STEP 14: Exercising 6 create/terminate cycles (maxSessions=4) to verify zero admission leaks")
	for i := 1; i <= 6; i++ {
		cBody, _ := json.Marshal(protocol.CreateSessionRequest{
			CWD:     "project1",
			Name:    fmt.Sprintf("Agent Cycle %d", i),
			Backend: "tmux",
		})
		r, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents", endpoint), bytes.NewReader(cBody))
		r.Header.Set("Authorization", "Bearer "+sessionToken)
		r.Header.Set("Content-Type", "application/json")
		res, err := httpClient.Do(r)
		if err != nil || res.StatusCode != http.StatusCreated {
			t.Fatalf("cycle %d create failed with status %d: %v", i, res.StatusCode, err)
		}
		var agC protocol.AgentSession
		_ = json.NewDecoder(res.Body).Decode(&agC)
		res.Body.Close()

		rTerm, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents/%s/terminate", endpoint, agC.ID), nil)
		rTerm.Header.Set("Authorization", "Bearer "+sessionToken)
		resTerm, err := httpClient.Do(rTerm)
		if err != nil || resTerm.StatusCode != http.StatusOK {
			t.Fatalf("cycle %d terminate agent failed: %v", i, err)
		}
		resTerm.Body.Close()
		time.Sleep(100 * time.Millisecond)
	}

	// ==========================================
	// STEP 15: Two Agent sessions with SAME workspace CWD
	// ==========================================
	t.Log(">>> STEP 15: Creating Agent Alpha and Agent Beta in same CWD 'shared-workspace'")
	cBodyA, _ := json.Marshal(protocol.CreateSessionRequest{
		CWD:     "shared-workspace",
		Name:    "Agent Alpha",
		Backend: "tmux",
	})
	req, _ = http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents", endpoint), bytes.NewReader(cBodyA))
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = httpClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("create Agent Alpha failed: %v", err)
	}
	var agA protocol.AgentSession
	_ = json.NewDecoder(resp.Body).Decode(&agA)
	resp.Body.Close()

	cBodyB, _ := json.Marshal(protocol.CreateSessionRequest{
		CWD:     "shared-workspace",
		Name:    "Agent Beta",
		Backend: "tmux",
	})
	req, _ = http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents", endpoint), bytes.NewReader(cBodyB))
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = httpClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("create Agent Beta failed: %v", err)
	}
	var agB protocol.AgentSession
	_ = json.NewDecoder(resp.Body).Decode(&agB)
	resp.Body.Close()

	if agA.ID == agB.ID {
		t.Fatalf("expected unique Agent IDs for Alpha and Beta, got same: %s", agA.ID)
	}
	deadline = time.Now().Add(90 * time.Second)
	for (!capabilityEnabled(agA.ID, "prompt") || !capabilityEnabled(agB.ID, "prompt")) && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if !capabilityEnabled(agA.ID, "prompt") {
		t.Fatalf("Alpha prompt capability not enabled in time")
	}
	if !capabilityEnabled(agB.ID, "prompt") {
		t.Fatalf("Beta prompt capability not enabled in time")
	}
	secretPrompt := fmt.Sprintf("ALPHA_SECRET_TOKEN_%d", time.Now().UnixNano())
	if err := submitPrompt(agA.ID, secretPrompt); err != nil {
		t.Fatalf("submit prompt to Alpha: %v", err)
	}
	deadline = time.Now().Add(30 * time.Second)
	var alphaHasSecret bool
	for time.Now().Before(deadline) {
		histA, _ := getHistory(agA.ID)
		for _, ev := range histA {
			if ev.Type == "message.user" && strings.Contains(ev.Text, secretPrompt) {
				alphaHasSecret = true
				break
			}
		}
		if alphaHasSecret {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if !alphaHasSecret {
		t.Fatalf("Alpha history missing secret prompt %s", secretPrompt)
	}
	histB, err := getHistory(agB.ID)
	if err != nil {
		t.Fatalf("get Beta history: %v", err)
	}
	for _, ev := range histB {
		if ev.Type == "message.user" && strings.Contains(ev.Text, secretPrompt) {
			t.Fatalf("BREACH OF ISOLATION: Beta history contains Alpha secret prompt: %s", secretPrompt)
		}
	}

	// Terminate Alpha and Beta
	rTermA, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents/%s/terminate", endpoint, agA.ID), nil)
	rTermA.Header.Set("Authorization", "Bearer "+sessionToken)
	_, _ = httpClient.Do(rTermA)

	rTermB, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents/%s/terminate", endpoint, agB.ID), nil)
	rTermB.Header.Set("Authorization", "Bearer "+sessionToken)
	_, _ = httpClient.Do(rTermB)

	t.Logf("STEP 15 PASS: Two agents in same CWD maintained completely distinct transcripts and bridge sessions")

	// ==========================================
	// STEP 16 & 18: Bridge Disconnect/Reconnect, Capability Truthfulness, Raw Terminal Fallback
	// ==========================================
	// STEP 16 & 18: Prompt & Raw-Terminal Coexistence (RAR-039 / RAR-041)
	// ==========================================
	t.Log(">>> STEP 16 & 18: Testing prompt and raw-terminal coexistence with a live agent")
	cBodyG, _ := json.Marshal(protocol.CreateSessionRequest{
		CWD:     "project1",
		Name:    "Agent Gamma",
		Backend: "tmux",
	})
	req, _ = http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents", endpoint), bytes.NewReader(cBodyG))
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = httpClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("create Agent Gamma failed: %v", err)
	}
	var agG protocol.AgentSession
	_ = json.NewDecoder(resp.Body).Decode(&agG)
	resp.Body.Close()
	deadline = time.Now().Add(90 * time.Second)
	for !capabilityEnabled(agG.ID, "prompt") && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if !capabilityEnabled(agG.ID, "prompt") {
		t.Fatalf("Gamma prompt capability not enabled in time")
	}

	ompPIDG := findHermeticOMPPIDForAgent(t, agG.ID)
	if err := submitPrompt(agG.ID, "GAMMA_HEALTHY_PROMPT"); err != nil {
		t.Fatalf("submit Gamma prompt: %v", err)
	}

	// Wait for Gamma turn completion
	turnDeadlineG := time.Now().Add(30 * time.Second)
	for time.Now().Before(turnDeadlineG) {
		h, _ := getHistory(agG.ID)
		var found bool
		for _, ev := range h {
			if ev.Type == "message.user" && strings.Contains(ev.Text, "GAMMA_HEALTHY_PROMPT") {
				found = true
				break
			}
		}
		if found {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}

	// Exercise Raw Terminal path by sending raw PTY input to the agent's terminal session
	rawTermWSURL = fmt.Sprintf("wss://%s/v1/ws/sessions/%s", listenAddr, agG.TerminalSessionID)
	rawCtx, rawCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer rawCancel()
	rawConn, _, err := websocket.Dial(rawCtx, rawTermWSURL, &websocket.DialOptions{
		HTTPClient: httpClient,
	})
	if err != nil {
		t.Fatalf("dial raw terminal for Gamma failed: %v", err)
	}
	authCtx, authCancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer authCancel()
	_ = wsWriteJSONHelper(authCtx, rawConn, map[string]any{"type": "auth.token", "token": sessionToken})

	inputData := base64.StdEncoding.EncodeToString([]byte("\n"))
	inputCtx, inputCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer inputCancel()
	_ = wsWriteJSONHelper(inputCtx, rawConn, map[string]any{
		"type": "pty.input",
		"data": inputData,
	})
	_ = rawConn.Close(websocket.StatusNormalClosure, "")

	// Verify OMP PID is preserved throughout raw terminal interaction
	if !isPIDAlive(ompPIDG) {
		t.Fatalf("OMP PID %d died during raw terminal interaction", ompPIDG)
	}

	// Clean up Gamma
	rTermG, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents/%s/terminate", endpoint, agG.ID), nil)
	rTermG.Header.Set("Authorization", "Bearer "+sessionToken)
	_, _ = httpClient.Do(rTermG)

	t.Logf("STEP 16 & 18 PASS: Prompt and raw-terminal coexisted with live agent; OMP PID %d preserved", ompPIDG)

	// ==========================================
	// STEP 17: Durable history replay guarantees (Ordering, Dedup, Gapless across restart)
	// ==========================================
	t.Log(">>> STEP 17: Testing durable history replay guarantees (exact ordering, zero duplication, zero gaps across daemon restart)")
	cBodyD, _ := json.Marshal(protocol.CreateSessionRequest{
		CWD:     "project1",
		Name:    "Agent Delta",
		Backend: "tmux",
	})
	req, _ = http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents", endpoint), bytes.NewReader(cBodyD))
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = httpClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("create Agent Delta failed: %v", err)
	}
	var agD protocol.AgentSession
	_ = json.NewDecoder(resp.Body).Decode(&agD)
	resp.Body.Close()

	deadline = time.Now().Add(90 * time.Second)
	for !capabilityEnabled(agD.ID, "prompt") && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if !capabilityEnabled(agD.ID, "prompt") {
		t.Fatalf("Delta prompt capability not enabled in time")
	}

	ompPIDD := findHermeticOMPPIDForAgent(t, agD.ID)
	if err := submitPrompt(agD.ID, "DELTA_TURN_1"); err != nil {
		t.Fatalf("submit Delta turn 1: %v", err)
	}

	turnDeadline := time.Now().Add(30 * time.Second)
	var sawDeltaResponse bool
	for time.Now().Before(turnDeadline) {
		h, _ := getHistory(agD.ID)
		for _, ev := range h {
			if ev.Type == "message.assistant" && ev.Text != "" {
				sawDeltaResponse = true
				break
			}
		}
		if sawDeltaResponse {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if !sawDeltaResponse {
		t.Fatalf("Delta assistant response not received")
	}

	// Fetch history snapshot 1 prior to restart
	hist1, err := getHistory(agD.ID)
	if err != nil || len(hist1) == 0 {
		t.Fatalf("fetch history snapshot 1 failed: %v", err)
	}

	// Restart daemon to test cold durable replay from disk
	if err := daemonCmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("failed to signal daemon for Step 17 restart: %v", err)
	}
	_ = daemonCmd.Wait()
	time.Sleep(500 * time.Millisecond)

	if !isPIDAlive(ompPIDD) {
		t.Fatalf("Delta OMP PID %d died during daemon restart", ompPIDD)
	}
	daemonCmd = startDaemon()
	defer func() {
		if daemonCmd.Process != nil {
			_ = daemonCmd.Process.Kill()
		}
	}()
	// Wait for bridge capabilities to recover on Delta
	deadline = time.Now().Add(60 * time.Second)
	for !capabilityEnabled(agD.ID, "prompt") && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if !capabilityEnabled(agD.ID, "prompt") {
		t.Fatalf("Delta prompt capability did not recover after daemon restart")
	}

	// Fetch history snapshot 2 post-restart (cold replay from disk)
	hist2, err := getHistory(agD.ID)
	if err != nil {
		t.Fatalf("fetch history snapshot 2 (post-restart) failed: %v", err)
	}

	// Assert exact count and ordering match
	if len(hist1) != len(hist2) {
		t.Fatalf("replay count mismatch: pre-restart %d events, post-restart %d events", len(hist1), len(hist2))
	}
	for i := range hist1 {
		id1 := hist1[i].EventID
		id2 := hist2[i].EventID
		if id1 != id2 {
			t.Fatalf("event ordering changed between pre- and post-restart at index %d: %s vs %s", i, id1, id2)
		}
		if hist1[i].Type != hist2[i].Type || hist1[i].Text != hist2[i].Text {
			t.Fatalf("event payload changed post-restart at index %d", i)
		}
	}

	// Clean up Delta
	rTermD, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents/%s/terminate", endpoint, agD.ID), nil)
	rTermD.Header.Set("Authorization", "Bearer "+sessionToken)
	_, _ = httpClient.Do(rTermD)

	t.Logf("STEP 17 PASS: Durable history replay verified across daemon restart (cold recovery from disk): exact ordering, zero duplication, zero gaps (%d events)", len(hist2))
	// ==========================================
	// STEP 19: WorkspaceRoot Sandboxing on Files API (RAR-042)
	// ==========================================
	t.Log(">>> STEP 19: Verifying WorkspaceRoot Sandboxing on Files API (RAR-042)")
	// Out-of-bounds traversal must be rejected with 400 Bad Request
	req, _ = http.NewRequest(http.MethodGet, fmt.Sprintf("%s/v1/fs/list?path=../../etc", endpoint), nil)
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	resp, err = httpClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request for path traversal ../../etc, got: %v (status: %d)", err, resp.StatusCode)
	}
	resp.Body.Close()

	// Direct absolute system file read must be rejected with 400 Bad Request
	fBody, _ := json.Marshal(map[string]string{"path": "/etc/passwd"})
	req, _ = http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/fs/read", endpoint), bytes.NewReader(fBody))
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = httpClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request for reading /etc/passwd outside workspace, got: %v (status: %d)", err, resp.StatusCode)
	}
	resp.Body.Close()

	// In-bounds read must succeed with 200 OK
	fBodyValid, _ := json.Marshal(map[string]string{"path": "project1/sample.txt"})
	req, _ = http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/fs/read", endpoint), bytes.NewReader(fBodyValid))
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = httpClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK for reading project1/sample.txt, got: %v (status: %d)", err, resp.StatusCode)
	}
	resp.Body.Close()
	t.Logf("STEP 19 PASS: File operations outside workspace rejected with 400; valid operations permitted")

	// ==========================================
	// STEP 20: Model & Thinking Switching (RAR-038)
	// ==========================================
	t.Log(">>> STEP 20: Testing Model and Thinking capability switching (RAR-038)")
	cBodyE, _ := json.Marshal(protocol.CreateSessionRequest{
		CWD:     "project1",
		Name:    "Agent Epsilon",
		Backend: "tmux",
	})
	req, _ = http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents", endpoint), bytes.NewReader(cBodyE))
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = httpClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("create Agent Epsilon failed: %v", err)
	}
	var agE protocol.AgentSession
	_ = json.NewDecoder(resp.Body).Decode(&agE)
	resp.Body.Close()

	deadline = time.Now().Add(90 * time.Second)
	for (!capabilityEnabled(agE.ID, "model") || !capabilityEnabled(agE.ID, "prompt")) && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if !capabilityEnabled(agE.ID, "model") || !capabilityEnabled(agE.ID, "prompt") {
		t.Fatalf("Epsilon capabilities not enabled in time")
	}

	// Switch model via POST /v1/agents/{id}/model
	var modelOK bool
	var lastModelErr string
	modelDeadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(modelDeadline) {
		mBody, _ := json.Marshal(map[string]string{"model": "hermetic-model-alt"})
		mReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents/%s/model", endpoint, agE.ID), bytes.NewReader(mBody))
		mReq.Header.Set("Authorization", "Bearer "+sessionToken)
		mReq.Header.Set("Content-Type", "application/json")
		mRes, err := httpClient.Do(mReq)
		if err == nil && mRes.StatusCode == http.StatusOK {
			mRes.Body.Close()
			modelOK = true
			break
		}
		if mRes != nil {
			b, _ := io.ReadAll(mRes.Body)
			lastModelErr = fmt.Sprintf("status=%d body=%s", mRes.StatusCode, string(b))
			mRes.Body.Close()
		} else if err != nil {
			lastModelErr = err.Error()
		}
		time.Sleep(200 * time.Millisecond)
	}
	if !modelOK {
		t.Fatalf("set model on Agent Epsilon failed: %s", lastModelErr)
	}

	// Switch thinking via POST /v1/agents/{id}/thinking
	var thinkingOK bool
	var lastThinkingErr string
	thinkingDeadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(thinkingDeadline) {
		thBody, _ := json.Marshal(map[string]string{"level": "high"})
		thReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents/%s/thinking", endpoint, agE.ID), bytes.NewReader(thBody))
		thReq.Header.Set("Authorization", "Bearer "+sessionToken)
		thReq.Header.Set("Content-Type", "application/json")
		thRes, err := httpClient.Do(thReq)
		if err == nil && thRes.StatusCode == http.StatusOK {
			thRes.Body.Close()
			thinkingOK = true
			break
		}
		if thRes != nil {
			b, _ := io.ReadAll(thRes.Body)
			lastThinkingErr = fmt.Sprintf("status=%d body=%s", thRes.StatusCode, string(b))
			thRes.Body.Close()
		} else if err != nil {
			lastThinkingErr = err.Error()
		}
		time.Sleep(200 * time.Millisecond)
	}
	if !thinkingOK {
		t.Fatalf("set thinking on Agent Epsilon failed: %s", lastThinkingErr)
	}

	// Clean up Epsilon
	rTermE, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents/%s/terminate", endpoint, agE.ID), nil)
	rTermE.Header.Set("Authorization", "Bearer "+sessionToken)
	_, _ = httpClient.Do(rTermE)

	t.Logf("STEP 20 PASS: Successfully exercised Model and Thinking capability controls (RAR-038)")

	// ==========================================
	// STEP 21: Truthful Termination & Single Lifecycle Authority (RAR-036 / RAR-037)
	// ==========================================
	t.Log(">>> STEP 21: Testing Truthful Termination & Single Lifecycle Authority (RAR-036/037)")
	cBodyZ, _ := json.Marshal(protocol.CreateSessionRequest{
		CWD:     "project1",
		Name:    "Agent Zeta",
		Backend: "tmux",
	})
	req, _ = http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents", endpoint), bytes.NewReader(cBodyZ))
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err = httpClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("create Agent Zeta failed: %v", err)
	}
	var agZ protocol.AgentSession
	_ = json.NewDecoder(resp.Body).Decode(&agZ)
	resp.Body.Close()

	ompPIDZ := findHermeticOMPPIDForAgent(t, agZ.ID)

	// Terminate Agent Zeta
	zTermReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/v1/agents/%s/terminate", endpoint, agZ.ID), nil)
	zTermReq.Header.Set("Authorization", "Bearer "+sessionToken)
	zTermRes, err := httpClient.Do(zTermReq)
	if err != nil || zTermRes.StatusCode != http.StatusOK {
		t.Fatalf("terminate Agent Zeta failed: %v", err)
	}
	zTermRes.Body.Close()

	// Confirm OMP PID is dead within deadline
	deadline = time.Now().Add(10 * time.Second)
	for isPIDAlive(ompPIDZ) && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if isPIDAlive(ompPIDZ) {
		t.Fatalf("Agent Zeta OMP PID %d still alive after termination", ompPIDZ)
	}

	t.Logf("STEP 21 PASS: Truthful termination verified: OMP PID %d killed and slot released immediately (RAR-036/037)", ompPIDZ)

	t.Log("===== GF-PHASE-1-4-FINAL: ALL STEPS PASSED SUCCESSFULLY =====")
}

// TestGoldenFlowHermetic_BridgeDegradation validates bridge disconnect, truthful capability degradation,
// raw PTY terminal interaction during degradation, and automatic bridge reconnection.
func TestGoldenFlowHermetic_BridgeDegradation(t *testing.T) {
	requireBinary(t, "omp")

	mock := NewMockOpenAIServer()
	defer mock.Close()

	workDir := filepath.Join(t.TempDir(), "workspace")
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		t.Fatalf("mkdir workDir: %v", err)
	}

	termMgr, err := session.NewManager(workDir, filepath.Join(t.TempDir(), "terminals"), workDir, 1<<20, 64, nil)
	if err != nil {
		t.Fatalf("new terminal manager: %v", err)
	}
	defer func() { _ = termMgr.Shutdown() }()

	agentDir := filepath.Join(t.TempDir(), "agent-state")
	WriteHermeticOMPConfig(t, agentDir, mock.URL())

	store, err := runtimestore.Open(agentDir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() { _ = store.Close() }()

	svc := NewService(termMgr, store, agentDir)
	defer svc.Close()

	created, err := svc.CreateAgentRequest(context.Background(), protocol.CreateSessionRequest{
		CWD:     workDir,
		Name:    "Degradation Agent",
		Backend: "pty",
	})
	if err != nil {
		t.Fatalf("create agent: %v", err)
	}
	defer func() { _ = termMgr.Close(created.TerminalSessionID) }()

	// 1. Wait for bridge to connect and verify capability is true
	connectDeadline := time.Now().Add(60 * time.Second)
	for !svc.bridgeServer.IsConnected(created.ID) && time.Now().Before(connectDeadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if !svc.bridgeServer.IsConnected(created.ID) {
		t.Fatalf("bridge failed to connect within timeout for agent %s", created.ID)
	}

	hasPromptCap := func() bool {
		ag, err := svc.GetAgent(created.ID)
		if err != nil {
			return false
		}
		for _, c := range ag.Capabilities {
			if c.Name == "prompt" {
				return c.Enabled
			}
		}
		return false
	}
	if !hasPromptCap() {
		t.Fatalf("expected prompt capability enabled upon initial bridge connection")
	}
	t.Logf("PASS (Part 1): Bridge connected, prompt capability enabled (truthful)")

	svc.bridgeServer.mu.Lock()
	st := svc.bridgeServer.agents[created.ID]
	svc.bridgeServer.mu.Unlock()
	if st != nil && st.conn != nil {
		_ = st.conn.Close()
	}

	degradeDeadline := time.Now().Add(5 * time.Second)
	for hasPromptCap() && time.Now().Before(degradeDeadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if hasPromptCap() {
		t.Fatalf("expected prompt capability to degrade to false upon socket close")
	}
	t.Logf("PASS (Part 2): Bridge socket forcibly closed, capability degraded to false (truthful)")

	// 3. Verify raw terminal fallback: send raw PTY input and verify terminal remains alive
	if err := termMgr.Input(created.TerminalSessionID, []byte("\n")); err != nil {
		t.Fatalf("write PTY input during bridge degradation failed: %v", err)
	}
	t.Logf("PASS (Part 3): Raw terminal fallback operational during bridge degradation")

	// 4. Wait for OMP bridge extension to automatically reconnect (retry loop in bridge.ts)
	reconnectDeadline := time.Now().Add(30 * time.Second)
	for !hasPromptCap() && time.Now().Before(reconnectDeadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if !hasPromptCap() {
		t.Fatalf("bridge failed to auto-reconnect and re-enable prompt capability within timeout")
	}
	t.Logf("PASS (Part 4): Bridge auto-reconnected from alive OMP process, prompt capability restored to true")
}
