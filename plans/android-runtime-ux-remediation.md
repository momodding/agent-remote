# Android Runtime UX Remediation Ledger

## Baseline & Provenance

### Git State
- **HEAD Commit**: `2248bda36e5e9d60821363f110c35da55437868f`
- **Git Status**: clean (`git status --short` shows only untracked architecture analysis notes)
- **Latest Commit**: `2248bda omp(android-distributability): Fix proven Android build blocker`

### APK Artifacts & Provenance Analysis

| Field | Manually Verified Device APK | Build Retry Multi-ABI APK |
|---|---|---|
| **Path** | `builds/client-android.apk` | `builds/android-build-retry.apk` |
| **Size** | 52,115,902 bytes | 78,943,691 bytes |
| **SHA-256** | `30bad937e02ed694fe7ec4f9ad00abe385fbc676d6ab338ffe0f446c0c4d1623` | `278d81a0926d31b7e91c70e62c05c4e0235be7ff27bfb3a7f1ec0ab42abeba6c` |
| **Build Timestamp** | 2026-09-23 13:57:58 +0700 (06:57:58 UTC) | 2026-09-30 13:53:04 +0700 (06:53:04 UTC) |
| **ABIs Included** | `arm64-v8a` | `arm64-v8a`, `x86_64` |
| **App Config `buildArchs`** | `["arm64-v8a"]` | `["arm64-v8a", "x86_64"]` |
| **Version Code** | `8` | `8` |
| **App Version** | `1.0.0` | `1.0.0` |
| **SDK Version** | `57.0.0` | `57.0.0` |

### HEAD Match Verification
- **Physical Device Target (`builds/client-android.apk`)**:
  - Used for manual verification on Motorola Moto G45 (`arm64-v8a`).
  - Built on 2026-09-23 against pre-`2248bda` worktree (`buildArchs: ["arm64-v8a"]`).
  - **Match**: `NO` (precedes commit `2248bda`).
- **Build Retry Target (`builds/android-build-retry.apk`)**:
  - Built on 2026-09-30 13:53:04 +0700 prior to commit timestamp 14:04:11 +0700 from dirty worktree containing the changes committed in `2248bda`.
  - **Match**: `SOURCE_EQUIVALENT` (matches code changes in `2248bda`, built before commit object creation).

### Environment & Package Versions
- **Client Package Version**: `1.0.0` (`client/package.json`)
- **Expo Version**: `~57.0.7` (dependency) / `57.0.7` (canonical) / SDK `57.0.0` (`client/app.json`)
- **React Native Version**: `0.86.0` (`client/package.json`, `e2e-lab/env/versions.env`)
- **OMP Version**:
  - Host CLI: `omp/18.2.8` (`omp --version`)
  - Pinned Lab Runtime: `18.1.22` (`e2e-lab/env/versions.env`)

---

## Remediation Backlog (A01–A10)

> **Correction Note (2026-10-01):** The initial version of this table erroneously imported emulator lab harness gates (A01–A06 from `e2e-lab/ANDROID_E2E_TODO.md`). This table is now corrected to the user-authoritative manual defect taxonomy (A01–A10) covering runtime UX issues observed during device evaluation.

| ID | Defect Title | Status | Acceptance Evidence Required | Fact vs. Unproven Distinction |
|---|---|---|---|---|
| **A01** | Exited/expired session remains active | OPEN | Process exit/expiry cleanly transitions backend session to inactive, terminates stream, updates UI status indicator, and disables stale inputs. | **Fact:** `session.Manager` tracks session state. **Unproven:** Graceful status transition and UI reconciliation upon abrupt agent crash, process exit, or network expiration on Android. |
| **A02** | Terminal unusable | OPEN | Interactive PTY renders on mobile; keystrokes, mobile keyboard input bar, ANSI sequences, and scrollback function without freeze or clipping. | **Fact:** PTY WebSocket endpoint `/v1/ws/sessions/:id` exists. **Unproven:** Usable mobile terminal ergonomics, touch gestures, and software keyboard integration on Android APK. |
| **A03** | Modal/sheet overflow | OPEN | Modals and bottom sheets fit within viewport, scroll overflowing content internally, and respect system gesture/navigation safe area insets. | **Fact:** Bottom sheet UI components exist in `client/src`. **Unproven:** Dynamic height recalculation, internal scrolling, and gesture dismiss across varied Android screen sizes. |
| **A04** | Multi-turn OMP chat | OPEN | Sequential multi-turn prompts and responses sustain state, stream sequentially, and preserve conversation history without turn loss or crash. | **Fact:** Client/daemon chat protocol messages exist. **Unproven:** Sustained multi-turn conversation reliability and state retention on live Android client. |
| **A05** | Useful OMP processing/activity | OPEN | Granular execution progress (tool executions, thinking, status updates) displayed with informative visual feedback during active tasks. | **Fact:** Runtime channel receives semantic events. **Unproven:** Informative, real-time activity indicators rendered cleanly on mobile screen rather than generic loading spinners. |
| **A06** | Composer covered by Android IME | OPEN | Chat input composer bar remains visible above Android virtual keyboard upon focus without blocking view of recent chat messages. | **Fact:** `KeyboardAvoidingView` present in components. **Unproven:** Proper keyboard offset handling across diverse Android IME heights and gesture navigation modes. |
| **A07** | Chat content clipped/incomplete | OPEN | Message text, markdown formatting, code snippets, and diff views render fully with horizontal scrolling for wide blocks and no vertical clipping. | **Fact:** Markdown/code rendering libraries imported in client. **Unproven:** Complete wrapping, code block bounds, and viewport constraint enforcement on narrow mobile screens. |
| **A08** | noVNC Creating RFB | OPEN | Desktop VNC connects to live display server without hanging on "Creating RFB"; connection state machine handles handshake without fake timeouts. | **Fact:** Desktop VNC view and bridge exist; fake `setTimeout` readyState bypass removed. **Unproven:** Reliable RFB handshake and live framebuffer rendering on Android client over remote proxy. |
| **A09** | Mobile UI quality | OPEN | Touch targets >= 48x48dp, contrast ratios meet WCAG AA, typography and spacing consistent, layout free of jarring shifts. | **Fact:** Styling uses Tailwind tokens in client. **Unproven:** Systematic compliance with mobile ergonomics, touch target sizing, and high-DPI scaling across Android devices. |
| **A10** | Internal system/hook content leak | OPEN | Internal harness directives, system prompts, raw event frames, and hook metadata are filtered out from user-visible chat bubbles. | **Fact:** Protocol channels process incoming events. **Unproven:** Strict client-side / server-side sanitization preventing internal control tokens or system messages from leaking into chat. |

*Historical E2E ledger preserved in `e2e-lab/ANDROID_E2E_TODO.md`.*

---

## Pinned OMP 18.1.22 Capability Matrix (2026-10-01)

**Scope and evidence.** This matrix is limited to the lab pin (`OMP_VERSION="18.1.22"` in `e2e-lab/env/versions.env`) and the version-tagged upstream extension API/docs: [`types.ts`](https://github.com/can1357/oh-my-pi/blob/v18.1.22/packages/coding-agent/src/extensibility/extensions/types.ts), [`extensions.md`](https://github.com/can1357/oh-my-pi/blob/v18.1.22/docs/extensions.md), and [`extension-ui-controller.ts`](https://github.com/can1357/oh-my-pi/blob/v18.1.22/packages/coding-agent/src/modes/controllers/extension-ui-controller.ts). Agent Remote facts are from `backend/internal/agent/bridge.ts`. “No bridge support” means no frame/command in the bridge's advertised capabilities (`prompt`, `abort`, `model`, `thinking`); it does **not** deny an upstream OMP feature. No product API is inferred from a slash command or the current host OMP 18.2.8.

| Capability | Upstream 18.1.22 support and observable state | Upstream controllability / access form | Agent Remote support today | Safe Android UI representation |
|---|---|---|---|---|
| **Plan** | Plan-mode behavior is referenced in the tagged extension docs (message delivery and plan-mode compaction wording). The examined public extension surfaces do not establish a general plan-mode state, getter, or control contract. | **Not established** as a general extension API or slash contract from the pinned sources examined. | **No bridge projection/control.** | Do not add a Plan toggle or state badge. Raw Terminal remains the only faithful surface for any native plan-mode UX. |
| **Vibe** | No `vibe` event, API, or command contract was found in the tagged public extension sources examined. | **Not established.** | **No bridge support.** | Do not represent it. |
| **Goal / Loop** | `goal_updated` is a typed extension event. No distinct public “loop” state/control was established by the pinned sources examined. | Goal is **observable to an extension** through `pi.on("goal_updated", ...)`; no goal mutation or loop-control API was established. | **No bridge projection/control.** | If later bridged, show a read-only goal/activity summary. Do not expose loop controls. |
| **Model** | `ExtensionContext.models.current()` / `.list()` provide live current/available model metadata. | **Extension API:** `pi.setModel(model)`; session slash UX may exist independently, but is not needed for the bridge. | **Supported and controlled:** bridge resolves the requested model, calls `pi.setModel`, then emits metadata; remote protocol carries current/available models. | A picker limited to bridge-advertised `availableModels`, with current model shown. No free-form provider/model contract beyond bridge resolution. |
| **Thinking** | `pi.getThinkingLevel()` / `pi.setThinkingLevel(level)` are public extension actions. Thinking content is also a typed semantic entry. | **Extension API**; not slash-only. | **Supported and controlled:** bridge calls `pi.setThinkingLevel`, emits metadata, and projects `message.thinking`. The bridge’s hard-coded level list is an Agent Remote policy, not evidence of an upstream enum guarantee. | A picker populated from bridge metadata; disclose thinking only as ordinary transcript content and preserve terminal as the complete source. |
| **Abort** | Handler context provides `abort()`; interactive runtime delegates it to the session abort path. | **Extension-context API**; not slash-only. | **Supported and controlled:** `abort` invokes `latestCtx.abort()` and returns an explicit failure if no active context exists. | A visible Cancel action only while the remote state is working; render the resulting aborted entry/state rather than claiming a silent success. |
| **Todo / progress** | `todo_reminder` is a typed extension event; tool-call/result and turn/session lifecycle events can provide progress. The examined surface does not establish a public todo-list mutation API. | **Observable extension events**; no todo create/resolve control was established. | **Partial observability only:** the bridge projects assistant text/thinking and tool calls/results, but does not advertise todo/progress capability or a todo snapshot. | Passive activity timeline/spinner derived from actual semantic events. Do not fabricate a mutable todo checklist. |
| **Tools** | Extensions can register LLM-callable tools and observe/intercept `tool_call` / `tool_result`; tool definitions include an `approval` property. | **Extension registration and event APIs**; active-tool mutation exists upstream (`getActiveTools` / `setActiveTools`) but is not exposed by the bridge. | **Observed only:** bridge emits `tool.call` and tool-result semantic entries; it exposes no remote enable/disable/register control. | Collapsible, read-only tool cards with command/output bounds; no tool-management switches. |
| **Approval / needs-you** | Typed `tool_approval_requested` and `tool_approval_resolved` events exist upstream. | Approval event observation is **extension API**. A remote approve/reject control was not established. | **Observed state, no verified control:** bridge emits `approval_requested` with `state: "needsYou"` and `approval_resolved`, but advertises no decision command. | A non-actionable “needs attention in terminal” indicator; route the user to Raw Terminal for native prompts. Never show Approve/Reject until an end-to-end decision API exists. |
| **Compaction** | `session_before_compact`, `session.compacting`, and `session_compact` are typed lifecycle events. `ctx.compact(...)` exists in extension/command contexts. | **Extension-context API**, not slash-only; interactive OMP may also provide slash UX. | **Observed indirectly, not controlled:** bridge subscribes to `session_compact` and re-emits newly persisted semantic entries, but sends no distinct compaction lifecycle frame and exposes no compact command. | Do not add remote compact control. Preserve native TUI handling in the same process. |
| **Metadata** | Model, thinking, context usage, session identity, and command metadata are available across tagged extension contexts; exact availability varies by context. | Read access is **extension API**; model/thinking setters are separate APIs. | **Supported partially:** hello/metadata frames contain session ID/file, model, thinking, available models, and bridge-defined available thinking levels. | Small read-only session metadata panel sourced only from frames; label unavailable fields rather than synthesizing them. |
| **Slash commands** | Extensions can `registerCommand(...)`; `pi.getCommands()` returns `SlashCommandInfo[]`. Registered command handlers receive an extended command context. | Both: extension API can register/list commands; command invocation is native slash-command UX. No claim is made that every built-in slash command has an extension equivalent. | **No typed remote slash API:** generic bridge commands are rejected. A user may type slash text through the ordinary `prompt` path, but Agent Remote cannot list, validate, invoke, or present a command result as a command protocol. | Keep slash commands in Raw Terminal. A future remote menu must first bridge an allowlisted command catalog and invocation/result semantics. |

### Integration boundary

Agent Chat is a semantic projection, **not a second OMP agent or an alternate process**. Its direct controls must stay limited to the same `AgentSession`/`TerminalRuntime` and OMP TUI process used by Raw Terminal. In particular, bridge session-switch and branch pre-events are cancelled; a future capability surface must not create a second session to emulate Plan, approvals, compaction, or slash commands.

### Consequence for A04, A05, and A10

- **A04:** multi-turn chat may use the verified `prompt` path only; delivery-mode choices (`steer`, `followUp`, `aside`) are upstream extension semantics but are not Agent Remote controls today, so the mobile composer must not claim them.
- **A05:** show only events actually projected by the bridge (assistant/thinking/tool lifecycle plus terminal state); do not label a generic spinner as plan/goal/todo/approval progress.
- **A10:** unknown or internal bridge records must remain non-user-facing. Absence of a capability in this table is not license to serialize native hook/system content as chat text.

---

## Root-Cause Tranche: A01, A04, A05, A10 (2026-10-01)

**Method.** This is source-trace analysis against the manual defect definitions, not an Android golden-flow result. The existing rootful-capacity block means the Android golden flow was deliberately not run. The manual report remains the defect evidence; the runtime evidence below is only what is needed to prove or disprove a particular causal path. Agent Chat and Raw Terminal remain two projections of the **same** normal OMP process: an `AgentWorkspaceTab` stores both `agentSessionId` and the shared `terminalSessionId`.

### A01 — exited/expired session remains active

- **Reproduction route:** create one OMP Agent; allow its terminal/OMP process to exit or force the daemon's terminal-expiry path; return to the dashboard and reopen/reconnect the app. Record whether the row is present, its displayed status, and whether its chat/terminal inputs remain enabled.
- **Source-flow facts:** terminal read failure calls `session.Manager.markExited`, emits `session.state: exited`, and records `terminal.exited` (`backend/internal/session/manager.go`). `agent.Service.watchTerminal` observes that state and calls `terminateAgentRuntime`; that operation terminates the shared terminal, marks the agent `exited`, disables prompt/abort/model/thinking, records `agent.updated`, and emits an agent state event (`backend/internal/agent/adapter.go`). Raw Terminal treats `session.state: exited`/`session_not_found` as terminal and closes its tab; AgentScreen updates its local Agent tab state but has no corresponding finish/close path. Separately, dashboard reconciliation consumes runtime snapshots/events, while `buildSessionSurfaces` deliberately retains every agent row and every local Agent tab, including `exited`; it merely ranks `exited` last (`client/app/terminal/[id].tsx`, `client/app/agent/[id].tsx`, `client/src/lib/runtime-reconcile.ts`, `client/src/lib/session-surface.ts`, `client/app/index.tsx`).
- **Root-cause proof:** the active-list ghost is proven at two presentation-retention boundaries: exited agents are neither removed/closed by AgentScreen as Raw Terminal is, nor filtered from dashboard surfaces. This proves stale tab/row persistence, not that every terminal exit is incorrectly labelled active. The server/client status update path exists and is covered by bridge lifecycle tests.
- **Remaining hypothesis:** if the recording showed a row labelled `working`/`idle` after exit rather than an `exited` row, capture the terminal `session.state`, corresponding `agent.updated`/agent state cursor, runtime WebSocket replay/resync, and the tab-store update. The likely fault would then be a lost lifecycle event/recovery path, not the proven retention behavior.
- **Narrow regression-test candidates:** (1) service test: terminal `exited` state produces exactly one agent `exited` state with interactive capabilities disabled; (2) focused AgentScreen/tab-store test: an exited agent follows the agreed close-or-inactive policy symmetrically with Raw Terminal; (3) `session-surface` test: an exited remote/local agent is not placed in an active surface set (or is explicitly presented inactive, once product retention policy is chosen); (4) runtime-channel cursor-expiry test: snapshot recovery cannot restore a pre-exit state.
- **Required runtime evidence:** one agent/terminal ID pair; terminal-state and agent-state frames with cursors; `/v1/runtime/snapshot` before/after expiry; dashboard screen recording/state dump; process/bridge disconnect timestamps.

### A04 — five-turn same-process OMP chat

- **Reproduction route:** create one agent, wait for bridge hello, then send five distinct sentinel prompts **sequentially after the prior turn is idle**. For every turn capture REST request/result, bridge `command: prompt` request ID/result, semantic user/assistant IDs, lifecycle states, OMP session ID/file, shared terminal ID, and the OMP PID/TTY. Reject the run if any identity changes.
- **Source-flow facts:** creation starts exactly one `omp --no-extensions -e <bridge>` terminal runtime and stores its terminal ID in the AgentSession (`backend/internal/agent/adapter.go`). The bridge calls `pi.sendUserMessage`; the HTTP client calls `/v1/agents/:id/prompt`; `SubmitPrompt` waits while state is `working`, atomically claims `working`, then sends one bridge command. This is intentionally meant to prevent an in-flight prompt becoming OMP steering rather than a new turn. The bridge cancels session-switch and branch pre-events, and the service terminates the runtime if a bridge-reported OMP session identity changes (`backend/internal/agent/bridge.ts`, `backend/internal/agent/adapter.go`). Client history bootstraps then subscribes from its cursor, deduplicating by semantic event ID (`client/app/agent/[id].tsx`).
- **Root-cause proof:** no source proof yet explains a five-turn failure. The designed same-process identity invariant is explicit, and there are focused one-prompt durability/error tests plus hermetic multi-turn/tool coverage, but no narrow five-distinct-turn same-PID/same-OMP-session regression contract.
- **Hypotheses to discriminate:** (1) the 30-second `SubmitPrompt` wait can return `agent_busy` when an earlier turn never reaches an `agent_end`/idle lifecycle; (2) a bridge disconnect disables the prompt capability and returns `needs_terminal`; (3) history/live replay can resync or overflow while a mobile screen is backgrounded, causing a client-visible missing/duplicated turn despite one surviving OMP process. These are hypotheses, not a finding that any process is recreated.
- **Narrow regression-test candidate:** a bridge-server integration test that authenticates one bridge, drives five `prompt` command/result and idle lifecycle cycles, and asserts: one `agentSessionId`, one `terminalSessionId`, one OMP session ID/file, five ordered durable user/assistant turn pairs, and no `needs_terminal`/`agent_busy`. Add a client cursor-recovery case only if the reproduction identifies replay as the failing boundary.
- **Required runtime evidence:** the five-turn trace described above, plus runtime-channel close/resync reasons and transcript cursor/history after each turn. This is sufficient to localize client replay versus bridge lifecycle versus OMP process failure without starting a second OMP process.

### A05 — useful OMP processing/activity visibility

- **Reproduction route:** submit a prompt that emits thinking, at least one tool call/result, and a visible approval pause if available. Compare the Raw Terminal output with Agent Chat during and after the turn; capture semantic/lifecycle frames and the rendered chat list.
- **Source-flow facts:** the bridge emits lifecycle `agent_start`, `turn_start`, `tool_start`, `tool_end`, approval, and agent-end frames; it emits semantic assistant, thinking, tool-call, and tool-result records (`backend/internal/agent/bridge.ts`). `handleBridgeLifecycle` reduces those lifecycle frames to agent state (`working`, `needsYou`, `idle`) and emits a generic `state` event; it does not preserve a structured lifecycle activity record for Agent Chat (`backend/internal/agent/adapter.go`). The client renders tool call/result cards, but only renders `state.change` specially; a generic `state` event has no text and renders nothing. `message.thinking` also has no dedicated branch and falls through to a generic system bubble. The composer has only its own send spinner (`client/app/agent/[id].tsx`).
- **Root-cause proof:** the structured activity gap is proven: rich bridge lifecycle data is collapsed to state before the Agent Chat protocol/rendering boundary, and the remaining state/thinking event types lack dedicated mobile representations. This is distinct from an absent OMP activity source.
- **Remaining hypothesis:** whether the manual recording's perceived inactivity was caused primarily by this collapse, delayed WebSocket delivery, or tool output clipping requires a correlated frame/UI trace.
- **Narrow regression-test candidates:** (1) adapter/bridge test asserting each lifecycle event produces a durable typed activity event rather than only a state change, once the protocol contract is chosen; (2) focused AgentScreen renderer test asserting thinking, turn/tool start/end, and approval records have labelled, non-user/system rendering; (3) preserve the existing tool-card truncation contract separately so it cannot substitute for activity status.
- **Required runtime evidence:** timestamped bridge frames, backend stored events/cursors, runtime WebSocket frames, and screen capture for one thinking/tool/approval turn; correlate these with Raw Terminal timestamps.

### A10 — internal system/hook content leak

- **Reproduction route:** run a controlled OMP extension/hook that appends both undisplayed and displayed `custom_message`, `custom`, or `hookMessage` records containing unique harmless sentinels. Inspect the OMP terminal, bridge frames, `/history`, and Agent Chat. Do not use real system prompts, secrets, or production hook payloads.
- **Source-flow facts:** the bridge and transcript fallback suppress undisplayed custom/hook records, but deliberately convert **displayed** `custom_message`, `custom`, `hookMessage`, and `fileMention` content into `message.system` (`backend/internal/agent/bridge.ts`, `backend/internal/agent/transcript.go`). The runtime WebSocket admits `message.system` to agent-channel replay. AgentScreen converts every agent event with an ID into a message item and renders any unknown text-bearing type as a system bubble; `message.system` therefore reaches the user without an allowlist or provenance check (`backend/internal/server/server.go`, `client/app/agent/[id].tsx`).
- **Root-cause proof:** the leakage mechanism is proven: a displayed internal/hook record can cross both live-bridge and transcript-fallback paths as `message.system`, then is rendered by the client fallback. The manual report is needed to identify which particular displayed record leaked; source alone cannot classify every OMP `display: true` payload as unsafe.
- **Narrow regression-test candidates:** table-driven bridge and transcript tests with undisplayed and displayed custom/hook fixtures; assert no user-visible Agent Chat event for prohibited internal/hook provenance. A focused AgentScreen test should render only an explicit semantic allowlist and reject an injected `message.system` sentinel. The allowed user-facing custom-message policy must be decided before changing behavior.
- **Required runtime evidence:** sanitized raw session entries (type, role, `display`, custom type/provenance, no sensitive text), bridge semantic frame, persisted agent-history entry/cursor, and screenshot of the matching chat bubble. This establishes whether the leak starts in OMP record marking, bridge projection, fallback tailing, or client rendering.

---

## Root-Cause Tranche: A02 — Real Android Terminal Transport (2026-10-01)

**Scope.** This traces Raw Terminal only, so a semantic Agent Chat failure cannot be misdiagnosed as a PTY transport failure. No Android golden flow, implementation, or mock was run.

### Deterministic marker reproduction

1. Open a newly created **Raw Terminal** direct-PTY session; record the daemon endpoint and terminal session ID. Wait until the initial `pty.baseline` and shell prompt render.
2. Choose a unique ASCII nonce, for example `A02_20261001_001`. Focus the xterm WebView using the Android software keyboard and enter `printf '__AR_A02_A02_20261001_001__\n'`, then press the IME Enter key.
3. Acceptance at the surface is two ordered occurrences: the terminal's echo of the typed command, followed by the shell's standalone `__AR_A02_A02_20261001_001__` output line. Capture the screen with the IME visible and again after it is hidden.
4. Repeat exactly once through the app’s paste/shortcut path, then rotate or otherwise resize once and send a second, different nonce. These isolate IME focus/input, Clipboard/WebView messaging, resize, and return-output without using shell mutation or external network access.

### End-to-end facts

```text
Android IME / WebView xterm input
  -> ReactNativeWebView.postMessage({ type: "input", data })
  -> Terminal.onMessage -> TerminalScreen -> ShortcutKeyboard.input
  -> DaemonChannel.send({ type: "pty.input", base64(UTF-8 bytes) })
  -> wss /v1/ws/sessions/:terminalSessionId (auth.token first)
  -> server.handlePTYWS -> session.Manager.Input -> PTY/tmux backend.Write
  -> backend.readOutput -> pty.output (base64, monotonic seq)
  -> DaemonChannel decode/dedupe -> TerminalScreen TextDecoder/output state
  -> Terminal injectJavaScript MessageEvent({ type: "output", data }) -> xterm DOM
```

- `Terminal` is a native `react-native-webview` on Android. Its `onMessage` forwards WebView `input` and `resize`, handles clipboard copy/paste, and injects output into generated xterm HTML. On load it reinjects accumulated output (`client/src/components/Terminal.tsx`).
- Raw Terminal wires that component’s input through the `ShortcutKeyboard` imperative input method; its supplied `onInput` base64-encodes UTF-8 and sends `pty.input` on the daemon-scoped channel. Resize follows the same channel as `pty.resize` (`client/app/terminal/[id].tsx`, `client/src/lib/bytes.ts`).
- `WebSocketDaemonChannel` opens one authenticated socket per terminal session. It treats `pty.baseline` as viewport replacement, drops duplicate/out-of-order `pty.output` by sequence, and reconnects active subscriptions (`client/src/lib/daemon-channel.ts`).
- The server requires the auth token, subscribes before accepting `pty.input`, decodes base64, forwards bytes to `session.Manager.Input`, and writes PTY output/state back over the same socket (`backend/internal/server/server.go`). `session.Manager.readOutput` records output, publishes state, and marks an ended backend exited (`backend/internal/session/manager.go`).

### Proven boundaries and hypotheses

- **Proven behavior:** while a socket is unavailable, `WebSocketDaemonChannel.send` deliberately drops `pty.input`; only the newest pending resize is queued for reconnect. A marker typed during reconnect therefore has no delivery guarantee. This is a concrete transport-loss boundary, but source review alone does not prove it caused the manual A02 report.
- **Proven observability gap:** server `handlePTYWS` ignores the error returned by `sessions.Input` and `sessions.Resize`; a valid frame sent to a dead/non-running backend can have no explicit client error. `Terminal.onMessage` also parses WebView JSON without a local malformed-message/error report. Neither fact proves the keyboard/WebView is the failing boundary.
- **Hypotheses to discriminate:** (1) Android IME cannot focus or deliver to xterm/WebView; (2) WebView-to-native input arrives but the shortcut forwarding path loses it; (3) the socket is reconnecting and drops the marker; (4) PTY write succeeds but output is lost by state/sequence/reinjection; (5) terminal is visually unusable despite transport success (keyboard/viewport/selection). The marker trace resolves these without conflating them.

### Boundary instrumentation plan (not implemented)

Use a development-only, opt-in `terminal.trace` correlation ID based on the marker nonce. At each boundary record timestamp, session ID, direction, byte length, and a digest—not raw terminal content: (a) Android IME/WebView postMessage received; (b) `Terminal` callback/ShortcutKeyboard forwarding; (c) daemon socket open/close, send/drop/reconnect, and output sequence; (d) server decoded input and `Manager.Input` result; (e) PTY output sequence; (f) native decode and WebView output injection. Pair that trace with Android logcat/WebView console and the two screenshots above. This is instrumentation design only; no new telemetry is authorized in this tranche.

### Narrow regression-test candidates

1. Extend `client/src/lib/daemon-channel.test.ts`: a `pty.input` marker during an intentional reconnect is either queued and delivered under an explicitly chosen contract or surfaced as a deterministic input-unavailable error—never silently ambiguous.
2. Add a focused `Terminal` bridge test with a WebView message fixture for input, resize, paste, malformed input, and output reinjection; no Android emulator is required.
3. Extend the server PTY WebSocket tests around `TestPTYExecutesRealCommandAndSeedsNewSubscriber` to assert marker input reaches a real PTY and its output returns after auth, plus an error-contract test for `Manager.Input` failure.
4. Keep an Android device smoke route, not a golden flow: execute the deterministic marker through IME and paste after the above boundaries are observable.

### Required runtime evidence

For each marker attempt retain the nonce, terminal session ID, socket open/close/reconnect timeline, outbound input decision (sent/dropped), server input result, PTY output sequence and bytes digest, client sequence/decode decision, WebView injection result, and device screenshot/logcat. Missing evidence at any boundary means classify A02 only as an unresolved transport hypothesis, not a terminal implementation conclusion.
