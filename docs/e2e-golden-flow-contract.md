# agenticRemote E2E Golden Flow Contract

**Status**: Normative requirements contract for end-to-end acceptance testing.

**Date**: 2026-10-05

---

## Scope

**PASS Criterion**: All prescribed gates execute without failure and all mandatory semantic requirements have **executable proof** (real client interaction with real daemon). Two independent runs must yield identical results. Backend hermetic flow establishes oracle behavior only; it does not substitute for platform proof.

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

**Test Count**: Each platform must have ≥1 executable test case.

**Clean Runs**: Execute twice in isolated environments. Both runs must PASS identically.

---

## Semantic Evidence Matrix

The following 8 semantic requirements must have executable proof. Each maps to Web adapter, Android adapter, and backend oracle. Mark "evidence unverified" where proof is absent; do not fabricate or claim backend proxy suffices.

### 1. Pairing & Real Authentication

**Semantic**: Client acquires bearer token from real daemon via Auth-v2 handshake.

| Platform | Evidence |
|---|---|
| **Web** | Real browser with real daemon; bearer token acquired and used in subsequent requests; evidence recorded per run. |
| **Android** | Real app with real emulator and real daemon; pairing handshake completed; token acquired; evidence recorded per run. |
| **Backend Oracle** | WebSocket bootstrap → auth challenge → auth proof → bearer token issued. Reference baseline only; backend-proxy PASS invalid. |

---

### 2. Agent Chat ≥5 Sequential Same-Session

**Semantic**: Client sends ≥5 consecutive prompts to one agent; daemon processes each with semantic meaning; responses distinct.

| Platform | Evidence |
|---|---|
| **Web** | Real browser sends ≥5 consecutive prompts to one agent in same session; daemon processes each; distinct responses recorded per run. |
| **Android** | Real app sends ≥5 consecutive prompts to one agent in same session; distinct responses recorded per run. |
| **Backend Oracle** | 3+ semantic turns with distinct responses. Reference baseline only; backend-proxy PASS invalid. |
---

### 3. Files Sandbox

**Semantic**: Client can browse and read files in isolated workspace directories created by daemon.

| Platform | Evidence |
|---|---|
| **Web** | Real browser: open Files modal, navigate folder tree, read file content; verify content matches expected workspace state; evidence recorded per run. |
| **Android** | Real app: file browser access within isolated workspace directories; verify content readable; evidence recorded per run. |
| **Backend Oracle** | Workspace directories mounted to session; read operations completed. Reference baseline only. |
---

### 4. Session Termination & Cleanup

**Semantic**: Client terminates agent; daemon releases resources; no orphaned processes.

| Platform | Evidence |
|---|---|
| **Web** | Real browser: terminate agent via UI; verify no hanging processes; evidence recorded per run. |
| **Android** | Real app: terminate agent session; verify cleanup; evidence recorded per run. |
| **Backend Oracle** | Termination endpoint called; OMP process exits cleanly. Reference baseline only. |
---

### 5. Responsive & Mobile UI

**Semantic**: Client renders correctly across viewport sizes (mobile, tablet, desktop).

| Platform | Evidence |
|---|---|
| **Web** | Real browser renders correctly across viewport sizes (mobile 390×844, tablet 768×1024, desktop 1920×1080); no horizontal scroll on mobile; evidence recorded per run. |
| **Android** | Native app layout verified on actual device/emulator; responsive rendering tested per run. |
| **Backend Oracle** | N/A (backend does not render UI). |
---

### 6. Desktop noVNC WSS/RFB Framebuffer

**Semantic**: Client acquires desktop session ticket; daemon returns WSS URL; noVNC client renders remote framebuffer over RFB.

| Platform | Evidence |
|---|---|
| **Web (Desktop)** | Real browser: acquire desktop session ticket from daemon; receive WSS URL; noVNC client renders RFB framebuffer over WebSocket; evidence recorded per run. Real WebSocket connection and frame rendering required; unit tests insufficient. |
| **Android** | Native WebView controls RFB session; platform-specific testing required; evidence recorded per run. |
| **Backend Oracle** | Backend routes RFB passthrough; does not mock framebuffer. Reference baseline only. |
---

### 7. Terminal Session & Deterministic I/O Marker

**Semantic**: Client opens terminal session; daemon assigns unique session ID; deterministic input marker (e.g., `echo TEST_MARKER_<uuid>`) sent through real terminal; marker observed in output stream.

| Platform | Evidence | 
|---|---|
| **Web** | Real browser sends deterministic terminal input (e.g., `echo TEST_MARKER_<uuid>`); real daemon processes through tmux/pty; client-side terminal captures marker in output; evidence recorded per run. |
| **Android** | Real app sends terminal input; output stream captured; marker verified; evidence recorded per run. |
| **Backend Oracle** | Terminal I/O routed through real tmux/pty; deterministic input/output flow established. Reference baseline only. |

### 8. Pinned OMP Conditional Capabilities

**Requirement**: Inspect runtime OMP binary to determine supported capabilities. **Record absence as `NOT_SUPPORTED` only if OMP binary does not export the capability. Do not claim support without observing client-visible rendering.**

**Procedure**:
1. Query pinned OMP binary to observe exported capability fields.
2. Observe real client (Web/Android) rendering controls for those capabilities.
3. If client does not render control: `NOT_SUPPORTED` in report (not failure).
4. If capability absent from OMP export: `NOT_SUPPORTED` in report.
5. No assumed field names or protocol shapes; record only what is actually observed.

**Evidence Standard** (per run):
- **Supported**: Real client renders capability controls; daemon backend reflects capability flags.
- **Not Supported**: OMP export lacks field OR client UI does not render control; explicitly documented.
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

