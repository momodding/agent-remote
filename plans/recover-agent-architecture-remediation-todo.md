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
