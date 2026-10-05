# agenticRemote E2E Golden Flow Contract

**Status**: Normative requirements contract for end-to-end acceptance testing.

**Date**: 2026-10-05

---

## Scope

**PASS Criterion**: All prescribed gates must execute with ≥1 nonzero test case per platform and yield identical results across two independent clean runs. All mandatory semantic requirements have **executable proof** (real client interaction with real daemon). Backend hermetic flow establishes oracle baseline only; it does not substitute for platform proof.

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

**Prescribed Gates Per-Run Test Requirement**: Web (≥1 executable case), Android (≥1 executable case), Backend (≥1 executable case), Security (≥1 scan). Each must execute twice in isolation and pass identically both times.

---

## Semantic Evidence Matrix

The following exactly 8 semantic requirements must have executable proof. Each maps to Web adapter, Android adapter, and backend oracle reference. No addition or reordering.

### 1. Pairing & Reconnect

**Semantic**: Client acquires bearer token from real daemon via Auth-v2 handshake; subsequent requests use token; reconnect restores session.

| Platform | Evidence |
|---|---|
| **Web** | Real browser: complete Auth-v2 handshake; daemon issues bearer token; subsequent requests use token; session survives reconnect (close/reopen browser context); evidence recorded per run. |
| **Android** | Real app: pairing handshake completed; token acquired; subsequent requests use token; reconnect verified; evidence recorded per run. |
| **Backend Oracle** | WebSocket bootstrap → auth challenge → auth proof → bearer token issued; session state persisted; reference baseline only. |

---

### 2. Terminal Creation & Deterministic I/O Marker

**Semantic**: Client opens terminal session; daemon assigns unique session ID; deterministic input marker (e.g., `echo TEST_MARKER_<uuid>`) sent through real terminal; marker observed in output stream.

| Platform | Evidence |
|---|---|
| **Web** | Real browser: open terminal session; send deterministic input (e.g., `echo TEST_MARKER_<uuid>`); daemon processes through real tmux/pty; client-side terminal captures marker in output; evidence recorded per run. |
| **Android** | Real app: open terminal; send deterministic input; output stream captures marker; evidence recorded per run. |
| **Backend Oracle** | Terminal I/O routed through real tmux/pty; deterministic input/output flow established; reference baseline only. |

---

### 3. Agent Chat ≥5 Same-Session Consecutive

**Semantic**: Client sends ≥5 consecutive prompts to one agent; daemon processes each with semantic meaning; responses distinct.

| Platform | Evidence |
|---|---|
| **Web** | Real browser sends ≥5 consecutive prompts to one agent in same session; daemon processes each; distinct responses recorded per run. |
| **Android** | Real app sends ≥5 consecutive prompts to one agent in same session; distinct responses recorded per run. |
| **Backend Oracle** | 3+ semantic turns with distinct responses; reference baseline only. |

---

### 4. Files Sandbox

**Semantic**: Client can browse and read files in isolated workspace directories created by daemon.

| Platform | Evidence |
|---|---|
| **Web** | Real browser: open Files modal; navigate folder tree; read file content; verify content matches expected workspace state; evidence recorded per run. |
| **Android** | Real app: file browser access within isolated workspace directories; verify content readable; evidence recorded per run. |
| **Backend Oracle** | Workspace directories mounted to session; read operations completed; reference baseline only. |

---

### 5. Session Termination & Cleanup

**Semantic**: Client terminates agent; daemon releases resources; no orphaned processes.

| Platform | Evidence |
|---|---|
| **Web** | Real browser: terminate agent via UI; verify no hanging processes; evidence recorded per run. |
| **Android** | Real app: terminate agent session; verify cleanup; evidence recorded per run. |
| **Backend Oracle** | Termination endpoint called; OMP process exits cleanly; reference baseline only. |

---

### 6. Responsive & Mobile UI

**Semantic**: Client renders correctly across viewport sizes (mobile, tablet, desktop).

| Platform | Evidence |
|---|---|
| **Web** | Real browser renders correctly across viewport sizes (mobile 390×844, tablet 768×1024, desktop 1920×1080); no horizontal scroll on mobile; evidence recorded per run. |
| **Android** | Native app layout verified on actual device/emulator; responsive rendering tested per run. |
| **Backend Oracle** | N/A (backend does not render UI). |

---

### 7. Desktop noVNC WSS/RFB Framebuffer

**Semantic**: Client acquires desktop session ticket; daemon returns WSS URL; noVNC client renders remote framebuffer over RFB.

| Platform | Evidence |
|---|---|
| **Web (Desktop)** | Real browser: acquire desktop session ticket from daemon; receive WSS URL; noVNC client renders RFB framebuffer over WebSocket; real frame rendering verified; evidence recorded per run. Real WebSocket connection and frame rendering required; unit tests insufficient. |
| **Android** | Native WebView controls RFB session; platform-specific testing required; evidence recorded per run. |
| **Backend Oracle** | Backend routes RFB passthrough; does not mock framebuffer; reference baseline only. |

---

### 8. Security

**Semantic**: Client surfaces do not leak credentials; artifact inspection detects no credential storage; no plaintext secrets in logs; transport uses TLS.

| Platform | Evidence |
|---|---|
| **Web** | Real browser session: observe no cleartext tokens in DOM/localStorage/cookies; network requests use TLS; evidence recorded per run. |
| **Android** | Real app: observe no plaintext tokens in app memory/logs/storage; network requests use TLS; evidence recorded per run. |
| **Backend Oracle** | leak-scanner artifact inspection (logs, binaries, config files): no embedded credentials, no plaintext secrets, TLS configuration verified; reference baseline only. |

---

## Pinned OMP Conditional Capabilities

**Context**: Runtime OMP binary exports capability flags. Client may or may not render controls for these capabilities. Capability absence describes runtime limitation only.

**Procedure**:
1. Query pinned OMP binary; observe exported capability fields.
2. Record field names and values (capability support matrix).
3. Observe real client (Web/Android) rendering controls matching those capability fields.
4. If OMP export lacks field: record as `NOT_SUPPORTED` in runtime matrix (not a failure).
5. If OMP export includes field but client does not render control: record as **missing proof** (gap in client implementation or test coverage—product behavior, not NOT_SUPPORTED).
6. No assumed field names or protocol shapes; record only what is actually observed.

**Evidence Standard**:
- **Runtime Supports / Client Renders**: Capability operational end-to-end; evidence recorded per run.
- **Runtime Supports / Client Does Not Render**: Missing proof; platform behavior gap or test gap (not NOT_SUPPORTED).
- **Runtime Does Not Support**: Record as `NOT_SUPPORTED` in capability matrix (expected if OMP version is constrained).

---

## Evidence Hygiene

### Redaction Fields (per artifact)

All captured data must redact:
- **Bearer tokens**: Mark as `[REDACTED]`
- **Pairing payloads**: Mark as `[REDACTED]`
- **TLS certificates / keys**: Mark as `[REDACTED]`
- Agent IDs: Keep (ephemeral per run)
- File paths: Keep relative; absolute home paths marked as `[REDACTED]`

### Failure States

Exactly four classifications allowed:

| State | Definition | Evidence Required |
|---|---|---|
| **PASS** | All semantic requirements satisfied over two clean runs; test output shows all assertions passed; identical results across runs. | Test logs; run isolation reset verified. |
| **BLOCKED_EXTERNAL** | Real daemon unavailable; network isolation failed; host KVM access denied; Compose topology failed. | Error log from external dependency (e.g., "Daemon connection refused", "KVM device not found"). |
| **TEST_HARNESS_BUG** | Test framework limitation (Playwright missing feature, Maestro crash, Go test panic, emulator unavailable). | Framework error stack trace or diagnostic message. |
| **PRODUCT_BUG** | Product defect (daemon crash on valid input, session creation fails, output corrupted, terminal I/O lost). | Daemon log; inconsistent state; output mismatch vs. input semantics. |

No "partial PASS", "expected failure", "skip", or other classification permitted.

### Constraints

- Do not suppress errors.
- Do not skip requirements on any platform.
- Do not assume alternate implementations or fallbacks.
- Do not mutate host (no root workloads, no emulator image replacement, no sudo permission escalation).
- No global state leakage between runs.
- Backend-proxy PASS invalid: daemon oracle does not substitute platform proof.
- Source-only PASS invalid: code without execution does not prove requirement.
- Unit-test PASS invalid for E2E gates (except where specified e.g. legacy mocking for oracle reference).
- Mock-client PASS invalid: client-side mocking of daemon does not prove requirement.

---
