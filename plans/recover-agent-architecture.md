<!-- omp-source-branch: main -->
<!-- omp-work-branch: omp/recover-agent-architecture-2 -->
# TUI-First Harness Recovery Plan

## Authority
This is the authoritative implementation plan for agent runtime recovery. `docs/manual-remediation-plan.md` and `docs/manual-remediation-ledger.md` are evidence and status companions; where they conflict with this document, this document controls.

## Goal
Run exactly one real interactive harness process per agent session. The raw terminal is the canonical interactive surface; semantic chat is an optional projection over that same process, never a hidden/headless second process or a fake-mode UI.

## Architecture
- A `HarnessSession` has one process identity, one terminal runtime, one input arbiter, a driver, and zero or more observers.
- `TuiDriver` is the sole authority permitted to write to the process. `TuiObserver` reports terminal/semantic/lifecycle observations and never writes input.
- The input arbiter serializes every input action for a process. It preserves caller order, rejects work after closure, and makes no speculative retry after a write error.
- Routes are explicit `(capability, action)` pairs, not UI-mode strings. A route is available only when its capability is advertised and enabled. Unknown or disabled pairs fail closed.
- The initial OMP adapter owns OMP launch/discovery and can advertise semantic actions only after its bridge proves them. Semantic sources (OMP bridge and transcript projection) are optional observers; absence leaves terminal capability available and semantic capabilities disabled.
- Provenance accompanies every observation: source (`tui`, `bridge`, or `transcript`), process/session identity when known, and observed time. Bridge events are preferred while connected; transcript data is recovery/read-only fallback.
- Observer and driver ownership are separate: many terminal/chat observers may attach, but exactly one serialized driver writes.

## Action Route Contract
Phase A uses these stable names:

| Capability | Action | Driver target |
| --- | --- | --- |
| `tui.input` | `tui.input.write` | exact terminal bytes |
| `prompt` | `prompt.submit` | verified adapter semantic bridge only |
| `abort` | `abort` | verified adapter semantic bridge only |
| `model` | `model.set` | verified adapter semantic bridge only |
| `thinking` | `thinking.set` | verified adapter semantic bridge only |

Semantic routes MUST remain disabled until the connected adapter bridge confirms support. There is no terminal-keypress fallback for semantic actions in Phase A.

## Phase A — TUI Harness Core
1. Add a small backend-internal harness contract: capabilities/actions, `TuiDriver`, `TuiObserver`, provenance, route table, and FIFO input arbiter.
2. Add an OMP adapter baseline that declares the one real interactive process contract and starts with only `tui.input` enabled. It can enable semantic capability routes only from verified bridge metadata.
3. Make request routing resolve an explicit capability/action pair before reaching a driver; disabled and unknown routes return deterministic errors.
4. Add focused unit tests proving serialized driver input and capability/action routing.
5. Preserve existing agent bridge and terminal APIs during this cutover; they become integration points for the adapter rather than alternate process owners.

## First OMP Vertical Slice
- Launch the existing `omp --no-extensions -e <bridge>` process in the agent terminal runtime; this is the only OMP process.
- Attach the OMP adapter as the terminal driver and attach bridge/transcript sources as observers when present.
- Start with `tui.input.write` only. TUI-001 may enable one harmless deterministic OMP command only when exact pinned 18.6.1 behavior is locally verified. Otherwise it remains **FAIL** and the command capability is disabled.
- TUI-002 succeeds when the same process supports a terminal observer and optional semantic observer with clear provenance; it does not require semantic control availability.

## E2E Blocker Classification
Every E2E result MUST be one of:
- **PASS**: executed against the pinned real binary and asserted the claimed behavior.
- **FAIL**: executed and violated its assertion; disable the affected capability.
- **BLOCKED_ENVIRONMENT**: binary, TTY, credential, daemon, or platform prerequisite unavailable before execution.
- **BLOCKED_UPSTREAM**: pinned OMP has no verified public API/mechanism for the requested action.
- **BLOCKED_OBSERVABILITY**: process ran but no reliable observable proves the action.

A blocked or failed semantic action MUST NOT be represented as terminal success. Terminal interaction remains available unless the terminal itself is unavailable.

## Non-goals
- No hidden/headless OMP process, simulated harness UI, ANSI-derived semantic success, blind key injection, or duplicate submission retry.
- No adapter framework beyond the concrete OMP baseline and the small route contract.
- No Claude/Codex adapter work before the OMP vertical slice is real and verified.
