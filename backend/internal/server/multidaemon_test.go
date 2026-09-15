package server_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/config"
	"github.com/agenticremote/agenticremote/backend/internal/protocol"
	"github.com/agenticremote/agenticremote/backend/internal/security"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	_ "github.com/glebarez/go-sqlite"
)

type testDaemon struct {
	cmd       *exec.Cmd
	dir       string
	stateDir  string
	workDir   string
	cfgPath   string
	port      int
	baseURL   string
	token     string
	pairingID string
}

func getFreePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("getFreePort failed: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	return port
}

func buildDaemonBinary(t *testing.T) string {
	t.Helper()
	binPath := filepath.Join(t.TempDir(), "agenticRemote")
	cmd := exec.Command("go", "build", "-o", binPath, "../../cmd/agenticRemote")
	cmd.Dir = "."
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("go build failed: %v\noutput: %s", err, string(out))
	}
	return binPath
}

func startTestDaemon(t *testing.T, binPath, name string) *testDaemon {
	t.Helper()
	dir := t.TempDir()
	stateDir := filepath.Join(dir, "state")
	workDir := filepath.Join(dir, "workspace")
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		t.Fatal(err)
	}

	port := getFreePort(t)
	cfg := config.Default()
	cfg.ListenAddr = fmt.Sprintf("127.0.0.1:%d", port)
	cfg.PublicEndpoint = fmt.Sprintf("https://127.0.0.1:%d", port)
	cfg.StateDir = "state"
	cfg.WorkspaceRoot = "workspace"
	cfg.SkipFingerprintVerification = true
	cfg.PairingPageUsername = "admin"
	cfg.PairingPagePassword = "password"
	cfg.TerminalBackend = "pty"
	cfgPath := filepath.Join(dir, "config.json")
	cfgData, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfgPath, cfgData, 0o600); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(binPath, "serve", "--config", cfgPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var logBuf bytes.Buffer
	cmd.Stdout = &logBuf
	cmd.Stderr = &logBuf

	if err := cmd.Start(); err != nil {
		t.Fatalf("start daemon %s failed: %v", name, err)
	}

	d := &testDaemon{
		cmd:      cmd,
		dir:      dir,
		stateDir: stateDir,
		workDir:  workDir,
		cfgPath:  cfgPath,
		port:     port,
		baseURL:  fmt.Sprintf("http://127.0.0.1:%d", port),
	}

	// Wait for daemon to be ready on /pairing
	deadline := time.Now().Add(10 * time.Second)
	ready := false
	client := &http.Client{Timeout: 1 * time.Second}
	for time.Now().Before(deadline) {
		req, _ := http.NewRequest(http.MethodGet, d.baseURL+"/pairing", nil)
		req.SetBasicAuth("admin", "password")
		resp, err := client.Do(req)
		if err == nil {
			body, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK && strings.Contains(string(body), "payload-json") {
				ready = true
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}

	if !ready {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		t.Fatalf("daemon %s did not become ready in 10s. Logs:\n%s", name, logBuf.String())
	}
	t.Cleanup(func() {
		if d.cmd != nil && d.cmd.Process != nil {
			_ = syscall.Kill(-d.cmd.Process.Pid, syscall.SIGKILL)
			_ = d.cmd.Process.Kill()
		}
	})
	return d
}

func pairDaemon(t *testing.T, d *testDaemon) {
	t.Helper()
	// 1. Fetch pairing payload from /pairing
	req, err := http.NewRequest(http.MethodGet, d.baseURL+"/pairing", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.SetBasicAuth("admin", "password")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("failed to fetch /pairing: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}

	re := regexp.MustCompile(`<pre id="payload-json">([\s\S]*?)</pre>`)
	matches := re.FindSubmatch(body)
	if len(matches) < 2 {
		t.Fatalf("pairing payload not found in HTML: %s", string(body))
	}
	rawJSON := html.UnescapeString(string(matches[1]))

	var payload struct {
		PairingID string `json:"pairingId"`
		Token     string `json:"token"`
	}
	if err := json.Unmarshal([]byte(rawJSON), &payload); err != nil {
		t.Fatalf("failed to unmarshal pairing JSON (%s): %v", rawJSON, err)
	}

	// 2. Perform WebSocket bootstrap handshake
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := fmt.Sprintf("ws://127.0.0.1:%d/v1/ws/sessions/bootstrap", d.port)
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("failed to dial bootstrap WS %s: %v", wsURL, err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	clientNonce := strings.Repeat("A", 43)
	if err := wsjson.Write(ctx, conn, map[string]any{
		"type":        "auth.hello",
		"pairingId":   payload.PairingID,
		"clientNonce": clientNonce,
		"clientName":  "test-verifier",
	}); err != nil {
		t.Fatalf("ws write auth.hello failed: %v", err)
	}

	var challenge struct {
		Type        string `json:"type"`
		ChallengeID string `json:"challengeId"`
		Salt        string `json:"salt"`
		ServerNonce string `json:"serverNonce"`
	}
	if err := wsjson.Read(ctx, conn, &challenge); err != nil {
		t.Fatalf("ws read challenge failed: %v", err)
	}

	proof, err := security.ClientProof(payload.Token, payload.PairingID, challenge.Salt, clientNonce, challenge.ServerNonce, challenge.ChallengeID)
	if err != nil {
		t.Fatalf("compute proof failed: %v", err)
	}

	if err := wsjson.Write(ctx, conn, map[string]any{
		"type":        "auth.proof",
		"pairingId":   payload.PairingID,
		"challengeId": challenge.ChallengeID,
		"proof":       proof,
	}); err != nil {
		t.Fatalf("ws write auth.proof failed: %v", err)
	}

	var okResp struct {
		Type         string `json:"type"`
		SessionToken string `json:"sessionToken"`
	}
	if err := wsjson.Read(ctx, conn, &okResp); err != nil {
		t.Fatalf("ws read auth.ok failed: %v", err)
	}
	if okResp.SessionToken == "" {
		t.Fatalf("empty session token received")
	}

	d.token = okResp.SessionToken
	d.pairingID = payload.PairingID
}

type runtimeEventsPayload struct {
	Events []struct {
		Cursor    int64  `json:"cursor"`
		SurfaceID string `json:"surfaceId"`
		Kind      string `json:"kind"`
	} `json:"events"`
	Cursor int64 `json:"cursor"`
}

func TestMultiDaemonIsolation(t *testing.T) {
	// Build binary
	binPath := buildDaemonBinary(t)

	// Step 1: Start TWO separate instances of the real compiled daemon binary
	dA := startTestDaemon(t, binPath, "DaemonA")
	dB := startTestDaemon(t, binPath, "DaemonB")

	pidA := dA.cmd.Process.Pid
	pidB := dB.cmd.Process.Pid
	t.Logf("Daemon A running at %s (PID: %d, state: %s)", dA.baseURL, pidA, dA.stateDir)
	t.Logf("Daemon B running at %s (PID: %d, state: %s)", dB.baseURL, pidB, dB.stateDir)

	if pidA == pidB {
		t.Fatalf("PIDs must be distinct: PID A = %d, PID B = %d", pidA, pidB)
	}
	if dA.port == dB.port {
		t.Fatalf("Ports must be distinct: Port A = %d, Port B = %d", dA.port, dB.port)
	}

	// Step 2: Establish independent authenticated bearer tokens
	pairDaemon(t, dA)
	pairDaemon(t, dB)

	t.Logf("Bearer Token A: %s (pairingId: %s)", dA.token, dA.pairingID)
	t.Logf("Bearer Token B: %s (pairingId: %s)", dB.token, dB.pairingID)

	if dA.token == dB.token {
		t.Fatalf("Tokens must be distinct: Token A = %s, Token B = %s", dA.token, dB.token)
	}

	client := &http.Client{Timeout: 5 * time.Second}

	// Step 3: Create an Agent session on Daemon A and an Agent session on Daemon B
	createAgent := func(d *testDaemon, name string) *protocol.AgentSession {
		reqBody, _ := json.Marshal(protocol.CreateSessionRequest{
			Name:    name,
			CWD:     d.workDir,
			Backend: "pty",
		})
		req, _ := http.NewRequest(http.MethodPost, d.baseURL+"/v1/agents", bytes.NewReader(reqBody))
		req.Header.Set("Authorization", "Bearer "+d.token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("failed to create agent on %s: %v", d.baseURL, err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusCreated {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("create agent on %s expected 201, got %d: %s", d.baseURL, resp.StatusCode, string(body))
		}
		var sess protocol.AgentSession
		if err := json.NewDecoder(resp.Body).Decode(&sess); err != nil {
			t.Fatalf("decode agent session failed: %v", err)
		}
		return &sess
	}

	agentA := createAgent(dA, "agent-A-1")
	agentB := createAgent(dB, "agent-B-1")

	t.Logf("Agent A created: ID=%s TerminalID=%s Adapter=%s", agentA.ID, agentA.TerminalSessionID, agentA.Adapter)
	t.Logf("Agent B created: ID=%s TerminalID=%s Adapter=%s", agentB.ID, agentB.TerminalSessionID, agentB.Adapter)

	// Step 4: Prove Isolation Properties

	// 4a: Cross-daemon auth isolation (Token A rejected by Daemon B, Token B rejected by Daemon A)
	{
		// Token A against Daemon B
		req, _ := http.NewRequest(http.MethodGet, dB.baseURL+"/v1/agents", nil)
		req.Header.Set("Authorization", "Bearer "+dA.token)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("Expected 401 Unauthorized using Token A on Daemon B, got %d", resp.StatusCode)
		}
		t.Logf("PASS 4a: Daemon A token on Daemon B returned HTTP %d Unauthorized", resp.StatusCode)

		// Token B against Daemon A
		req, _ = http.NewRequest(http.MethodGet, dA.baseURL+"/v1/agents", nil)
		req.Header.Set("Authorization", "Bearer "+dB.token)
		resp, err = client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("Expected 401 Unauthorized using Token B on Daemon A, got %d", resp.StatusCode)
		}
		t.Logf("PASS 4a: Daemon B token on Daemon A returned HTTP %d Unauthorized", resp.StatusCode)
	}

	// 4b: Runtime event cursor sequence independence
	{
		getEvents := func(d *testDaemon) runtimeEventsPayload {
			req, _ := http.NewRequest(http.MethodGet, d.baseURL+"/v1/runtime/events?after=0&limit=50", nil)
			req.Header.Set("Authorization", "Bearer "+d.token)
			resp, err := client.Do(req)
			if err != nil {
				t.Fatalf("failed to get events from %s: %v", d.baseURL, err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				body, _ := io.ReadAll(resp.Body)
				t.Fatalf("get events expected 200, got %d: %s", resp.StatusCode, string(body))
			}
			var eventsResp runtimeEventsPayload
			if err := json.NewDecoder(resp.Body).Decode(&eventsResp); err != nil {
				t.Fatalf("decode events failed: %v", err)
			}
			return eventsResp
		}

		eventsA := getEvents(dA)
		eventsB := getEvents(dB)

		t.Logf("Daemon A runtime events count: %d, cursor: %d", len(eventsA.Events), eventsA.Cursor)
		t.Logf("Daemon B runtime events count: %d, cursor: %d", len(eventsB.Events), eventsB.Cursor)

		if len(eventsA.Events) == 0 || len(eventsB.Events) == 0 {
			t.Fatalf("Both daemons should have recorded local runtime events")
		}
		if eventsA.Events[0].Cursor != 1 || eventsB.Events[0].Cursor != 1 {
			t.Fatalf("Both daemons must start monotonic sequence at 1: A.cursor=%d, B.cursor=%d", eventsA.Events[0].Cursor, eventsB.Events[0].Cursor)
		}
		t.Logf("PASS 4b: Both daemons start independent monotonic cursor sequences at Cursor=1")
	}

	// 4c: Agent IDs isolation
	{
		listAgents := func(d *testDaemon) []protocol.AgentSession {
			req, _ := http.NewRequest(http.MethodGet, d.baseURL+"/v1/agents", nil)
			req.Header.Set("Authorization", "Bearer "+d.token)
			resp, err := client.Do(req)
			if err != nil {
				t.Fatalf("failed to list agents from %s: %v", d.baseURL, err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("list agents expected 200, got %d", resp.StatusCode)
			}
			var agents []protocol.AgentSession
			if err := json.NewDecoder(resp.Body).Decode(&agents); err != nil {
				t.Fatalf("decode list agents failed: %v", err)
			}
			return agents
		}

		agentsA := listAgents(dA)
		agentsB := listAgents(dB)

		foundAonA := false
		for _, a := range agentsA {
			if a.ID == agentA.ID {
				foundAonA = true
			}
			if a.ID == agentB.ID {
				t.Fatalf("LEAK: Agent B ID (%s) found in Daemon A list!", agentB.ID)
			}
		}
		if !foundAonA {
			t.Fatalf("Agent A ID (%s) not found in Daemon A list", agentA.ID)
		}

		foundBonB := false
		for _, b := range agentsB {
			if b.ID == agentB.ID {
				foundBonB = true
			}
			if b.ID == agentA.ID {
				t.Fatalf("LEAK: Agent A ID (%s) found in Daemon B list!", agentA.ID)
			}
		}
		if !foundBonB {
			t.Fatalf("Agent B ID (%s) not found in Daemon B list", agentB.ID)
		}

		t.Logf("PASS 4c: Agent IDs strictly isolated between Daemon A and Daemon B")
	}

	// 4d: Terminal IDs isolation
	{
		listSessions := func(d *testDaemon) []protocol.SessionSummary {
			req, _ := http.NewRequest(http.MethodGet, d.baseURL+"/v1/sessions", nil)
			req.Header.Set("Authorization", "Bearer "+d.token)
			resp, err := client.Do(req)
			if err != nil {
				t.Fatalf("failed to list sessions: %v", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("list sessions expected 200, got %d", resp.StatusCode)
			}
			var sessions []protocol.SessionSummary
			if err := json.NewDecoder(resp.Body).Decode(&sessions); err != nil {
				t.Fatalf("decode sessions failed: %v", err)
			}
			return sessions
		}

		sessionsA := listSessions(dA)
		sessionsB := listSessions(dB)

		for _, s := range sessionsA {
			if s.ID == agentB.TerminalSessionID {
				t.Fatalf("LEAK: Terminal B ID (%s) found in Daemon A sessions!", agentB.TerminalSessionID)
			}
		}
		for _, s := range sessionsB {
			if s.ID == agentA.TerminalSessionID {
				t.Fatalf("LEAK: Terminal A ID (%s) found in Daemon B sessions!", agentA.TerminalSessionID)
			}
		}

		t.Logf("PASS 4d: Terminal IDs strictly isolated between Daemon A and Daemon B")
	}

	// 4e: Agent history endpoint isolation
	{
		// Query history for Agent A on Daemon A -> 200 OK
		req, _ := http.NewRequest(http.MethodGet, dA.baseURL+"/v1/agents/"+agentA.ID+"/history", nil)
		req.Header.Set("Authorization", "Bearer "+dA.token)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("Agent A history on Daemon A expected 200, got %d", resp.StatusCode)
		}

		// Query history for Agent A on Daemon B -> 404 Not Found
		req, _ = http.NewRequest(http.MethodGet, dB.baseURL+"/v1/agents/"+agentA.ID+"/history", nil)
		req.Header.Set("Authorization", "Bearer "+dB.token)
		resp, err = client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("Agent A history on Daemon B expected 404, got %d", resp.StatusCode)
		}

		// Query history for Agent B on Daemon A -> 404 Not Found
		req, _ = http.NewRequest(http.MethodGet, dA.baseURL+"/v1/agents/"+agentB.ID+"/history", nil)
		req.Header.Set("Authorization", "Bearer "+dA.token)
		resp, err = client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("Agent B history on Daemon A expected 404, got %d", resp.StatusCode)
		}

		t.Logf("PASS 4e: Cross-daemon history query returned 404 Not Found with zero leakage")
	}

	// 4f: SQLite runtime store file and data separation
	{
		dbPathA := filepath.Join(dA.stateDir, "runtime.db")
		dbPathB := filepath.Join(dB.stateDir, "runtime.db")

		if dbPathA == dbPathB {
			t.Fatalf("SQLite database paths must be distinct: %s vs %s", dbPathA, dbPathB)
		}
		if _, err := os.Stat(dbPathA); err != nil {
			t.Fatalf("Daemon A SQLite db not found: %v", err)
		}
		if _, err := os.Stat(dbPathB); err != nil {
			t.Fatalf("Daemon B SQLite db not found: %v", err)
		}

		// Inspect DB A
		dbA, err := sql.Open("sqlite", dbPathA)
		if err != nil {
			t.Fatalf("open dbA failed: %v", err)
		}
		var countA int
		if err := dbA.QueryRow("SELECT COUNT(*) FROM agent_sessions WHERE id = ?", agentA.ID).Scan(&countA); err != nil || countA != 1 {
			t.Fatalf("dbA should contain agentA: count=%d err=%v", countA, err)
		}
		var leakA int
		if err := dbA.QueryRow("SELECT COUNT(*) FROM agent_sessions WHERE id = ?", agentB.ID).Scan(&leakA); err != nil || leakA != 0 {
			t.Fatalf("LEAK: dbA contains agentB: count=%d", leakA)
		}

		// Inspect DB B
		dbB, err := sql.Open("sqlite", dbPathB)
		if err != nil {
			t.Fatalf("open dbB failed: %v", err)
		}
		defer dbB.Close()

		var countB int
		if err := dbB.QueryRow("SELECT COUNT(*) FROM agent_sessions WHERE id = ?", agentB.ID).Scan(&countB); err != nil || countB != 1 {
			t.Fatalf("dbB should contain agentB: count=%d err=%v", countB, err)
		}
		var leakB int
		if err := dbB.QueryRow("SELECT COUNT(*) FROM agent_sessions WHERE id = ?", agentA.ID).Scan(&leakB); err != nil || leakB != 0 {
			t.Fatalf("LEAK: dbB contains agentA: count=%d", leakB)
		}
		t.Logf("PASS 4f: SQLite stores are isolated files (%s and %s) with 0 shared rows", dbPathA, dbPathB)
	}

	// Step 5: Reconnect to Daemon A and verify Daemon B is completely unaffected
	{
		t.Logf("Testing reconnection to Daemon A...")
		// Open a fresh WebSocket runtime subscription connection to Daemon A
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		connA, _, err := websocket.Dial(ctx, fmt.Sprintf("ws://127.0.0.1:%d/v1/ws/runtime", dA.port), nil)
		if err != nil {
			t.Fatalf("failed to dial runtime ws on A: %v", err)
		}
		if err := wsjson.Write(ctx, connA, protocol.AuthToken{Type: "auth.token", Token: dA.token}); err != nil {
			t.Fatal(err)
		}
		if err := wsjson.Write(ctx, connA, protocol.ChannelOpenEnvelope{Type: "channel.open", RequestID: "req-1", ChannelID: "ch-1", Kind: "runtime", TargetID: "runtime", After: 0}); err != nil {
			t.Fatal(err)
		}
		_ = connA.Close(websocket.StatusNormalClosure, "")

		// Verify Daemon B's agent is still alive and responsive
		req, _ := http.NewRequest(http.MethodGet, dB.baseURL+"/v1/agents/"+agentB.ID, nil)
		req.Header.Set("Authorization", "Bearer "+dB.token)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("Daemon B agent check failed: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("Daemon B agent expected 200 during Daemon A reconnect, got %d", resp.StatusCode)
		}
		var currentAgentB protocol.AgentSession
		if err := json.NewDecoder(resp.Body).Decode(&currentAgentB); err != nil {
			t.Fatal(err)
		}
		if currentAgentB.ID != agentB.ID {
			t.Fatalf("Daemon B agent mismatch: %s != %s", currentAgentB.ID, agentB.ID)
		}

		t.Logf("PASS 5: Fresh client connection to Daemon A did not disrupt Daemon B (Agent B remains healthy)")
	}

	// Step 6: Stop Daemon A entirely (kill process) and confirm Daemon B remains fully unaffected and operational
	{
		t.Logf("Stopping Daemon A (PID %d)...", dA.cmd.Process.Pid)
		pidToKill := dA.cmd.Process.Pid
		_ = syscall.Kill(-pidToKill, syscall.SIGKILL)
		_ = dA.cmd.Process.Kill()
		dA.cmd = nil
		deadReq, _ := http.NewRequest(http.MethodGet, dA.baseURL+"/v1/agents", nil)
		deadReq.Header.Set("Authorization", "Bearer "+dA.token)
		deadResp, deadErr := client.Do(deadReq)
		if deadErr == nil {
			_ = deadResp.Body.Close()
			t.Fatalf("Daemon A should be dead but answered with status %d", deadResp.StatusCode)
		}
		t.Logf("Daemon A is stopped and unreachable (%v)", deadErr)

		// Create another Agent session on Daemon B
		agentB2 := createAgent(dB, "agent-B-2-after-A-kill")
		t.Logf("Agent B2 created on Daemon B after Daemon A kill: ID=%s Adapter=%s", agentB2.ID, agentB2.Adapter)

		// Submit a prompt to Agent B2 on Daemon B
		promptBody, _ := json.Marshal(map[string]string{"prompt": "echo multi-daemon isolation test"})
		promptReq, _ := http.NewRequest(http.MethodPost, dB.baseURL+"/v1/agents/"+agentB2.ID+"/prompt", bytes.NewReader(promptBody))
		promptReq.Header.Set("Authorization", "Bearer "+dB.token)
		promptReq.Header.Set("Content-Type", "application/json")
		promptResp, err := client.Do(promptReq)
		if err != nil {
			t.Fatalf("Prompt request to Daemon B failed: %v", err)
		}
		defer promptResp.Body.Close()
		// When OMP bridge is not running full TUI, prompt returns 400 needs_terminal or 200 OK
		if promptResp.StatusCode != http.StatusOK && promptResp.StatusCode != http.StatusBadRequest {
			body, _ := io.ReadAll(promptResp.Body)
			t.Fatalf("Prompt submission unexpected status %d: %s", promptResp.StatusCode, string(body))
		}
		// Verify history on Daemon B
		time.Sleep(200 * time.Millisecond)
		histReq, _ := http.NewRequest(http.MethodGet, dB.baseURL+"/v1/agents/"+agentB2.ID+"/history", nil)
		histReq.Header.Set("Authorization", "Bearer "+dB.token)
		histResp, err := client.Do(histReq)
		if err != nil {
			t.Fatalf("History query on Daemon B failed: %v", err)
		}
		defer histResp.Body.Close()
		if histResp.StatusCode != http.StatusOK {
			t.Fatalf("History query expected 200, got %d", histResp.StatusCode)
		}

		t.Logf("PASS 6: Daemon B remains fully operational and responsive after Daemon A was killed")
	}

	// Step 7: Cleanup
	t.Logf("Cleaning up Daemon B (PID %d)...", dB.cmd.Process.Pid)
	pidBToKill := dB.cmd.Process.Pid
	_ = syscall.Kill(-pidBToKill, syscall.SIGKILL)
	_ = dB.cmd.Process.Kill()
	dB.cmd = nil
	t.Logf("PASS 7: Cleaned up all processes successfully")
}
