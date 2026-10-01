# Independent Oracle Review — A01–A10 Post-Fix Disposition

**Date:** 2026-10-02
**Scope:** current `HEAD` (`71394079c29b29437c4888c926568195da84c721`) after the A02, A05, and A08 remediation commits, reviewed against `plans/recover-agent-architecture.md` and `plans/android-runtime-ux-remediation.md`. The prior review's source blockers are re-evaluated here.

**Method:** source and committed-test inspection only. No product code was changed. No Android, browser, real-OMP, build, or other blocked runtime gate was run. Therefore **PASS** means source/committed-test-contract proof only; Android/browser/device evidence is always **UNRESOLVED** unless a recorded device artifact is named.

## Executive disposition

| Area | Post-fix disposition | Source proof | Runtime/device disposition |
|---|---|---|---|
| A01 lifecycle: active runtime versus retained tab/history | PASS | Exited runtime rows are inactive/visually dimmed when a local history tab remains; remote-only exited rows are omitted; terminal exit produces recorded lifecycle state and Agent capabilities fail closed. | UNRESOLVED — no Android exit/crash/reconnect trace. |
| A02 terminal transport and embedded Agent Terminal | PASS | Dead/exited input and resize return errors; PTY WS forwards them; Agent Terminal shows errors, disables its controls, unsubscribes, and marks its tab exited. | UNRESOLVED — no device IME, paste, ANSI, or reconnect interaction proof. |
| A03 modal/sheet overflow | PASS | The committed component contracts use Android height avoidance/internal scrolling for the changed modal/sheet surfaces. | UNRESOLVED — no portrait/narrow/font-scale/gesture device matrix. |
| A04 multi-turn, shared OMP process | PASS | One AgentSession references one TerminalRuntime; five-turn bridge test preserves Agent/terminal/OMP-session/bridge identity and durable order; hermetic flow source counts exactly one real OMP PID. | UNRESOLVED — no newly observed Android five-turn/background/reconnect run. |
| A05 structured activity protocol | PASS | Bridge lifecycle maps to exactly six durable `activity.*` kinds; all six are replay-allowlisted and rendered as labelled non-chat rows; unknown activity remains denied. | UNRESOLVED — no real tool/thinking/approval timeline correlated to Android UI. |
| A06 composer/Android IME | PASS | Android keyboard inset is measured, applied to the chat container, and reset; focused test exercises show/hide behavior. | UNRESOLVED — no physical IME/inset/font-scale bounds. |
| A07 complete chat content | PASS | Tool input/result previews have explicit expand/collapse rather than permanent truncation; semantic event ordering is covered by source tests. | UNRESOLVED — no narrow-device long prose/token/code observation. |
| A08 direct noVNC, ticket/WSS/origin/redaction | PASS | Tickets are hash-only, scoped, expiring, single-use; only HTTPS public endpoints can issue desktop tickets and they always return `wss://`; cross-origin RFB upgrades are rejected; request logs redact ticket/token and diagnostics carry only validated attempt IDs/stages/byte counts. | UNRESOLVED — no Android WebView/RFB/framebuffer/input/resize/logcat trace. |
| A09 mobile quality | PASS (limited source claim) | Named changed Agent, Desktop, and multi-terminal touch controls meet the 48dp source floor; narrow Agent header actions move behind an accessible overflow control. | UNRESOLVED — contrast, high-DPI, orientation, complete touch ergonomics, and layout shifts require a device review. |
| A10 semantic visibility security | PASS | Live bridge and transcript fallback discard custom/hook provenance; replay has an exact allowlist that continues to reject internal kinds; AgentScreen renders only allowlisted event types. | UNRESOLVED — no live installed-OMP hook/custom fixture displayed on Android. |

## Re-review of the prior source blockers

### A02 — embedded Agent terminal error/state presentation: PASS

`client/app/agent/[id].tsx` now subscribes to all relevant terminal frames:

- `session.state: exited` sets the visible **“Terminal session ended”** error, marks the embedded terminal inactive, clears capabilities, updates the Agent tab to `exited`, and unsubscribes.
- `error: session_not_found` follows the same inactive path.
- Other transport errors, including `session_not_running` and client-side reconnect `input_unavailable`, are presented in the `Terminal transport error` banner.
- `Terminal` input/resize and `ShortcutKeyboard` are gated while inactive, so the stale terminal cannot accept input after its exit.

`client/src/agent-route.test.tsx` covers the error banner, exited-state update, dispatch, and removal of the shortcut keyboard. The server/manager path still rejects writes/resizes to dead runtimes and sends `session_not_running`; the standalone terminal route retains its own error/exit handling.

### A05 — activity replay allowlist: PASS

`backend/internal/agent/adapter.go` emits exactly these durable activity kinds from allowlisted bridge lifecycle events:

- `activity.turn.started`
- `activity.tool.started`
- `activity.tool.completed`
- `activity.tool.failed`
- `activity.approval.requested`
- `activity.approval.resolved`

`backend/internal/server/server.go:isAgentEventKind` now admits exactly those six kinds alongside the existing visible semantic kinds. It does not use an `activity.*` wildcard. The Agent-channel replay path filters through that allowlist, so the earlier bootstrap/reconnect replay loss path is closed. `TestAgentReplayAllowsAdapterActivityEvents` asserts all six pass and an unrecognized activity does not; `TestAgentReplayRejectsInternalOnlyKinds` remains in place. AgentScreen has distinct labelled activity renderers, not a generic system-text fallback.

### A08 — direct RFB WSS/origin policy and diagnostic redaction: PASS

`config.Validate` now rejects every `http` public endpoint. `desktopWebSocketBase` accepts only an HTTPS public endpoint and returns a `wss://` base; `POST /v1/desktop/sessions` fails before ticket issuance otherwise. The committed tests reject public HTTP, IPv4 loopback HTTP, `localhost` HTTP, and IPv6-loopback HTTP, and require a `wss://` ticket URL on success.

`handleRFBProxy` rejects an Origin different from the configured public endpoint before ticket validation/dial. Its `websocket.AcceptOptions` no longer uses `InsecureSkipVerify`; `OriginPatterns` is constrained to the configured endpoint. The coder/websocket origin matcher supports a scheme-qualified pattern, and `TestHandleRFBProxyRejectsCrossOriginUpgrade` verifies a cross-origin request receives 403. Empty Origin remains permitted for non-browser/native clients, but the one-use scoped ticket and CIDR policy still apply.

The noVNC surfaces construct `new RFB(screen, wsUrl)` directly. They do not bridge RFB bytes through React Native messages. Ticket/token query fields are redacted before request logging; diagnostics use a validated UUID attempt ID, stage name, and aggregate byte counts, with no ticket, bearer token, prompt, or RFB frame payload included.

## Continuing architectural invariants reviewed

- **Single runtime ownership:** Agent Chat and Raw Terminal retain the shared `terminalSessionId`; the Agent view sends raw terminal traffic only through that terminal stream, while semantic commands use the bridge.
- **Lifecycle authority:** bridge lifecycle frames, not semantic message frames, set Agent state. Terminal read failure marks the terminal exited, records `terminal.exited`, and Agent terminal watch/termination follows that lifecycle.
- **History versus existence:** `SessionSurface.active` derives from current daemon runtime state; retained local tabs are presentation/history, not proof of an active runtime.
- **One-process invariant:** the five-turn bridge test holds Agent ID, terminal ID, OMP session ID/file, adapter, and bridge connection constant. The hermetic Golden Flow source explicitly counts one candidate OMP process by `/proc` identity for the AgentSession.
- **Semantic security:** custom/hook/system provenance is denied by the bridge and transcript projectors, denied by replay admission, and denied by UI rendering. File mentions, assistant/user messages, tool calls/results, thinking, state, and the six activity events are explicitly handled.
- **noVNC transport:** ticket validation precedes VNC dial; successful WebSocket upgrade atomically consumes the ticket; the proxy is binary-only, has a read limit, protects concurrent WebSocket writes, and preserves supported TCP half-close drain behavior.

## Remaining release-acceptance evidence — all UNRESOLVED

These are not source failures, but they remain mandatory evidence gaps for an Android/browser release:

1. **A01:** terminate/crash a real Agent/terminal, capture terminal and Agent lifecycle cursors, daemon snapshot/replay, dashboard inactive history row, and Android remount/reconnect result.
2. **A02:** physical Android terminal marker through IME and paste, including WebView input, reconnect/error presentation, ANSI output, and scrollback behavior.
3. **A03/A06/A07/A09:** portrait and narrow-device screens at normal and increased font scale, IME open/closed, system gesture/navigation insets, final sheet-control reachability, chat bounds, touch targets, contrast, and orientation where supported.
4. **A04:** five distinct sequential prompts on one Android Agent, with real OMP PID/TTY, AgentSession/terminal/OMP-session identity, semantic cursors, and background/foreground or reconnect behavior captured.
5. **A05:** one real thinking/tool/approval sequence correlated across bridge events, durable/replayed cursor history, and Android activity rows.
6. **A08:** Android WebView direct WSS connect, RFB negotiation, first framebuffer, pointer/key input, resize/disconnect/retry, and sanitized proxy/logcat attempt timeline.
7. **A10:** a controlled harmless custom/hook fixture proving it is absent from daemon-visible chat history and Android bubbles.

## Reviewed artifacts

- `plans/recover-agent-architecture.md`
- `plans/android-runtime-ux-remediation.md`
- `backend/internal/session/manager.go`
- `backend/internal/agent/adapter.go`, `bridge.ts`, `transcript.go`, `bridge_test.go`, `goldenflow_hermetic_test.go`
- `backend/internal/server/server.go`, `server_test.go`, `desktop_phase5_test.go`
- `backend/internal/security/desktop_ticket.go`
- `backend/internal/config/config.go`, `config_test.go`
- `client/app/agent/[id].tsx`, `client/app/terminal/[id].tsx`, `client/app/desktop.tsx`, `client/app/desktop.web.tsx`
- `client/src/lib/daemon-channel.ts`, `client/src/lib/session-surface.ts`, and focused client tests

**Review verification:** source and committed-test inspection only. No runtime gate was re-run; no browser, Android, emulator, build, formatter, linter, or test command was run during this review.
