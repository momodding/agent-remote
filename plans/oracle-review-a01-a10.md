# Independent Oracle Review — A01–A10 Remediation

**Review scope:** commits `13bad16` through `484fd61` (inclusive) and current source, measured against `plans/recover-agent-architecture.md` and the A01–A10 ledger in `plans/android-runtime-ux-remediation.md`.

**Method:** static source and committed-test review only. No code was changed. Blocked Android/browser/runtime gates were not re-run. A **PASS** below is source/committed-test proof, not Android-device proof. **UNRESOLVED** means the specified Android/runtime evidence is still unavailable. **FAIL** is a source-level contract break and a release blocker.

## Executive disposition

| Area | Result | Basis |
|---|---|---|
| A01 lifecycle: active runtime versus retained history/tab | PASS (source) / UNRESOLVED (Android) | Exited backing runtimes are inactive while locally retained tabs remain history rows; device reconciliation remains unobserved. |
| A02 terminal transport error handling | FAIL | Embedded Agent Terminal consumes neither `session.state` nor `error` channel messages, unlike the standalone Terminal route. |
| A04 exactly-one OMP process and five sequential turns | PASS (fixture/source) / UNRESOLVED (real Android/OMP PID) | The new five-turn test preserves one agent/terminal/OMP session/bridge identity, but it uses a mock terminal manager and does not observe a real OMP PID. |
| A05 activity protocol and rendering | FAIL | Activity events are stored and live-forwarded but are excluded by runtime replay allowlisting, producing a reconnect race/loss path. |
| A06 Android IME composer/layout | PASS (source/component) / UNRESOLVED (device bounds) | Android keyboard inset is measured, applied to Chat, and scrolls the list; no actual Android IME/layout observation was run. |
| A03/A07/A09 sheet/layout/content/touch remediation | PASS (source/component) / UNRESOLVED (device matrix) | Source changes add scroll/Android keyboard behavior, expandable tool payloads, and 48px named Agent controls; device/font-scale/gesture proof remains unavailable. |
| A10 semantic visibility security | PASS (source) / UNRESOLVED (live OMP/device) | Bridge and transcript reject custom/hook content, server replay excludes internal kinds, and UI is allowlist-only. |
| A08 noVNC direct ticket transport and diagnostics redaction | FAIL | Ticket mechanics and redaction are sound, but the proxy explicitly disables WebSocket origin verification and can issue `ws://` URLs from an HTTP public endpoint; neither enforces the required WSS/origin security boundary. |

## Findings

### A01 — lifecycle semantics: active runtime, history row, and tab

**PASS — source proof.** `client/src/lib/session-surface.ts` computes `active: status !== 'exited'` for tab-backed Agent and Terminal surfaces. It omits exited remote-only Agent/Terminal surfaces, while retaining an explicitly opened exited tab as an inactive historical row. `client/app/index.tsx` visually dims inactive rows. This distinguishes daemon-authoritative active runtime existence from local presentation/history retention, consistent with the architecture plan's rule that local storage is not authoritative existence/state. `client/src/lib/session-surface.test.ts` covers both tab-backed exited Agent and Terminal rows and live-row activity.

`backend/internal/session/manager.go` rejects input/resize for exited or dead backends, emits `terminal.exited`, and records the lifecycle event. `backend/internal/agent/adapter.go` makes bridge lifecycle the state authority and disables interactive capabilities after successful termination.

**UNRESOLVED — Android/runtime evidence.** There is no reviewed device trace proving abrupt OMP/process exit, daemon snapshot/replay, dashboard update, and reopened retained Agent history. In particular, source review cannot prove delivery through an Android background/reconnect transition.

### A02 — terminal transport

**PASS — partial source proof.** `session.Manager.Input` and `Resize` now reject exited/dead backends; `handlePTYWS` returns `session_not_running` rather than swallowing these failures. `WebSocketDaemonChannel.send` reports `input_unavailable` when input would be lost during reconnect, and `Terminal.tsx` safely discards malformed WebView messages. The standalone route (`client/app/terminal/[id].tsx`) shows errors and finishes on exited/not-found state.

**FAIL — shared Agent Terminal error path.** In `client/app/agent/[id].tsx` (PTY subscription at lines 279–301), the callback processes only `pty.baseline` and `pty.output`. It silently ignores `session.state` and `error`, including the newly emitted `session_not_running` and client-generated `input_unavailable`. The same AgentSession/TerminalRuntime can therefore expose a terminal mode that fails with no user-visible transport error or state transition. This violates the remediation goal of eliminating silent terminal transport failures across the shared terminal surface.

**UNRESOLVED — Android evidence.** No allowed runtime evidence establishes IME/WebView key delivery, touch/scroll behavior, ANSI rendering, paste, or reconnect behavior on an APK.

### A04 — one OMP process and five-turn contract

**PASS — fixture/source proof.** `backend/internal/agent/bridge_test.go:1061–1250` adds `TestBridgeFiveTurnSameProcessIdentity`. It drives five distinct sequential prompt commands through one authenticated bridge socket, requires no busy/terminal fallback, verifies ordered/deduplicated ten user/assistant endpoints, and compares AgentSession ID, terminal ID, OMP session ID/file, adapter, and bridge connection before/after. The production source still creates the OMP process inside the single terminal runtime and uses the bridge command path rather than a second agent process.

**UNRESOLVED — real-process and Android proof.** The new test uses `newMockTermMgr`; it has no child process and cannot count an actual OMP PID/TTY. It therefore does not satisfy the plan's explicit real-process acceptance proof (“Count exact PIDs with `ps`, not `grep` output”) and says nothing about five turns on the Android client. No blocked gate was re-run.

### A05 — activity protocol

**PASS — local source proof.** `emitBridgeActivity` maps allowlisted bridge lifecycle events to durable `activity.*` AgentEvents; AgentScreen renders labelled activity rows and committed client tests cover history/live rendering.

**FAIL — replay protocol drops durable activities.** `backend/internal/server/server.go:isAgentEventKind` admits `message.*`, tools, and `state`, but not any `activity.*` kinds. Agent-channel replay at lines 1056–1075 filters through this function. Thus an activity emitted after the client history bootstrap but before/reconnecting channel replay can be persisted yet omitted from replay. This contradicts the plan's snapshot/cursor replay requirement and A05's durable/replayed activity contract. The focused tests only assert thinking/fileMention replay and internal-kind rejection; none asserts activity replay.

### A06 / A03 / A07 / A09 — IME and layout

**PASS — source/component proof.** AgentScreen subscribes to Android keyboard show/change/hide events, derives a bottom inset, applies it to Chat `KeyboardAvoidingView`, and scrolls to the newest message. Tool input/result previews have an explicit Show more/Show less path instead of permanent four-line truncation. The reviewed component tests assert Android keyboard inset application and Android `KeyboardAvoidingView`/scroll configurations in the named sheets. Named Agent header/switcher controls are 48px.

**UNRESOLVED — Android-device evidence.** These changes do not prove actual window-inset behavior, composer/last-message bounds, font-scale behavior, sheet dismissal, narrow-screen clipping, gesture navigation, contrast, or complete touch-target compliance. The ledger's required Android matrix is still absent.

### A10 — semantic visibility security

**PASS — source proof.** Both live bridge (`backend/internal/agent/bridge.ts`) and transcript fallback (`backend/internal/agent/transcript.go`) discard top-level custom messages and nested `custom`/`hookMessage` roles. `isAgentEventKind` rejects `message.system`, `message.custom`, `message.hookMessage`, and `custom_message`; AgentScreen's default renderer returns `null` for every unallowlisted type. This is defense in depth: internal/hook records are neither created as visible semantics, replayed, nor generically rendered. Committed tests cover fallback suppression, replay rejection, and UI allowlisting.

**UNRESOLVED — live runtime evidence.** This review did not run installed OMP against a real hook/custom-event fixture or observe the Android projection. The source controls are strong, but device/runtime proof is unavailable.

### A08 — direct noVNC ticket/WSS and diagnostics

**PASS — source proof for ticket and redaction mechanics.** `DesktopTicketStore` stores only SHA-256 ticket keys, has 32-byte random tickets, 60-second expiry, scope checking, and atomic post-upgrade single-use consumption. `/v1/ws/rfb` validates before dial, consumes after upgrade, enforces binary frames and a 32 MiB read limit, and preserves TCP half-close drain. `logRequests` redacts both `ticket` and `token`; desktop diagnostics retain only a canonical UUID attempt ID, stage names, and byte counts. Server tests cover ticket lifecycle, replay rejection, binary framing, half-close, and redaction.

**FAIL — WSS/origin boundary is not enforced.** `handleDesktopSessionCreate` deliberately emits `ws://` when `PublicEndpoint` is HTTP (`backend/internal/server/server.go:1483–1490`), rather than requiring secure `wss://`. `handleRFBProxy` accepts with `websocket.AcceptOptions{InsecureSkipVerify: true}` at line 1555; this disables the library's origin verification. The surrounding CORS middleware mirrors any supplied Origin and does not impose an allowlist. A one-use ticket limits exposure but does not replace the plan's required WSS/origin security boundary. This is a security release blocker.

**UNRESOLVED — Android/RFB evidence.** No Android noVNC handshake/framebuffer/input/resize/disconnect trace was run. The blocked browser/Android gates are not evidence of a pass.

## Release blockers

1. **A02:** propagate and present terminal `session.state`/`error` events in the embedded Agent Terminal mode (or route it through the existing standalone terminal handling), with a focused regression.
2. **A05:** include the allowlisted `activity.*` event kinds in Agent replay and add a replay/reconnect regression that proves activity events are neither lost nor duplicated.
3. **A08 security:** require a secure WSS endpoint for desktop tickets in production and enforce an explicit origin policy on `/v1/ws/rfb` (while retaining the CIDR policy); add negative tests for insecure endpoint/origin rejection.
4. **Release acceptance evidence remains incomplete:** execute the prescribed real Android evidence after the environment block is resolved: A01 exit/replay, A02 interactive terminal, A03/A06/A07/A09 viewport matrix, A04 five-turn real OMP PID/TTY proof, A05 real activity/replay trace, A08 real Android VNC interaction and diagnostic trace, and A10 live hook/custom suppression.

## Reviewed artifacts

- `plans/recover-agent-architecture.md`
- `plans/android-runtime-ux-remediation.md`
- `plans/recover-agent-architecture-remediation-todo.md`
- `backend/internal/session/manager.go`
- `backend/internal/agent/adapter.go`, `bridge.ts`, `transcript.go`, `bridge_test.go`
- `backend/internal/server/server.go`, `server_test.go`
- `backend/internal/security/desktop_ticket.go`, `desktop_ticket_test.go`
- `client/app/agent/[id].tsx`, `client/app/terminal/[id].tsx`, `client/app/desktop.tsx`, `client/app/desktop.web.tsx`, `client/app/index.tsx`
- `client/src/lib/daemon-channel.ts`, `client/src/components/Terminal.tsx`, `client/src/lib/session-surface.ts` and focused tests

**Verification performed:** commit-range/source inspection and committed-test inspection only; no runtime, Android, browser, build, formatter, linter, or test command was run by this review.
