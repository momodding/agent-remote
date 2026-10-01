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
