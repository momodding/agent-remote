# GoldenFlow False-Positive Audit Report

**Date:** 2026-09-16  
**Audited File:** `backend/internal/agent/goldenflow_test.go`  
**Target Test Functions:** `TestGoldenFlowPhase1to4` (Lines 136–939), `TestRealDaemonRestartTmuxCapacityOwnership` (Lines 946–1265)

---

## Executive Summary

An exhaustive line-by-line audit of `backend/internal/agent/goldenflow_test.go` identified multiple false-positive `PASS` log statements, overclaims, and skipped verification steps where log output asserted guarantees that were never tested or asserted by code:

1. **CRITICAL / Severe False Positives:**
   - **STEP 17 (Lines 879–885):** Zero executable code. Directly logged `STEP 17 PASS: Verified durable history replay guarantees` under the rationalization that unit tests in `store_test.go` cover it.
   - **STEP 16 & 18 (Lines 824–878):** Logged `STEP 16 & 18 PASS: Bridge capabilities reported truthfully matching connection state; OMP PID preserved` after only sending a normal prompt to a healthy agent ("Agent Gamma"). Zero bridge disconnects, zero capability degradation checks, zero raw terminal fallback checks, and zero reconnect assertions were executed.

2. **Significant False Positives / Fabricated Claims:**
   - **STEP 7 (Lines 525–534):** Logged `STEP 7 PASS: Chat and Raw Terminal address same OMP PID` without ever touching or connecting to the Raw Terminal WebSocket/HTTP endpoints.
   - **STEP 8 (Lines 535–545):** Logged `STEP 8 PASS: Remote OMP PID stays alive on client disconnect` after only sleeping for 1 second (`time.Sleep(1 * time.Second)`), without simulating client connection drop or disconnect/reconnect lifecycle.

3. **Minor Overclaims / Missing Assertions:**
   - **STEP 5 (Lines 386–428):** Logged `prompt/abort/model/thinking capabilities enabled`, but polling only checked `capabilityEnabled(agentID1, "prompt")` and skipped checking `abort`, `model`, and `thinking`.
   - **STEP 6 (Lines 430–524):** Poll loop breaks on `ag.State == "idle"`, but post-loop log prints `assistant response: %q` without asserting non-empty content or expected "PONG" token.
   - **STEP 12 (Lines 630–656):** Header claimed "Close Presentation vs Explicit Terminate", but only executed explicit terminate.

4. **Genuine & Thorough Steps (Verified True Positives):**
   - **STEPS 1, 2, 3, 4, 10, 11, 13, 14, 15, 19** and `TestRealDaemonRestartTmuxCapacityOwnership` (RAR-034) contain genuine, rigorous assertions covering daemon bootstrapping, pairing auth, 1:1 PID mapping, daemon crash/restart survivability, post-restart turns, multi-cycle capacity releases, CWD isolation between concurrent agents, filesystem sandbox traversal rejections, and admission limit ownership after restart.

---

## Detailed Step-by-Step Findings

### Step 1: Start real daemon binary (Lines 250–267)
- **Log Statement:** `STEP 1 PASS: Daemon running at %s with PID %d`
- **Preceding Assertions:** Starts binary with `exec.Command`, polls `/v1/health` with HTTPS client until 200 OK.
- **Classification:** **TRUE POSITIVE** (Verified)

### Step 2: Authenticated client pairing flow (Lines 276–342)
- **Log Statement:** `STEP 2 PASS: Authenticated successfully, bearer token obtained: %s...`
- **Preceding Assertions:** Connects `/v1/ws/sessions/bootstrap`, receives challenge, computes HMAC client proof, verifies `auth.ok`, extracts bearer token.
- **Classification:** **TRUE POSITIVE** (Verified)

### Step 3: Create OMP Agent with tmux backend (Lines 344–371)
- **Log Statement:** `STEP 3 PASS: Created Agent %s (TerminalSession: %s, CWD: %s, State: %s)`
- **Preceding Assertions:** `POST /v1/agents` asserted for `http.StatusCreated (201)`, session ID and terminal session ID extracted.
- **Classification:** **TRUE POSITIVE** (Verified)

### Step 4: 1 AgentSession -> 1 TerminalSession -> 1 Real OMP Process (Lines 373–384)
- **Log Statement:** `STEP 4 PASS: AgentSession %s -> TerminalSession %s -> exactly 1 OMP process (PID: %d)`
- **Preceding Assertions:** `countOMPPIDsForAgent(agentID1)` asserted `count == 1`.
- **Classification:** **TRUE POSITIVE** (Verified)

### Step 5: Bridge capabilities enable (Lines 386–428)
- **Log Statement:** `STEP 5 PASS: Bridge connected, prompt/abort/model/thinking capabilities enabled`
- **Preceding Assertions:** Polls `getAgent(agentID1)` until `capabilityEnabled(agentID1, "prompt")` is true within 60s.
- **Defect / Gap:** Only checks `prompt` capability. `abort`, `model`, and `thinking` capabilities are claimed in the PASS log but never checked in the capabilities array.
- **Classification:** **MINOR OVERCLAIM**

### Step 6: Semantic prompt & observe working -> assistant -> idle (Lines 430–524)
- **Log Statement:** `STEP 6 PASS: Working -> Idle observed, assistant response: %q (total events: %d)`
- **Preceding Assertions:** Submits prompt, polls until `turnCompleted` (`sawWorking && ag.State == "idle"` or `ev.Type == "message.assistant"`).
- **Defect / Gap:** No assertion verifies `assistantText != ""` or `strings.Contains(assistantText, "PONG")` before the PASS log.
- **Classification:** **MINOR MISSING ASSERTION**

### Step 7: Chat and Raw Terminal refer to SAME OMP PID (Lines 525–534)
- **Log Statement:** `STEP 7 PASS: Chat and Raw Terminal address same OMP PID: %d`
- **Preceding Assertions:** Calls `findOMPPIDForAgent(t, agentID1)` and asserts `postTurnPID == ompPID1`.
- **Defect / Gap:** Never connects to or interacts with the Raw Terminal endpoint (`/v1/terminal/` or WebSocket). Claiming Raw Terminal verification is fabricated.
- **Classification:** **SIGNIFICANT FALSE POSITIVE / FABRICATED CLAIM**

### Step 8: Disconnect client while keeping daemon+OMP+tmux running (Lines 535–545)
- **Log Statement:** `STEP 8 PASS: Remote OMP PID %d stays alive on client disconnect`
- **Preceding Assertions:** `time.Sleep(1 * time.Second)` and `isPIDAlive(ompPID1)`.
- **Defect / Gap:** No client connection is active or explicitly closed. It only verifies background process does not spontaneously die after 1 second of inactivity.
- **Classification:** **SIGNIFICANT FALSE POSITIVE / FABRICATED CLAIM**

### Step 9: Reconnect and reconstruct Chat history (Lines 546–562)
- **Log Statement:** `STEP 9 PASS: Reconstructed history exactly once, %d events, 0 duplicates`
- **Preceding Assertions:** Calls `getHistory(agentID1)`, checks for duplicate event IDs in map.
- **Classification:** **TRUE POSITIVE** (History deduplication verified)

### Step 10: Daemon restart with OMP preservation (Lines 563–598)
- **Log Statement:** `STEP 10 PASS: Daemon restarted (PID %d -> %d), same OMP PID %d preserved and reattached`
- **Preceding Assertions:** `SIGTERM` daemon, checks `isPIDAlive(ompPID1)` is true during downtime, starts new daemon, waits for prompt capability recovery, verifies `postRestartPID == ompPID1`.
- **Classification:** **TRUE POSITIVE** (Verified)

### Step 11: Semantic prompt post-restart (Lines 599–628)
- **Log Statement:** `STEP 11 PASS: Post-restart prompt completed with assistant response 'RESTART_PONG'`
- **Preceding Assertions:** Submits prompt, polls until `strings.Contains(ev.Text, "RESTART_PONG")`, fails if not completed within 60s.
- **Classification:** **TRUE POSITIVE** (Verified)

### Step 12: Close Presentation vs Explicit Terminate (Lines 629–656)
- **Log Statement:** `STEP 12 PASS: Explicit terminate killed OMP PID %d and closed tmux session`
- **Preceding Assertions:** Calls `/v1/agents/%s/terminate`, polls `!isPIDAlive(ompPID1)` within 10s.
- **Defect / Gap:** Header claimed "Close Presentation vs Explicit Terminate", but presentation close was not exercised. Explicit terminate was verified.
- **Classification:** **MINOR OVERCLAIM**

### Step 13: Create Agent 2 after terminate (Lines 657–685)
- **Log Statement:** `STEP 13 PASS: Created Agent 2 %s with new OMP PID %d`
- **Preceding Assertions:** Creates Agent 2 (201 Created), finds new OMP PID, terminates Agent 2 (200 OK).
- **Classification:** **TRUE POSITIVE** (Verified)

### Step 14: Cumulative create/terminate cycles exceeding maxSessions (Lines 686–718)
- **Log Statement:** `STEP 14 PASS: Successfully completed 8 cumulative agent sessions exceeding maxSessions limit of 4 with 0 admission leaks`
- **Preceding Assertions:** Loops 6 times creating (201) and terminating (200) agents with `maxSessions = 4`.
- **Classification:** **TRUE POSITIVE** (Verified)

### Step 15: Two Agent sessions with SAME workspace CWD (Lines 719–816)
- **Log Statement:** `STEP 15 PASS: Two agents in same CWD maintained completely distinct transcripts and bridge sessions`
- **Preceding Assertions:** Creates Alpha and Beta in same workspace, asserts `agentA.ID != agentB.ID`, sends secret prompt to Alpha, asserts Alpha history has secret and Beta history does NOT have secret.
- **Classification:** **TRUE POSITIVE** (Verified)

### Step 16 & 18: Bridge Disconnect/Reconnect & Truthful Capabilities (Lines 824–878)
- **Log Statement:** `STEP 16 & 18 PASS: Bridge capabilities reported truthfully matching connection state; OMP PID preserved`
- **Header Claim:** `Testing bridge disconnect, capability degradation, raw terminal, and reconnect`
- **Actual Code Executed:**
  1. Creates Agent Gamma (201 Created)
  2. Waits for bridge `prompt` capability
  3. Sends `GAMMA_PROMPT`
  4. Waits for `GAMMA_PROMPT` in history
  5. Terminates Agent Gamma (200 OK)
  6. Emits `STEP 16 & 18 PASS`
- **Defect / Gap:**
  - Bridge disconnect was NEVER triggered or tested.
  - Capability degradation (e.g. capabilities becoming disabled when bridge disconnects) was NEVER asserted.
  - Raw terminal fallback was NEVER exercised.
  - Bridge reconnect was NEVER tested.
  - OMP PID preservation across disconnect was NEVER verified.
- **Classification:** **CRITICAL FALSE POSITIVE / FABRICATED CLAIMS**

### Step 17: Durable History Replay Guarantees (Lines 879–885)
- **Log Statement:** `STEP 17 PASS: Verified durable history replay guarantees`
- **Actual Code Executed:**
  ```go
  // Unit/integration tests already prove high-water/cursor bounds in store_test.go.
  t.Log("STEP 17 PASS: Verified durable history replay guarantees")
  ```
- **Defect / Gap:** Zero executable lines or assertions. The PASS log is a pure placeholder.
- **Classification:** **CRITICAL FALSE POSITIVE / ZERO ASSERTIONS**

### Step 19: WorkspaceRoot Sandboxing on Files API (Lines 886–935)
- **Log Statement:** `STEP 19 PASS: File operations outside workspace rejected with 400; valid operations permitted`
- **Preceding Assertions:**
  - `GET /v1/fs/list?path=../../etc` -> asserts `400 Bad Request`
  - `POST /v1/fs/read` with `/etc/passwd` -> asserts `400 Bad Request`
  - `POST /v1/fs/read` with `project1/sample.txt` -> asserts `200 OK`
- **Classification:** **TRUE POSITIVE** (Verified)

### TestRealDaemonRestartTmuxCapacityOwnership (Lines 946–1265)
- **Summary:**
  1. Configures `max_sessions: 1`.
  2. Creates Agent A (201 Created, finds OMP PID A).
  3. Kills Daemon 1 (SIGTERM), asserts OMP PID A stays alive during daemon downtime.
  4. Starts Daemon 2, waits for Agent A reconciliation to active state.
  5. Attempts to create Agent B -> asserts `429 Too Many Requests` with code `"max_sessions"`.
  6. Terminates Agent A -> asserts OMP PID A exits within 10s.
  7. Creates Agent B -> asserts `201 Created` with new OMP PID B.
  8. Terminates Agent B.
- **Classification:** **TRUE POSITIVE** (Verified)
