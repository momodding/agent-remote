# agenticRemote E2E Golden Flow Contract

**Status**: Normative requirements contract for end-to-end acceptance testing.

**Date**: 2026-10-05

---

## Scope

**PASS Criterion**: All prescribed gates execute without failure, nonzero test count per platform, two independent clean runs without global state mutation, and all mandatory semantic requirements have **executable proof** (real client interaction with real daemon). Backend hermetic flow establishes oracle behavior only; it does not substitute for platform proof.

**Allowed Evidence Classes**:
- Executable: Real client sending requests, real daemon responding, assertions on resulting state/output.
- Backend Oracle: Hermetic flow using MockOpenAIServer; reference behavior only (not platform substitute).

**Forbidden Evidence Classes**:
- Source-only: Code without execution.
- Mock: Client-side mocking of daemon behavior.
- Unit test: Isolated component testing (e.g., URL generation without network).
- Backend-proxy: Claiming platform requirement satisfied because backend oracle covers it.

---

## Prescribed Gates

| Platform | Runner | Entry | Executor |
|---|---|---|---|
| **Web** | Playwright | `e2e-lab/playwright/specs/` | Real browser + real daemon |
| **Android** | Maestro + ADB | `e2e-lab/android/android-runner.ts` | Real APK + real emulator + real daemon |
| **Backend** | Go test | `backend/internal/agent/goldenflow_hermetic_test.go::TestGoldenFlowHermeticPhase1to4` | Real omp/tmux + MockOpenAIServer |
| **Security** | leak-scanner | `e2e-lab/scripts/test-security.sh` | Artifact inspection |

**Unified Orchestrator**: `e2e-lab/scripts/test-all.sh` (phases: doctor → up → backend → web → android → security).

**Test Count**: Each platform must have ≥1 executable test case. Current: Web 4 spec files, Android 2 active flows, Backend 1 test (6 internal cycles), Security 1 scanner.

**Clean Runs**: Execute twice in isolated environments. Between runs: reset all state (clear tokens, restart Compose, close browser tabs). Both runs must PASS identically.

---

## Semantic Evidence Matrix

The following 8 semantic requirements must have executable proof. Each maps to Web adapter, Android adapter, and backend oracle. Mark "evidence unverified" where proof is absent; do not fabricate or claim backend proxy suffices.

### 1. Pairing & Real Authentication

**Semantic**: Client acquires bearer token from real daemon via Auth-v2 handshake.

| Platform | Evidence | Status |
|---|---|---|
| **Web** | Playwright test with real daemon; `E2E_REAL_PAIRING_PAYLOAD` env var required (forged payloads rejected); subsequent requests use bearer token. | ✅ Executable |
| **Android** | Maestro pairing flow (`pairing-flow.yaml`); real app sends pairing JSON; daemon responds; sheet dismissal confirms token acquired. | ✅ Executable |
| **Backend Oracle** | WebSocket bootstrap → auth challenge → auth proof → bearer token issued. Reference baseline. | ✅ Hermetic |

**Required**: Both Web and Android must demonstrate real token acquisition. Backend oracle validates token chain correctness.

---

### 2. Terminal Session Creation & Marker

**Semantic**: Client creates terminal session; daemon assigns unique session IDs; terminal I/O marker/input channel is open.

| Platform | Evidence | Status |
|---|---|---|
| **Web** | Playwright verifies terminal DOM surface visible (xterm or equivalent). | ✅ Executable |
| **Android** | Maestro navigation to terminal UI; assert surface visible. Evidence unverified (flow exists but not invoked in runner). | ⚠️ Evidence Unverified |
| **Backend Oracle** | Session creation returns unique IDs (AgentSession, TerminalSession); I/O routing established. | ✅ Hermetic |

**Required**: Web + executable proof. Android evidence unverified.

---

### 3. Agent Chat ≥5 Sequential Same-Session

**Semantic**: Client sends ≥5 consecutive prompts to one agent; daemon processes each with semantic meaning; responses are distinct.

| Platform | Evidence | Status |
|---|---|---|
| **Web** | Agent spec currently submits 1 prompt. Evidence unverified (≥5 turns not tested). | ❌ Evidence Unverified |
| **Android** | Maestro agent-chat flow submits 2 prompts. Evidence unverified (≥5 turns not tested). | ⚠️ Evidence Unverified |
| **Backend Oracle** | 3 semantic turns (distinct mock responses per turn). Reference baseline; does not cover Web/Android platform requirement. | ✅ Hermetic (oracle only) |

**Required**: Both Web and Android must demonstrate ≥5 sequential turns. Current: neither platform reaches 5.

---

### 4. Files Sandbox (Isolated Project Directories)

**Semantic**: Client can browse and read files in isolated workspace directories created by daemon.

| Platform | Evidence | Status |
|---|---|---|
| **Web** | Playwright agent spec opens Files modal, navigates folder, reads file, asserts content. | ✅ Executable |
| **Android** | Files integration in Maestro or runner. Evidence unverified (not invoked in golden flow). | ❌ Evidence Unverified |
| **Backend Oracle** | Workspace directories created and mounted to terminal session. | ✅ Hermetic |

**Required**: Both Web and Android must demonstrate file access. Android evidence unverified.

---

### 5. Session Termination & Cleanup

**Semantic**: Client terminates agent; daemon releases resources; no orphaned processes or sessions.

| Platform | Evidence | Status |
|---|---|---|
| **Web** | Playwright agent spec shows termination button visible and clickable. | ✅ Executable (UI action) |
| **Android** | Explicit termination in Maestro or runner. Evidence unverified (app lifecycle closes session implicitly; no assertion). | ⚠️ Evidence Unverified |
| **Backend Oracle** | Termination endpoint called; OMP process confirmed dead. | ✅ Hermetic |

**Required**: Both Web and Android must demonstrate termination. Web has UI action; Android evidence unverified.

---

### 6. Responsive & Mobile UI

**Semantic**: Client renders correctly across viewport sizes (mobile 390×844, tablet 768×1024, desktop 1920×1080).

| Platform | Evidence | Status |
|---|---|---|
| **Web** | Playwright responsive spec tests 4 viewports; no horizontal scroll on mobile. | ✅ Executable |
| **Android** | Native app layout (not Playwright-testable for responsive behavior). | N/A |
| **Backend Oracle** | N/A (backend does not render UI). | N/A |

**Required**: Web demonstrates responsive rendering. Android N/A (native platform).

---

### 7. Desktop noVNC WSS/RFB Framebuffer

**Semantic**: Client acquires desktop session ticket; daemon returns WSS URL; noVNC client renders remote framebuffer over RFB.

| Platform | Evidence | Status |
|---|---|---|
| **Web (Desktop)** | Unit test assertions on RFB URL generation and noVNC bundle injection (`desktop-route.test.tsx`). Does not include live RFB frame inspection or WebSocket connection. | ✅ Unit Test (partial) |
| **Android** | Native WebView controls RFB; not automatable in golden flow. | N/A |
| **Backend Oracle** | Backend routes RFB passthrough; does not mock framebuffer. | N/A |

**Note**: Unit test is not E2E; live RFB WebSocket integration unverified.

---

### 8. Security & No Leak

**Semantic**: Daemon does not expose internal headers, debug frames, or secrets to clients.

| Platform | Evidence | Status |
|---|---|---|
| **Web** | No assertions on HTTP response headers or body sanitization. Evidence unverified. | ❌ Evidence Unverified |
| **Android** | Maestro operates at UI layer; no protocol inspection. Evidence unverified. | ❌ Evidence Unverified |
| **Backend Oracle** | Mock handler validates sanitized responses (no internal metadata). Reference baseline. | ✅ Hermetic |

**Required**: Dedicated security scanner (`leak-scanner`) inspects artifacts. Platform-level header assertions unverified.

---

## Pinned OMP Conditional Capabilities

**Requirement**: Inspect runtime OMP binary to determine supported capabilities. **Only present controls if verified supported. Record absence as `NOT_SUPPORTED` (not failure).**

**Procedure**:
1. Query pinned OMP binary version and capability export.
2. Check bridge response for `model`, `thinking` fields.
3. If present: both Web and Android must demonstrate capability rendering in UI.
4. If absent: record as `NOT_SUPPORTED` in test report (clear, not failure).

**Evidence Standard**:
- **Supported**: Client renders capability controls; backend oracle asserts bridge dict includes capability flags.
- **Not Supported**: OMP version does not export field; explicitly documented in report.
- **Unverified**: No executable proof of capability rendering in Web/Android (source-only UI mocks do not count).

**No Invention**: Do not assume capability protocol shape or implementation details. Assert only what the pinned OMP binary actually exports and what clients actually render.

---

## Evidence Hygiene

### Redaction Rules

All captured artifacts must redact:
- **Bearer tokens**: `Authorization: Bearer [REDACTED]`
- **Pairing payloads**: Raw `token` field only
- **TLS certificates**: Private keys only
- **Agent IDs**: No redaction (ephemeral per run)
- **File paths**: Keep relative; redact absolute `$HOME` paths

### Allowed Failure States

Only these classifications are permitted:

| State | Definition | Evidence |
|---|---|---|
| **PASS** | All 8 semantic requirements + 2 clean runs + nonzero tests satisfied. | Test output shows all assertions passed; run logs show clean state reset. |
| **BLOCKED_EXTERNAL** | Real daemon unavailable; network isolation broken; host KVM/sudo access denied; compose topology failed. | Error log shows external dependency failure (e.g., "Daemon refused connection", "KVM device not accessible", "Noninteractive sudo required"). |
| **TEST_HARNESS_BUG** | Test framework limitation (Playwright missing feature, Maestro crash, Go test panic). | Stack trace or framework error message. |
| **PRODUCT_BUG** | Product defect (daemon crash on valid input, session creation fails, output corrupted). | Daemon log shows error, state is inconsistent, or output does not match input semantically. |
| **Any Other** | **Invalid—test fails immediately.** No "partial PASS", "legacy expected failure", or "skip on platform". | None. |

### No Suppression, Fallback, or Mutation

- Do not suppress errors.
- Do not skip requirements.
- Do not assume alternate implementations.
- Do not mutate host (no root workloads, no emulator image replacement, no permission escalation).
- Global state must not leak between runs.

---

## Current Status

**This contract documents semantic requirements and evidence standards. It does NOT assert current implementation state.**

Current state findings (from audit, no execution):
- Web: Pairing + terminal rendering + agent chat (1 turn) + files + termination UI + responsive + noVNC unit test.
- Android: Pairing + agent chat (2 turns Maestro) + execution.
- Backend Oracle: Pairing + agent chat (3 turns) + session ID uniqueness + termination + 6-cycle isolation.
- Gaps: Web terminal keystroke injection, Android terminal session, Android files, ≥5-turn chat, header/leak inspection, two-run isolation, OMP capability determination.

**NO CLAIMS OF PASS.** Do not modify runtime tests or claim acceptance until evidence aligns with all requirements above.

---

## Version

| Field | Value |
|---|---|
| **Version** | 1.0 (Normative, Evidence-Based) |
| **Authority** | E2E Acceptance Standard |
| **Date** | 2026-10-05 |

