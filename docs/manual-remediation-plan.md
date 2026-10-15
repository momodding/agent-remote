# Manual Remediation Plan

**Authority**: `plans/recover-agent-architecture.md` is authoritative. This document records remediation acceptance and evidence for that TUI-first plan.

## Operating Rule
The product MUST own one real interactive process per harness session. Terminal is the canonical surface. Chat/semantic views are optional observer projections over the same process and MUST NOT create a second OMP process, a hidden process, or a simulated success path.

## Phase A Acceptance
**Status**: PASS — focused harness tests pass; pinned-process E2E remains separately pending.


### A-001: Capability-routed actions
- Requests carry an explicit capability and action route; mode labels are not routing inputs.
- Unknown or disabled routes fail closed before a process write.
- Required initial route is `tui.input/tui.input.write`; adapter-neutral reserved semantic routes are `prompt/prompt.submit`, `abort/abort`, `model/model.set`, and `thinking/thinking.set`.
- Evidence: focused router tests prove accepted and rejected routes.

### A-002: Serialized interactive input
- Every byte write for an agent process passes through exactly one FIFO input arbiter; standalone terminals continue to use their session manager directly.
- Inputs carry a source (`terminal_user`, `chat_prompt`, `chat_command`, `mode_control`, `interaction_response`, or `system_control`). The arbiter permits one driver operation at a time, retains caller order, rejects closed sessions, and never retries an uncertain write.
- Evidence: focused concurrent arbiter and source-order tests prove no overlapping driver writes and preserved ordering.

### A-003: Driver/observer separation
- `TuiDriver` is the only write authority. `TuiObserver` is read-only and may include terminal output, the OMP bridge, and transcript recovery.
- Multiple observers MAY attach to one process. Semantic sources are OPTIONAL and their absence leaves terminal input available while semantic routes are disabled.
- Events record source provenance (`tui`, `bridge`, or `transcript`), observed time, and process/session identity when known.

### A-004: OMP baseline
- Existing agent creation launches one interactive `omp --no-extensions -e <bridge>` process in its terminal runtime.
- The adapter starts with `tui.input` only. It may advertise OMP semantic capabilities only after bridge-confirmed support.
- The terminal and any chat projection share the same process identity.

## TUI Milestones

### TUI-001: Deterministic pinned-OMP interaction
**Status**: PASS — real hermetic OMP 18.6.1 integration test proves deterministic pinned interaction: terminal-originated /goal and /plan commands, composite ControlSafety gating, epoch-protected automated dispatch, and structured postcondition via JSONL mode_change, in TestHermeticOMPPlanTerminalAndControl (12.67s).

**Evidence**: `backend/internal/agent/hermetic_omp_test.go` function `TestHermeticOMPPlanTerminalAndControl` passes: `cd backend && go test ./internal/agent -run '^TestHermeticOMPPlanTerminalAndControl$' -v -timeout 120s` → PASS in 12.67s (wall 24.16s). Real hermetic OMP 18.6.1 fixture (one real interactive OMP PID throughout): (1) Fixed hermetic fixture now sets `OMP_SKIP_SETUP=1`, reaching real REPL without provider setup prompts; (2) sends real prompt through canonical process, waits for `message.assistant` event plus materialization of bridge-bound JSONL session file (OMP 18.6.1 lazy-persists files only after assistant message; confirmed from `session-manager.ts` `#shouldHaveSessionFile()`); (3) sends real terminal `/goal show\r`, asserts persisted JSONL `mode_change` event, materialized session file matched before/after test, whole interaction deterministic despite real OMP PID (not hermetic clock mock); fixture teardown properly joins OMP process; assertion `test.Must(AssertHasResolvedMode(t, session, goal_paused|vibe` (legacy `*_active` aliases), renders nothing for `none`/`unknown`. Verified: `cd client && bun run typecheck` PASS, `cd client && bun run test -- agent-route.test` PASS (30 tests). A router-level regression was found and fixed after this evidence was first recorded: `NewOMPAdapterWithVersion` registered the OMP goal/plan capability routes directly against the raw `InputArbiter` instead of `OmpTuiDriver`, bypassing all safety/dedup/confirmation-pending logic at the `Router.Route` call path; fixed by introducing a `submitter` interface so `Router` can register either an arbiter or a driver, and OmpTuiDriver.Drive's state-only (no-runtime) branch gained the missing mode-based gating and direct-dispatch logic it was missing. Verified: `go test ./internal/harness -v -timeout 60s` all 27 tests pass; `go test ./internal/agent -run 'TestAgentRoutesOMPControlsThroughSharedTerminalDriver|TestHermeticOMPPlanTerminalAndControl' -timeout 90s -v` both PASS unaffected.
### TUI-002: Shared-process observation
**Status**: PASS — same real test additionally proves bidirectional mode control: chat-originated RouteOMPPlanToggle drives the shared terminal process to a structured none transition, and reconnect with a fresh subscriber (no cached client state) correctly replays persisted plan mode from the exact bound JSONL file via bridge.ts's own reconnect path.

**Evidence**: Same `TestHermeticOMPPlanTerminalAndControl` test (12.67s, 24.16s wall) in `backend/internal/agent/hermetic_omp_test.go`. Daemon control route `RouteOMPPlanToggle` tested: daemon-originated request transitions the shared terminal's OMP process through `InputArbiter.SubmitAutomated` (epoch-gated, rechecks `runtime.CurrentEpoch()` and `ControlSafety()` immediately before underlying `Driver.Drive` call inside serialized FIFO worker), reaching exact same session and PID, transitions to `none` mode. Reconnect proof: fresh subscriber (no cached `SubscriberState`) attached after forcing close of real bridge Unix socket (not OMP process), waits for bridge.ts's own reconnect (separate from harness), asserts restored session binds to exact same JSONL path and fresh subscriber receives replayed persisted `plan` mode via tailer (not in-memory state), confirmed by two real bridge hello log entries with identical `agentID`/`sessionID`/`sessionFile`. Tailer determinism: `backend/internal/agent/adapter.go` `handleBridgeHello` now always rebinds tailer on each hello (treats reconnect as new live-observer boundary), `restorePersisted` primes mode as `unknown` until bridge/tailer confirms, mode reconstruction on bridge hello replays last JSONL `mode_change` through the tailer.
## E2E Result Classification
Use only one state per attempted claim:
| State | Meaning | Required action |
| --- | --- | --- |
| PASS | Real pinned process executed and emitted a reliable assertion | retain capability |
| FAIL | Real process disproved the claim | disable capability |
| BLOCKED_ENVIRONMENT | required binary/TTY/daemon/credentials/platform unavailable | record prerequisite |
| BLOCKED_UPSTREAM | OMP 18.6.1 has no verified public mechanism | keep disabled |
| BLOCKED_OBSERVABILITY | process ran but output/provenance cannot establish result | keep disabled |

## Manual Acceptance Workstreams

MANUAL-001, MANUAL-002, MANUAL-003, MANUAL-004, MANUAL-005, MANUAL-006, and MANUAL-007 have all achieved PASS via live-browser acceptance (see below). Only MANUAL-007b (noVNC status-update-display failure-path) remains OPEN, pending live browser acceptance. Underlying harness mechanisms are verified (TUI-001 PASS, TUI-002 PASS).

### MANUAL-001/CHAT-001 — Mutable mode control (chat-originated)
**Status**: PASS — real browser acceptance achieved, single OMP process throughout.

**Evidence**: Full live-browser Playwright run (`e2e-lab/playwright/specs/manual-001-mode.spec.ts`) against the real e2e-lab stack, OMP 18.6.1 — **1 passed (1.2m)**. Covers real pairing, agent creation, terminal-driven `/plan`, reload+re-pair+reopen mode reconstruction from persisted server state, two further browser-driven `plan_toggle` calls (pause, disable) each confirmed via real HTTP 200 and durable terminal text, browser-driven `goal_show` confirmed via real HTTP 200 and durable terminal text, and termination reducing the real OMP PID count to baseline. Seven real product bugs (A, B, C, #1, #4, #5, #6, #7) were found and fixed along the way via genuine live-browser iteration; see `docs/manual-remediation-ledger.md` MANUAL-001 entry for the full bug list and scenario detail.

### MANUAL-002/CHAT-002 — Deterministic pinned OMP interaction (chat-originated)
**Status**: PASS — real browser acceptance achieved, live e2e-lab stack, no mocks/synthetic dispatch.

**Evidence**: Full live-browser Playwright run (`e2e-lab/playwright/specs/manual-002-003-commands.spec.ts`) against the real e2e-lab stack, OMP 18.6.1 — **4 passed (30.1s)**, repeated **4 passed (27.6s)**. Four real bugs (#8 OMP TUI slash-command-picker keystroke-vs-render race — test-fixture pacing mitigation only, #9 client-side `goal_show`/`plan_toggle` command-palette staleness, #10 the spec's own incorrect literal `aria-disabled="false"` assertion, #11 backend `/command` handler missing the `ErrTUIConfirmationPending` success carve-out already present on `/mode`) were found and fixed via genuine live-browser iteration; see `docs/manual-remediation-ledger.md` MANUAL-002/CHAT-002 entry for the full bug list, backend verification, and scenario coverage.

### MANUAL-003 — Mode-aware plan view
**Status**: PASS — real browser acceptance achieved, live e2e-lab stack, no mocks/synthetic dispatch, same live run as MANUAL-002/CHAT-002 above (`manual-002-003-commands.spec.ts`, 4 passed twice). See `docs/manual-remediation-ledger.md` MANUAL-003 entry.
### MANUAL-004, MANUAL-005, MANUAL-006, MANUAL-007
All achieved PASS per ledger. See corresponding ledger entries (MANUAL-004 through MANUAL-007, E2E topology). Only MANUAL-007b (noVNC status-update-display failure-path) remains OPEN.

### MANUAL-007b — noVNC failure-path recovery
**Status**: OPEN — source and direct route-test recovery UI exist, but live-browser acceptance remains blocked. Current real daemon/RFB topology has no compliant failure-path control for required browser proof: expired ticket, reused one-use ticket, invalid ticket, unavailable VNC target, mid-session target disconnect, and RFB protocol negotiation failure. Required fresh-ticket retry and old-ticket-dead proof remain blocked until real daemon/RFB controls can induce those paths without mock transport, forged credentials, or arbitrary iframe URLs.

### ENH-001 — Ghostty renderer migration
**Decision**: BLOCKED/PARTIAL — retain xterm on Web and React Native WebView on Android until renderer, bindings, lifecycle, IME, and accessibility compatibility proof exists. Protected one-process, `InputArbiter`, and `TuiDriver` transport invariants remain unchanged.

## Deferred Work
Existing MANUAL/CHAT enhancement work remains deferred until the Phase A route, arbiter, ownership, provenance, and OMP baseline acceptance above are met. Mutable OMP mode, slash-command execution, mention resolution, attachments, and additional harness adapters are not enabled by discovery alone.

## Current Iteration Evidence

### Web E2E and pairing
- Direct, dynamically inspected Podman bridge-IP pairing works in a real browser through the test-only `E2E_REAL_PAIRING_ENDPOINT` override. The rootful published host-port forwarding path remains broken.
- The pairing helper scans only in-memory Compose daemon output (`--tail 5000`, 10 MiB buffer, 15-second command timeout); it does not persist or log pairing payloads/secrets.
- The old 2026-10-07 blanket `BLOCKED_ENVIRONMENT` statement is superseded by this evidence.

### MANUAL-001 (Non-optimistic selector transport)
- **Status: PASS.** E2E daemon image is pinned to OMP 18.6.1.
- Full scenario passed in a real browser: `e2e-lab/playwright/specs/manual-001-mode.spec.ts`, `1 passed (1.2m)`.
- Byte-level `pty.input`/`pty.output` WebSocket frame tracking confirms the terminal `/plan` keystrokes reached the real OMP TUI and produced real TUI output (prior iteration's `pty.input` gap is resolved).
- Browser Plan rendering, browser Plan-control/TUI agreement, same-PID proof, and mode reconstruction after reload+re-pair are all confirmed with real evidence (durable terminal text `"Plan mode paused."` / `"Plan mode disabled."` / `"No goal set."`).
- Seven real product bugs (A, B, C, #1, #4, #5, #6, #7) were found and fixed to reach this PASS; see `docs/manual-remediation-ledger.md` MANUAL-001 entry for the full list.
- Screenshots: `artifacts/manual-001-terminal-plan.png`, `artifacts/manual-001-browser-controls.png`.

### MANUAL-002 and MANUAL-003 (Structured command palette and mode-aware plan view)
- **Status: PASS.** Full live-browser Playwright run (`e2e-lab/playwright/specs/manual-002-003-commands.spec.ts`) against the real e2e-lab stack, OMP 18.6.1 — **4 passed (30.1s)**, repeated **4 passed (27.6s)**, daemon bridge IP `10.89.1.91` (rederived after a daemon image rebuild/force-recreate carrying the backend fix below).
- Real pairing, real terminal-driven `/plan` establishing a real OMP mode, real command-palette discovery/enablement/dispatch of `goal_show` via a real `POST /command` returning a real `200` with real OMP-side confirmation, unknown-command rejection enforced before any network dispatch, real `@` mention completion inserting a real workspace-relative path, and real local file attachment reaching the submitted prompt with chip-removal cleanup.
- Four real bugs (#8 OMP TUI slash-command-picker keystroke-vs-render race — test-fixture pacing mitigation only, #9 client `goal_show`/`plan_toggle` command-palette staleness, #10 the spec's own incorrect literal `aria-disabled="false"` assertion, #11 backend `/command` handler missing the `ErrTUIConfirmationPending` success carve-out) were found and fixed to reach this PASS; see `docs/manual-remediation-ledger.md` MANUAL-002/CHAT-002 and MANUAL-003 entries for the full bug list, backend verification (`go build`/`go vet`/`go test` clean on `internal/server`, `internal/harness`, `internal/agent`, three pre-existing unrelated hermetic fixture failures isolated via revert-and-rerun), and scenario coverage.

### MANUAL-004 and MANUAL-006 lifecycle acceptance
- **PASS.** Focused real Playwright agent and terminal termination cases each passed in 37.7s. Each asserted the paired UI action and confirmation modal, termination HTTP 200, then reload plus fresh legitimate re-pair with the terminated item absent.
- Screenshots: `e2e-lab/artifacts/manual-lifecycle/agent-terminate-confirmation.png` and `e2e-lab/artifacts/manual-lifecycle/terminal-terminate-confirmation.png`.

### Other workstreams
- MANUAL-001, MANUAL-002, MANUAL-003, MANUAL-004, MANUAL-005, MANUAL-006, and MANUAL-007 are all PASS (see above and ledger). Only MANUAL-007b (noVNC status-update-display) remains OPEN pending live browser acceptance.
