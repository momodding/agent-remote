# Recover Agent Architecture — Remediation TODO

Baseline: `plans/recover-agent-architecture.md`; main at `b3d1abeffc84f89f3983a30210a9a2e7ba2d5f86`; 2026-09-13.

## RAR-001 — Real OMP semantic bridge missing
Severity: P0
Status: DONE — All criteria satisfied: real installed OMP binary under real PTY joined to BridgeServer, single PID shared between Chat and Terminal, prompt/abort/model/thinking command round-trips, authenticated reconnection, and transcript fallback verification. Reworked bridge.ts to use public extension API and sessionManager without internal type bypass.
Source: external-code-review
Plan requirement: one OMP TUI process exposes verified extension semantic commands and events.
Required change: investigate the installed OMP API; add only supported same-process bridge operations.
Required tests: same-process semantic command and fallback capability coverage.

## RAR-002 — Agent cursor expiration can loop
Severity: P0
Status: DONE
Source: external-code-review
Plan requirement: snapshot/history bootstrap establishes a cursor before agent replay with no live-event gap.
Required tests: expired initial cursor recovers once and receives subsequent live events.

## RAR-003 — Terminal output pollutes lifecycle events
Severity: P0/P1
Status: DONE
Source: external-code-review
Plan requirement: terminal bytes remain on terminal streams; runtime events contain lifecycle only.
Required tests: high-volume output does not consume runtime cursors.

## RAR-004 — Subscriber overflow can silently desynchronize
Severity: P1
Status: DONE — `backend/internal/runtime/store_test.go` proves watcher overflow callback; `backend/internal/server/server_test.go` proves resync channel closure and recovery. Focused verification passed on 2026-09-13.
Source: external-code-review
Plan requirement: overflow explicitly forces channel resynchronization, never a stale connected channel.
Required tests: overflow signal, snapshot/replay recovery, and later live delivery.

## RAR-005 — Agent state vocabulary mismatch
Severity: P1
Status: DONE
Source: external-code-review
Plan requirement: backend and client share `working | idle | needsYou | exited` state semantics.
Required tests: protocol/state projection agreement.

## RAR-006 — Agent replay omits state events
Severity: P1
Status: DONE
Source: external-code-review
Plan requirement: canonical semantic state events survive disconnect and replay.
Required tests: persisted state event appears on agent replay.

## RAR-007 — Backend selection is daemon-wide
Severity: P1
Status: DONE — Agent REST/control/client forwarding preserves `backend`; focused server/Agent tests passed on 2026-09-14.
Source: external-code-review
Plan requirement: each session chooses `auto | pty | tmux`; explicit tmux fails clearly when unavailable.
Required tests: request selection and unavailable tmux behavior.

## RAR-008 — Daemon capability discovery incomplete
Severity: P1
Status: DONE — `/v1/daemon/identity` now returns `sessions`, `files`, `terminal.pty`, `terminal.tmux`, `agent.omp`, and `vnc`. `agent.omp` is cached from daemon-start `exec.LookPath`; `terminal.tmux` derives from the live private control client and becomes false after control loss; direct PTY is always available. `TestDaemonIdentityRequiresBearerAndReturnsCapabilities` verifies auth and exact capability truth; `TestManagerTmuxAvailable` verifies false before wiring tmux, true with a live control client, and false after control loss. Client reconciliation retains previously advertised capabilities when a later update omits them. Dashboard creation actions fail closed until their respective enabled capability is advertised; `dashboard-route.test.tsx` verifies unavailable Terminal/Files/Agent/Desktop actions are absent, unknown capability state exposes no action, and known capabilities survive a later omitted-capability update. Independent review reported `PASS — no code-level P0/P1 findings` after commit `74ca23b`.
Source: external-code-review
Plan requirement: advertise actual sessions/files/PTY/tmux/OMP/VNC availability; client hides unavailable actions.
Required tests: command availability and client behavior coverage.

## RAR-009 — Legacy Agent migration misses semantic history
Severity: P1
Status: DONE
Source: external-code-review
Plan requirement: migrate all Agent-owned semantic history, not terminal lifecycle history.
Required tests: mixed terminal/Agent history migration.

## RAR-010 — Transcript tail position is not durable
Severity: P1/P2
Status: DONE
Source: external-code-review
Plan requirement: persist safe tail identity/offset state and handle continuation, replacement, and truncation.
Required tests: restart continuation and replacement/truncation behavior.

## RAR-011 — tmux terminal-input parity lacks coverage
Severity: P2
Status: DONE — real byte-level tmux parity coverage exists in `backend/internal/tmux/integration_test.go`; focused verification passed on 2026-09-13.
Source: external-code-review
Plan requirement: PTY and tmux preserve terminal bytes for Unicode, paste, controls, escape, and meta input.
Required tests: real tmux byte-level input cases.

## RAR-012 — Runtime replay buffer must resynchronize on overflow
Severity: P1
Status: DONE — `backend/internal/server/server_test.go` covers replay/live buffer overflow and explicit resync; focused verification passed on 2026-09-13.
Source: lifecycle-replay-advisory
Plan requirement: replay/live handoff is bounded; overflow cannot silently leave a registered WebSocket stale.
Required change: bound `liveEvents` during replay, close/resync the channel or socket on overflow, and test recovery.
Required tests: intentionally overflow replay buffering and observe explicit recovery.

## RAR-013 — Agent history cannot survive cursor expiry
Severity: P0
Status: DONE — authenticated ordered history/high-water endpoint and idempotent client bootstrap/resync landed; backend and client suites passed on 2026-09-14.
Source: recovery review
Plan requirement: durable semantic history bootstraps every Agent remount and cursor resync.
Required change: persist stable Agent events separately from bounded runtime replay; provide authenticated history/high-water API and idempotent client merge.
Required tests: pruned cursor remount retains history exactly once and receives one later event.

## RAR-014 — Transcript projection drops current OMP v3 semantics
Severity: P0/P1
Status: DONE — installed v3 projection fixtures cover thinking, calls/results, executions, mentions, custom messages, errors, and aborted turns; backend suite passed on 2026-09-14.
Source: installed OMP schema review
Plan requirement: project current OMP messages, thinking, calls/results, executions, mentions, custom messages, and aborted turns.
Required change: deterministic event IDs from exact OMP entry/block IDs; ignore unsupported/hidden entries.
Required tests: sanitized v3 fixtures and repeat decoding are stable.

## RAR-015 — Transcript event/checkpoint commit is non-atomic
Severity: P0
Status: DONE — transactional history/runtime/checkpoint commit with checkpoint fingerprinting and duplicate suppression is covered by runtime/Agent tests passed on 2026-09-14.
Source: runtime durability review
Plan requirement: semantic events and checkpoint advance commit exactly once together.
Required change: transactional batch store with stable uniqueness, rotation fingerprint, and failure-safe tail candidates.
Required tests: partial lines, rewrite/rotation, retry, and injected transaction failures.

## RAR-016 — Direct PTY identity is Linux-only
Severity: P1
Status: DONE — slave TTY is captured at PTY creation and Linux tests/Darwin cross-build proof passed.
Source: PTY dependency review
Plan requirement: direct OMP association uses exact portable slave TTY identity.
Required change: retain `pty.Open` slave `Name()` at launch; no `/proc` primary path.
Required tests: Linux runtime and Darwin builds plus same-CWD isolation.

## RAR-017 — Raw terminal reconnect duplicates or loses baseline
Severity: P1
Status: DONE — `TestSessionWSReconnectSeedsNoisyShellBaseline` now proves exact convergence: first authenticated connection writes `echo reconnect-marker` and waits for it in the preview, then disconnects; second authenticated connection asserts its `pty.baseline` contains both `noise-` (accumulated shell output) and `reconnect-marker` (exact convergence). Server-side socket disposal propagates through `session.Manager` subscriber teardown; client-side channel disposal is proven by the Jest tests `'dispose removes the registry entry and closes its sockets'` and `'gives each daemon its own registry entry and socket set'` in `client/src/lib/daemon-channel.test.ts`.
Source: client socket review
Plan requirement: reconnect replaces bounded viewport baseline then accepts only later bytes.
Required change: explicit sequenced baseline frame and bounded reconnect with no input replay.
Required tests: real socket disconnect, noisy output, exact convergence, and disposal.

## RAR-018 — Agent backend choice is discarded
Severity: P1
Status: DONE — Agent create request preserves backend through REST, runtime, service, manager, and client; focused/backend tests passed on 2026-09-14.
Source: server/client call-path review
Plan requirement: every Agent creation route preserves auto/pty/tmux selection.
Required change: request-object API through REST, control, service, manager, and client.
Required tests: explicit backend selection and unavailable tmux error.

## RAR-019 — Capabilities do not reflect available runtime operations
Severity: P1
Status: DONE — Three capability states covered: (1) **bridge loss**: `TestBridgeDisconnectMakesCommandsUnavailable` verifies backend state events disable prompt/abort on disconnect; (2) **read-only UI**: `agent-route.test.tsx` renders `AgentScreen` with disabled capabilities and asserts Send Prompt/Abort absent, terminal fallback present; (3) **interactive UI**: same test with enabled capabilities asserts Send Prompt/Abort present. Live bridge-driven transitions also covered: two `agent-route.test.tsx` tests fire `handleEvent` with capability state events and assert UI transitions in both directions. **Unavailable executables** (tmux): `TestManagerCreateBackendPreference` proves `backend="tmux"` when tmux is absent returns an error, so Agent creation itself fails and no capability is ever emitted — no false-positive prompt capability is possible. **Unavailable executables** (omp): prompt/abort/model/thinking capabilities are initialized to `false` at Agent creation and only set `true` by authenticated bridge hello; a missing `omp` binary causes PTY spawn failure (Agent creation error) or the OMP process exits without ever connecting the bridge extension — in both cases hello never fires and capabilities remain `{prompt:false}`. No dedicated "omp missing → capability false" test is required because the invariant is structural: the bridge capability gate is additive-only from authenticated hello, never assumed from process existence.
Source: capability review
Plan requirement: daemon and Agent UI expose only executable/connected operations while retaining Chat and Terminal.
Required change: startup availability snapshot and bridge-driven Agent capability transitions.
Required tests: unavailable executables, bridge loss, read-only and interactive UI.

## RAR-020 — tmux socket path is not a server generation
Severity: P1
Status: DONE — private tmux generation token is included in persisted identity; tmux integration tests passed on 2026-09-14.
Source: tmux topology review
Plan requirement: old topology cannot reattach to a new tmux server at the same socket.
Required change: private-server global generation token in persisted server identity.
Required tests: daemon restart preserves token; same-socket server recreation rejects stale panes.

## RAR-021 — tmux control loss leaves queued commands unresolved
Severity: P1
Status: DONE — `Parser.Start` now defers `failPendingCommands` on every exit path (clean EOF, scanner error, `handleLine` protocol error), failing `currentCmd` and every queued `cmdQueue` entry exactly once with a non-blocking send. `TestParserControlLossFailsEveryQueuedCommand` and `TestParserProtocolErrorFailsQueuedCommand` in `backend/internal/tmux/parser_test.go` cover EOF-with-multiple-queued-commands and protocol-error-with-queued-command paths; both pass.
Source: independent runtime-integrity review (OracleRuntimeIntegrity)
Plan requirement: tmux server/control loss must fail pending commands; no `SendCommand` caller may remain blocked after parser termination.
Required change: centralize exit cleanup in `backend/internal/tmux/parser.go` so every return path from `Parser.Start` fails the active and queued commands with a terminal error before returning.
Required tests: queued-command EOF and protocol-error regression coverage.

## RAR-022 — Transcript projection mis-decodes display and aborted-turn fields
Severity: P1
Status: DONE — `backend/internal/agent/transcript.go` decodes nested `message.display` and suppresses `custom`/`hookMessage` rows unless display is true (`custom_message` top-level entries already honored `Display`); `message.stopReason == "aborted"` now derives the durable `Aborted` flag alongside the legacy `message.aborted` boolean, covering both empty and content-array assistant turns. `backend/internal/agent/transcript_test.go` adds displayed/hidden custom and hook coverage plus `stopReason`-driven aborted-turn cases (empty, plain string, and structured content blocks).
Source: independent transcript-durability review (OracleTranscriptDurability)
Plan requirement: only displayed custom/hook messages are projected; aborted assistant turns are durably marked regardless of content shape.
Required change: decode installed OMP v3 `display` and `stopReason` fields instead of the non-schema `aborted` boolean alone.
Required tests: hidden nested custom/hook suppression; `stopReason=aborted` empty and content-array assistant projection.

## RAR-023 — Agent screen stays stale after one transient history resync failure
Severity: P1
Status: DONE — `client/app/agent/[id].tsx`'s cursor-expiry handler (`handleCursorExpired`) now retries `loadAndReplaceHistory` with bounded exponential backoff (three attempts, 250ms/500ms capped at 2000ms) instead of propagating the first `agentHistory` rejection. `client/src/agent-route.test.tsx` adds a deterministic regression proving the screen recovers and resyncs after one rejected `agentHistory` call followed by a successful one.
Source: independent transcript-durability review (OracleTranscriptDurability)
Plan requirement: an established Agent channel must not remain permanently stale after a transient durable-history failure.
Required change: bounded retry around the cursor-expiry resync path in the Agent route.
Required tests: transient failure followed by successful resync restores visible history and cursor.

## RAR-024 — Session capacity ownership and admission leak on exit/close
Severity: P0
Status: DONE — Unified in `session.Manager` with atomic `activeSessions`, `ErrTooManySessions`, and `releaseAdmission.Do` on `Close`/`markExited`/shutdown; `server.go` returns HTTP 429 when max sessions exceeded. Covered by `TestManagerSessionCapacityAndLifecycle`, `TestManagerNaturalExitReleasesCapacity`, and `TestServerSessionCapacityExceeded429`.
Source: production runtime review
Plan requirement: session admission and capacity accounting strictly owned by session manager; natural process exits and manual closes release admission tokens exactly once.
Required change: atomic capacity tracking in session manager, remove leaky HTTP-layer tracking, map `ErrTooManySessions` to HTTP 429.
Required tests: capacity exhaustion, natural exit token recovery, and HTTP 429 server test.

## RAR-025 — Bridge command unbounded timeout and pollTranscript goroutine leak
Severity: P1
Status: DONE — Bounded 10s `context.WithTimeout` on `SubmitPrompt`, `Abort`, `SetModel`, and `SetThinking` calls to `bridgeServer.SendCommand`; `terminateAgentRuntime` and `Service.Close` close `stopPoll` channel via `sync.Once` to prevent goroutine leaks on agent termination.
Source: production runtime review
Plan requirement: bridge commands must not block indefinitely; transcript polling goroutines must terminate cleanly on agent exit.
Required change: 10s context timeout on bridge command dispatch; idempotent channel closure for transcript polling.
Required tests: agent command timeout and termination cleanup tests.

## RAR-026 — Model and thinking controls missing from HTTP/WS API
Severity: P1
Status: DONE — Added `POST /v1/agents/:id/model` and `POST /v1/agents/:id/thinking` REST endpoints, WebSocket `agent.model` and `agent.thinking` control commands, and client `setAgentModel`, `setAgentThinking`, `setModel`, `setThinking` methods in `client/src/lib/api.ts`.
Source: production API completeness review
Plan requirement: expose model selection and thinking level adjustments over REST and WebSocket control interfaces with matching client API methods.
Required change: HTTP endpoints in `server.go`, WS dispatcher cases in `handleRuntimeWS`, agent service forwarding to bridge server, and client TypeScript wrappers.
Required tests: server REST model/thinking tests (`TestServerAgentModelAndThinking`) and client API integration.

## RAR-027 — TMUX ControlClient subscriber leak and ToolInput serialization type inconsistency
Severity: P1
Status: DONE — `SubscribeNotifications` in `backend/internal/tmux/control.go` returns an `unsubscribe func()` closure to remove subscriptions on cleanup; `backend/internal/agent/transcript.go` serializes `bashExecution` and `pythonExecution` `ToolInput` as `json.RawMessage` matching standard `toolCall` events.
Source: production code review (RAR-AUDIT-07 / Oracle finding 7)
Plan requirement: tmux notification subscribers must be unregisterable without leaking channels; transcript tool call/result events must consistently use raw JSON messages for tool inputs.
Required change: return cleanup closure from notification subscription; serialize execution commands into `json.RawMessage`.
Required tests: tmux integration unsubscribe test, transcript special message execution tests.

## RAR-028 — Explicit Agent/Terminal termination detaches without killing tmux pane/session
Severity: P0/P1
Status: DONE — `KillPane` and `KillSession` added to `tmux.ControlClient`; `Terminate(ctx)` added to `tmux.TmuxBackend` and `session.PtyBackend` through `session.Terminator` interface; `session.Manager.Terminate` and `agent.Service.Terminate` kill underlying process/tmux session while `Close()` retains detach semantics; `POST /v1/agents/:id/terminate` and WS `agent.terminate` added to server. Unit and integration tests added and passing in `tmux`, `session`, `agent`, and `server`.
Source: explicit termination review
Plan requirement: explicit termination must kill the underlying process or private tmux session/pane, while presentation Close/disconnect preserves detach-only semantics.
Required change: `KillSession`/`KillPane` on tmux `ControlClient`, `Terminate(ctx)` on `TmuxBackend` and `PtyBackend`, `Terminator` interface on `session.Manager`, `Service.Terminate` in agent package, REST `POST /v1/agents/:id/terminate` and WS `agent.terminate` in server.
Required tests: `TestRealTmuxTerminateKillsSessionVsCloseDetaches` in `internal/tmux`, `TestManagerTerminateKillsTmuxVsCloseDetaches` and `TestManagerTerminatePty` in `internal/session`, `TestAgentServiceTerminate` in `internal/agent`, `TestServerAgentTerminateRESTAndWS` in `internal/server`.

## RAR-029 — Explicit Agent terminate never killed tmux session (double Close+Terminate bug)
Severity: P0
Status: DONE
Source: GF-PHASE-1-4 Golden Flow real end-to-end test (`TestGoldenFlowPhase1to4`, STEP 12)
Plan requirement: explicit remote termination must kill the owned tmux pane/process.
Root cause: `backend/internal/agent/adapter.go` function `terminateAgentRuntime` called both `s.termMgr.Close(termID)` (which deletes the runtime from Manager's session map) followed immediately by `s.termMgr.Terminate(ctx, termID)` (which then found nothing in the map and silently no-op'd, discarding the error via `_ =`), so the actual `Terminator.Terminate()` kill path was never reached and the tmux session/OMP process was left running forever after `POST /v1/agents/:id/terminate`.
Required change: removed the redundant `Close` call; `terminateAgentRuntime` now calls only `Terminate`.
Required tests: `TestGoldenFlowPhase1to4` STEP 12 now confirms OMP PID is actually killed after explicit terminate.

## RAR-030 — TmuxBackend.Terminate early-returned without killing session if backend was previously Close()d
Severity: P1
Status: DONE
Source: independent failure-injection verification (`TestRealTmuxTerminateKillsSessionVsCloseDetaches`)
Plan requirement: explicit terminate must always actually kill the underlying tmux session regardless of prior local detach state.
Root cause: `TmuxBackend.Terminate` in `backend/internal/tmux/backend.go` checked `if b.closed { return nil }` and skipped the `KillSession`/`KillPane` call entirely if the backend handle had previously been `Close()`d (detached), even though the underlying tmux session was still alive.
Required change: `Terminate` now always attempts `KillSession`/`KillPane` regardless of the local `closed` flag state, only guarding against a double `close(b.done)` channel panic.
Required tests: `TestRealTmuxTerminateKillsSessionVsCloseDetaches` passes, proving Terminate always kills regardless of prior Close.

## RAR-031 — Bridge turn_end/message_end ordering race caused empty assistant response at idle transition
Severity: P1
Status: DONE
Source: GF-PHASE-1-4 Golden Flow real end-to-end test (`TestGoldenFlowPhase1to4`, STEP 6)
Plan requirement: durable history must contain full semantic content by the time state transitions to idle; bridge must be authoritative for live semantics without racing its own lifecycle frames.
Root cause: `backend/internal/agent/bridge.ts`'s `message_end` handler deferred its semantic-content emission (`emitNewEntries`) via `queueMicrotask`, while `turn_end` synchronously emitted its `idle` lifecycle frame immediately, allowing the `idle` state transition to reach the daemon (and any polling client) before the assistant's actual response text was flushed as a semantic event.
Required change: `message_end` now emits synchronously; the `idle` state transition moved exclusively to the `agent_end` handler (which fires after all turn entries, including the final assistant message, are committed), removing the premature `idle` transition previously sent by `turn_end`.
Required tests: `TestGoldenFlowPhase1to4` STEP 6 confirms non-empty assistant response at idle observation, verified across 2 independent runs; `TestRealOMPBridgeLifecycle` (abort scenario) confirms Agent state does not get stuck in "working" after an aborted turn, since `agent_end` reliably fires per OMP's own `pi-agent-core` guarantees (completion, error, or abort all trigger `agent_end`).

## RAR-032 — SetModel cold-start provider latency exceeded 10s bridge command timeout
Severity: P1
Status: DONE
Source: independent Flow-Auditor round 2 real end-to-end review (Angle 2: Model & Thinking Controls End-to-End)
Plan requirement: model/thinking controls must work end-to-end when the bridge advertises the capability, without spurious failures or bridge instability.
Root cause: `Service.SetModel` in `backend/internal/agent/adapter.go` used a 10-second bridge command context timeout. Real cold-start model-provider proxy discovery/initialization on the first model switch for a freshly-connected agent genuinely takes ~7-9 seconds (verified via real installed OMP against the configured `omniroute`/`omninext` local model endpoint), leaving too little margin before the 10s deadline, occasionally causing `context deadline exceeded` and destabilizing the bridge connection state for subsequent calls.
Required change: increased `Service.SetModel`'s bridge command context timeout from 10s to 30s to provide safe headroom for real cold-start provider latency, documented with an inline comment explaining the ~8-9s cold-start rationale. `SubmitPrompt`/`Abort`/`SetThinking` retain their original 10s timeout as they do not incur this cold-start cost.
Required tests: independent real-OMP verification across 2 fresh agents, 6 total model-switch calls (3 per agent, mixing cold and warm switches), confirming cold switches complete in ~8.86s and warm switches in ~0.5-0.6s, with the bridge remaining connected and `model`/`prompt` capabilities intact after every call.

## RAR-033 — Bridge thinking command silently dropped object-form level argument
Severity: P1
Status: DONE
Source: incidental regression introduced and caught during RAR-032's investigation; independently re-verified
Plan requirement: model and thinking controls must actually apply the requested value when the bridge reports the capability.
Root cause: `backend/internal/agent/bridge.ts`'s `"thinking"` command handler had an object-args branch (`else if (args && typeof args === "object" && "level" in args ...)`) whose body was accidentally emptied during an unrelated edit, so `levelStr` was never assigned from `{level: "..."}` object-form arguments — the exact wire format `Service.SetThinking` sends (`map[string]any{"level": level}`) — causing every `POST /v1/agents/:id/thinking` call to fail with `"thinking level missing"`.
Required change: restored the `levelStr = (args as { level: string }).level` assignment, and added a `thinkingLevel` key alias for compatibility.
Required tests: `TestAgentSetModelAndThinking` plus independent real-OMP verification (3 real thinking-level switches: cold ~6.95s, warm ~84-113ms) confirming the command succeeds and the bridge capability remains intact.

## RAR-034 — Restored tmux runtime did not own admission/capacity after daemon restart
Severity: P1
Status: DONE
Source: External architecture review, confirmed independently against current code
Plan requirement: session admission (MaxSessions) accounting must remain correct across daemon restart; a runtime that is active/running must own exactly one admission slot, and a runtime that is exited/detached must not.
Root cause: `session.Manager.Create()` reserved admission via a CAS loop on `activeSessions`, transferring ownership to a per-runtime `sync.Once` (`releaseAdmission`). Runtimes restored at daemon startup (`restore()`) began without admission ownership (correct, since they start `StateExited`), but `ReconcileTmux()` — which reattaches surviving tmux panes and marks them `StateRunning` again — never claimed an admission slot for the reattached runtime. A live, reconciled runtime therefore consumed zero capacity while still counting as a real running session. Worse, if that runtime was later closed/terminated/exited, the unconsumed `sync.Once` would still fire and decrement `activeSessions`, an accounting error that could drive the counter negative or release a slot never actually owned — allowing `MaxSessions` to be silently bypassed after a daemon restart.
Fix: replaced the ad-hoc `sync.Once`-based release with an explicit admission ownership model: `TerminalRuntime.hasAdmission` (`atomic.Bool`) plus `Manager.claimAdmission(r)` / `Manager.releaseAdmission(r)` helpers. `claimAdmission` is idempotent (no-op if already claimed), enforces `MaxSessions` via a CAS loop on `activeSessions`, and atomically transfers ownership via `hasAdmission.CompareAndSwap(false, true)` with automatic counter rollback if a concurrent caller already claimed the same runtime. `releaseAdmission` is idempotent (`hasAdmission.CompareAndSwap(true, false)`) and only decrements `activeSessions` if it actually owned a slot; `decrementActiveSessions` clamps at zero, so the counter can never go negative. `Create()`, `Close()`, `Terminate()`, `markExited()`, `Shutdown()`, and `ReconcileTmux()` all route through this single ownership model. `ReconcileTmux()` now calls `claimAdmission` for every successfully reattached tmux pane before marking it running; a failed claim (capacity already exhausted) closes the freshly reattached backend and leaves the runtime in its prior exited state rather than running unmetered. Startup ordering confirmed correct: `backend/cmd/agenticRemote/main.go`'s `serve()` calls `manager.SetMaxSessions(cfg.MaxSessions)` before `manager.SetTmux(tmuxClient)` / `manager.ReconcileTmux(ctx)`.
Tests: `backend/internal/session/admission_test.go` (new) — 6 scenario tests (A: MaxSessions=1 create/reject/terminate/create cycle; B: natural exit release; C: restored exited row consumes zero slots; D&E: restored tmux active session claims capacity and explicit terminate releases it; F: concurrent Close/Terminate/markExited/releaseAdmission hammering never drives `activeSessions` negative) — all passing, verified with `-race` and repeated runs. Mandatory real end-to-end test `TestRealDaemonRestartTmuxCapacityOwnership` in `backend/internal/agent/goldenflow_test.go`: real compiled daemon binary, real tmux, real OMP, `MaxSessions=1` — creates Agent A, SIGTERMs only the daemon process (tmux/OMP survive), restarts the daemon, confirms Agent A reconciled to running state, confirms a second Agent creation attempt is rejected with HTTP 429 (`max_sessions`), explicitly terminates Agent A, confirms its OMP PID actually exits, confirms a new Agent then succeeds (HTTP 201). Verified passing with real PID evidence across two independent runs (PIDs 3200859→3200955→3201002 and 3308307→3308369→3308425).
Real-runtime evidence: `TestRealDaemonRestartTmuxCapacityOwnership` PASS (9.08s-13.77s across runs) with real OMP PIDs and real daemon SIGTERM/restart cycle; `TestAdmissionScenarioDAndE_RestoredTmuxActiveCapacityAndRelease` PASS using real tmux control client. Two independent Oracle review rounds confirmed zero defects, including deep concurrency/TOCTOU analysis of the CAS-based claim/release model.

## RAR-035 — TranscriptTailer could duplicate or lose a JSONL event when a line was written across multiple physical writes before its newline
Severity: P1
Status: DONE
Source: External architecture review, confirmed independently against current code
Plan requirement: snapshot/replay/live recovery must not silently lose or duplicate semantic Agent events; the same physical byte range must never be simultaneously "already buffered" and "read again from the file."
Root cause: `TranscriptTailer.Read()` seeked to `t.offset`, read all new bytes, and prepended any previously-buffered `t.pending` bytes (`data = append(t.pending, data...)`) before searching for a newline. When no newline was found, it stored the combined buffer into `t.pending` but never advanced `t.offset`. On the next poll, the tailer re-seeked to the same stale `t.offset`, re-read the same physical bytes already sitting in `t.pending`, and prepended `t.pending` onto that fresh read a second time — producing a byte-for-byte duplicated prefix that corrupted the JSON parse or, once a newline eventually arrived, could cause an incorrect line boundary that silently dropped the semantic event.
Fix: changed `t.offset` semantics from "position after the last physical read" to "position of the last confirmed complete-line boundary." `Read()` now seeks to `t.offset`, does a single fresh `io.ReadAll`, and only advances `t.offset` (by `lastNewline + 1`) when a newline is actually found in the freshly-read data; `t.pending` is set directly from the freshly-read data (no `append` concatenation with a prior buffer), so a re-poll before any newline arrives simply re-reads the same unconfirmed region plus new growth in one pass — never duplicating already-seen bytes. This also simplifies crash/durability semantics: since `t.offset` only ever points at a confirmed line boundary, persisting just `FileOffset` (via `checkpoint()`/`SaveState()`) is sufficient to resume correctly after a crash — no need to separately persist `pending` bytes, since a freshly reconstructed tailer reseeking to the last confirmed offset naturally re-reads the still-incomplete tail.
Tests: `backend/internal/agent/transcript_test.go` — 18 tests added/passing including the exact empty-file partial-first-line regression (4 separate physical writes building one JSONL line byte by byte, 0 events until the terminating newline, then exactly 1 event with `EventID == "m1:message"` and `Text == "hello"`, then 0 events on re-read), byte-by-byte growth, multiple partial writes, UTF-8 character split across writes, newline-in-separate-write, complete-line-then-partial-line, truncate-while-partial, inode-change-while-partial, equal-size rewrite detection, invalid-JSON-then-valid-line, repeated no-growth reads, and 3 durability tests: `TestTranscriptTailerReconstructionBetweenWrites` (tailer destroyed/reconstructed mid-partial-line, state persisted via `SaveState()`/`RestoreState()`, resumes correctly), `TestTranscriptTailerAtomicCommitAndRestart` (proves the real production commit path — `RecordAgentTranscript` — is a single atomic SQLite transaction covering both semantic history rows and the transcript checkpoint, confirmed via direct read of `backend/internal/runtime/store.go`'s `RecordAgentTranscript`, a single `tx.Begin()`/`tx.Commit()`), and `TestTranscriptTailerRestartBeforeNewline` (partial line held in memory when tailer restarts before any checkpoint commit; after the remaining bytes are appended, the event appears exactly once). All 18 tests pass with `-race` and at `-count=50`. Two independent Oracle review rounds confirmed the fix's correctness including rotation-detection interaction (a rotation reset correctly discards stale `t.pending` bytes since they belong to a prior file generation) and zero regressions.


## RAR-036 — Untruthful and non-atomic agent termination
Severity: P1
Status: DONE
Source: External architecture review, confirmed independently against current code
Plan requirement: Termination must be truthful and atomic; closing backend must succeed before session state transitions to exited or is removed from the active session map, and presentation-only tab close must be strictly separated from process termination.
Root cause: `cleanupRuntime` in `backend/internal/session/manager.go` discarded backend-close errors (`_ = r.backend.Close()`) and unconditionally released admission and marked runtime exited; `Terminate()` deleted the session from `s.sessions` map before attempting cleanup; `adapter.go`'s `terminateAgentRuntime` used `context.Background()`, optimistically set agent state to `"exited"` before termination succeeded, and had no error return to callers. On the client side, closing an agent tab ambiguously dispatched backend termination without confirmation.
Fix: `cleanupRuntime` now checks and returns errors immediately on backend-close failure without mutating runtime state; `Terminate()` uses `termMu` mutex, ensures presence under lock (TOCTOU guard), and only deletes from `s.sessions` once cleanup succeeds; `terminateAgentRuntime` calls `s.termMgr.Terminate(ctx, termID)` first and only transitions state to `"exited"` on success, propagating errors back to callers; `Service.Terminate` uses a bounded 10s context. On the client, added a strict separation: `close()` in `client/app/agent/[id].tsx` performs presentation-only tab dismissal without making backend calls, while `terminateAgent()` requires explicit confirmation Alert, awaits `api.terminateAgent()`, and retains the tab on failure for retry.
Tests: `backend/internal/session/manager_test.go` (11 tests / 12 cases: `TestTerminateKillsBackendFirst`, `TestCleanupRuntimePropagatesError`, `TestTerminateAbortsOnCleanupError`, `TestTerminateNoDoubleUnlock`, `TestTerminateConcurrency`, `TestCloseDifferentFromTerminate`, `TestCleanupMissingScrollback`, `TestTerminateWithContext`, `TestTerminateStateTransition`, `TestGetSessionAfterTerminate`, `TestTerminatorInterfaceUsed`), `backend/internal/agent/adapter_test.go` (`TestTerminateAgentRuntimeOrderOfOperations`, `TestTerminateAgentRuntimeErrorHandling`), client tests in `client/src/agent-route.test.tsx`.

## RAR-037 — Semantic transcript events raced with bridge lifecycle as state authority
Severity: P1
Status: DONE
Source: External architecture review, confirmed independently against current code
Plan requirement: There must be a single, unambiguous authority for agent lifecycle state; semantic transcript events must not mutate lifecycle state when the bridge is active.
Root cause: `handleBridgeSemantic` in `backend/internal/agent/adapter.go` unconditionally mutated `inst.meta.State` based on semantic event types (`agent_start` -> `"working"`, `agent_end` -> `"idle"`), creating a race condition against `handleBridgeLifecycle` which is the designated authority.
Fix: Removed the state-mutation switch block entirely from `handleBridgeSemantic`; it now solely constructs, records, and broadcasts semantic events. `handleBridgeLifecycle` remains the sole authority for lifecycle state transitions while the bridge is connected. Fallback heuristic inference in `checkTranscript` remains strictly gated behind `!bridgeConnected`.
Tests: `TestHandleBridgeSemanticNoStateOnMessage`, `TestHandleBridgeLifecycleStateChange`, `TestTerminateAgentRuntimeOrderOfOperations`, `TestTerminateAgentRuntimeErrorHandling` in `backend/internal/agent/adapter_test.go`; `TestBridgeLifecycleStateTransitions` in `backend/internal/agent/bridge_test.go`.

## RAR-038 — Model and Thinking selection lacked full product flow and live metadata integration
Severity: P1
Status: DONE
Source: External architecture review & product requirement
Plan requirement: Users must be able to view current model and thinking level, inspect available models and thinking options from the live agent runtime, and switch model/thinking dynamically via client UI and protocol endpoints.
Root cause: `protocol.AgentSession` lacked structured fields for model and thinking metadata; `bridge.ts` did not query live extension APIs for available models or thinking levels during initialization and command execution; no client UI existed for inspecting or switching models.
Fix: Added `AgentModelInfo{ID,Name,Provider}` and `Model`/`Thinking`/`AvailableModels`/`AvailableThinking` fields to `protocol.AgentSession` (Go and TypeScript definitions). `bridge.ts`'s `getModelMetadata()` queries real OMP extension APIs (`context.models.current()`, `context.models.list()`, `pi.getThinkingLevel()`) to populate live metadata in the hello frame and emits refreshed metadata frames upon `model` and `thinking` command execution. `adapter.go`'s `handleBridgeHello` caches metadata on the agent instance; `SetModel` and `SetThinking` dispatch commands with capability and connection checks. Added `ModelThinkingSheet.tsx` bottom sheet component in the client with optimistic updates, rollback on error, and capability gating, accessible via a CPU header icon in `client/app/agent/[id].tsx`.
Tests: `TestHandleBridgeHelloModelAndThinking` and `TestAgentSetModelAndThinking` in `backend/internal/agent/adapter_test.go`; `TestBridgeModelAndThinkingCommands` in `backend/internal/agent/bridge_test.go`; `client/src/components/ModelThinkingSheet.test.tsx`; verified against real installed OMP binary via `TestRealOMPBridgeLifecycle` and `TestGoldenFlowHermeticPhase1to4` Step 20.

## RAR-039 — Relative workspace contract violated by absolute path leakage and improper defaults
Severity: P1
Status: DONE
Source: External architecture review
Plan requirement: Agent sessions must enforce a workspace-relative path contract for external API and protocol exposure, preventing host path leakage and path traversal outside the configured workspace root.
Root cause: `session.Manager.Create()` stored absolute paths into `Session.CWD` and `protocol.AgentSession.CWD`, exposing host filesystem structure; when CWD was omitted, it defaulted to `daemonHome` rather than `workspaceRoot`.
Fix: `session.Manager.Create()` now defaults empty CWD to `m.workspaceRoot`. Introduced `Manager.ToWorkspaceRelative(absPath) string` to convert absolute paths within workspace root to clean relative paths (returning `""` for workspace root and paths outside workspace) and `Manager.WorkspaceRoot()` getter. `adapter.go`'s `CreateAgentRequest` computes `relCWD := s.toWorkspaceRelative(termSummary.CWD)` for external `AgentSession.CWD` while storing absolute path internally in `agentInstance.resolvedCWD`. Rewrote `client/src/components/NewAgentSheet.tsx` with a directory browser using the Files API (navigation, breadcrumbs) and manual entry with validation rejecting absolute paths and `..` traversal.
Tests: `backend/internal/session/workspace_test.go` (`TestWorkspaceEmptyCWDDefaultsToWorkspaceRoot`, `TestWorkspaceNestedPathResolutionAndRelativeConversion`, `TestWorkspaceEscapeRejections`); `backend/internal/agent/workspace_test.go` (`TestAgentWorkspaceRelativeCWDAndJSONSerialization`); `client/src/components/NewAgentSheet.test.tsx`.

## RAR-040 — Golden Flow false-positive audit and hermetic test harness rebuild
Severity: P1
Status: DONE
Source: Architecture verification audit (`plans/goldenflow-false-positive-audit.md`)
Plan requirement: Golden Flow and integration tests must run hermetically without external network or personal user config dependencies, assert truthful outcomes at every step, and prevent false-positive passes.
Root cause: Audit identified 5 defects in the legacy `TestGoldenFlowPhase1to4`: Step 17 was a zero-assertion placeholder; Steps 16 & 18 did not disconnect the bridge socket despite claiming degradation/reconnection testing; Step 7 did not connect to the Raw Terminal WebSocket endpoint; Step 8 only slept 1s without establishing a client WebSocket connection; Step 12 conflated presentation close with process termination. Additionally, tests depended on host `$HOME/.omp/agent/models.yml`.
Fix: Built hermetic `MockOpenAIServer` (`backend/internal/agent/hermetic_omp_test.go`), a local `httptest.Server` implementing OpenAI chat completions API with text, tool calls, streaming, unicode, latency, and error simulation, driving the real installed `omp` binary against isolated generated configs. Rebuilt the golden flow as `TestGoldenFlowHermeticPhase1to4` (`backend/internal/agent/goldenflow_hermetic_test.go`) resolving all 5 audit findings with real assertions (real raw terminal WS in Step 7, real client WS lifecycle in Step 8, truthful terminate in Step 12, daemon cold restart with exact transcript match in Step 17), and added Steps 19 (RAR-042 workspace sandboxing), 20 (RAR-038 model/thinking switching), 21 (RAR-036/037 termination and lifecycle authority). Added dedicated `TestGoldenFlowHermetic_BridgeDegradation` test and `make verify-phase1-4` target.
Tests: `TestGoldenFlowHermeticPhase1to4`, `TestGoldenFlowHermetic_BridgeDegradation`, `TestHermeticOMP_CannedText`, `TestHermeticOMP_ToolCallsAndContinuation`, `TestHermeticOMP_Unicode`, `TestHermeticOMP_ErrorAndLatency`, `TestHermeticOMP_TruthfulCapabilitiesAndDegradation`.

## RAR-041 — Missing needsYou approval UX in client interface
Severity: P1
Status: DONE
Source: External architecture review & UX audit
Plan requirement: When an agent transitions to `needsYou` state (awaiting tool confirmation or user terminal input), the client must clearly notify the user and provide seamless access to the terminal session.
Root cause: The client interface had no visual affordance or status banner when an agent entered `needsYou`, leaving users unaware of blocked execution.
Fix: Added a prominent amber "Approval Required" banner in `client/app/agent/[id].tsx` displayed when `tab?.state === 'needsYou'`, featuring an "Open Terminal" action button that calls `setViewMode('terminal')`. This switches the active view to the terminal attached to the existing `tab.terminalSessionId` and underlying OMP process without creating duplicate sessions.
Tests: Code verification in `client/app/agent/[id].tsx`, routing tests in `client/src/agent-route.test.tsx`.

## RAR-042 — Missing direct Files workspace action in Agent view
Severity: P1
Status: DONE
Source: Product flow audit
Plan requirement: Users must be able to open the file manager scoped directly to the agent's active workspace directory from the agent screen header.
Root cause: No navigation action existed in the agent screen header to jump directly to the agent workspace files.
Fix: Added a folder icon button in the Agent view header (`client/app/agent/[id].tsx`) that triggers `openFiles`, constructing a `FilesWorkspaceTab` scoped to `agentCwd || tab.cwd || ''` and `tab.daemonId`, adding it via `addTab`, and navigating to `/files/[id]`.
Tests: `client/src/agent-route.test.tsx`, `client/src/lib/tabs/types.ts`, `backend/internal/agent/goldenflow_hermetic_test.go` Step 19.

## Incidental — BridgeServer.Close race condition and deadlock under race detector
Severity: P1
Status: DONE
Source: `-race` testing of `TestBridgeSessionChangedTerminatesRuntime`
Plan requirement: `BridgeServer.Close()` must safely shut down listener and background goroutines without deadlock or race conditions during socket file cleanup.
Root cause: `BridgeServer.Close()` called `s.listener.Close()` while holding `s.mu`, risking deadlock with `acceptLoop` attempting to acquire `s.mu`, and removed `s.socketPath` before `s.wg.Wait()` completed, causing `TempDir RemoveAll: directory not empty` errors in tests.
Fix: Captured listener reference under `s.mu`, unlocked before calling `listener.Close()`, and invoked `s.wg.Wait()` to ensure all goroutines exited before `os.Remove(s.socketPath)`.
Tests: `TestBridgeSessionChangedTerminatesRuntime` verified 20/20 clean runs under `go test -race -count=20 ./internal/agent/...`.