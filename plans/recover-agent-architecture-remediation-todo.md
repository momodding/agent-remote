# Recover Agent Architecture — Remediation TODO

Baseline: `plans/recover-agent-architecture.md`; main at `b3d1abeffc84f89f3983a30210a9a2e7ba2d5f86`; 2026-09-13.

## RAR-001 — Real OMP semantic bridge missing
Severity: P0
Status: IN_PROGRESS — `TestRealOMPBridgeLifecycle` joins installed OMP 18.1.15 under a real PTY to production `Service.CreateAgentRequest`/`session.Manager`/`BridgeServer`, proves authenticated capability enablement and `thinking`/`abort` command round trips, forcibly disconnects the production bridge connection, observes controls disable, then observes controls restore with the same OMP PID, session ID, and session file (2026-09-14). `TestRestoredAgentAcceptsPersistedBridgeCredential` proves immutable OMP session ID/session-file binding survives service restart, matching reattachment succeeds, and a credential-valid mismatched identity cannot displace the valid bridge or change the durable transcript association. `TestBridgeHelloReplacesFallbackTranscriptTailer` proves authenticated OMP identity replaces a provisional fallback transcript path. Remaining evidence: live prompt/semantic turn and real macOS runtime.
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
Status: TODO
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
Status: IN_PROGRESS
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
Status: DONE — Agent state events carry bridge capabilities; the active Agent screen bootstraps them from the Agent snapshot, updates them live, exposes prompt and Abort only while enabled, and otherwise provides `Open Terminal to interact`. `TestBridgeDisconnectMakesCommandsUnavailable` verifies connected/disconnected state events enable then disable prompt capability.
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
