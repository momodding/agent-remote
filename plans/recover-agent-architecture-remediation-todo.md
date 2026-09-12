# Recover Agent Architecture — Remediation TODO

Baseline: `plans/recover-agent-architecture.md`; main at `2d3e839`; 2026-09-12.

## RAR-001 — Real OMP semantic bridge missing
Severity: P0
Status: DONE — OMP exposes no supported semantic command bridge; transcript-only chat with needs_terminal prompt/abort fallback is the supported integration.
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
Status: TODO
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
Status: TODO
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
Status: TODO
Source: external-code-review
Plan requirement: PTY and tmux preserve terminal bytes for Unicode, paste, controls, escape, and meta input.
Required tests: real tmux byte-level input cases.

## RAR-012 — Runtime replay buffer must resynchronize on overflow
Severity: P1
Status: TODO
Source: lifecycle-replay-advisory
Plan requirement: replay/live handoff is bounded; overflow cannot silently leave a registered WebSocket stale.
Required change: bound `liveEvents` during replay, close/resync the channel or socket on overflow, and test recovery.
Required tests: intentionally overflow replay buffering and observe explicit recovery.
