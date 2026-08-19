# Native terminal migration
<!-- source-branch: main -->
<!-- work-branch: omp/native-terminal-migration -->

## Goal

Replace mobile `react-native-webview` + embedded xterm with a native React Native terminal only after a device spike proves `@next_term/native` usable. Keep web on current `xterm` implementation. Reuse daemon-owned persistent scrollback and `SessionSummary.preview`; add no second snapshot store.

## Facts driving plan

- Mobile terminal lives in `/home/momodding/Documents/agentic-remote/client/src/components/Terminal.tsx`; web resolves `/home/momodding/Documents/agentic-remote/client/src/components/Terminal.web.tsx` and must remain unchanged.
- Both single and multi-session screens consume one `Terminal` contract: `output`, `onInput`, `onResize`, plus imperative `copy`, `paste`, `selectAll`, `focus`, `blur`.
- `/home/momodding/Documents/agentic-remote/client/src/lib/session-socket.ts` already owns authenticated WSS framing, reconnect, PTY input, output, state, error, and resize. Renderer migration must not change wire protocol.
- `/home/momodding/Documents/agentic-remote/client/src/components/ShortcutKeyboard.tsx` already owns shortcut escape sequences and `modifiedTerminalInput`; native keyboard bytes must continue through this function before `SessionSocket.input`.
- Daemon already appends capped `{stateDir}/sessions/{id}.scrollback`, rebuilds preview after restart, strips ANSI, retains 8192 plain-text characters, and returns last six non-empty lines in `SessionSummary.preview`. Dashboard already renders up to five lines. New client persistence would duplicate authoritative state.
- Client uses Expo SDK 57, React Native 0.86, New Architecture, and Android keyboard resize. Native dependency requires a development/production build; Expo Go cannot host arbitrary native code.
- Current published `@next_term/native` is prerelease (`next` tag `0.1.0-next.22`). Inspected source is not production-ready: `NativeTerminal` returns an empty `RCTView`; `TerminalSurface` calls itself a placeholder; gesture callbacks leave scrolling/selection unimplemented; `resize()` replaces buffer and loses content; imperative handle lacks selection/copy/paste; renderer output needs a consumer. Therefore direct migration is blocked unless exact pinned package passes spike gates below.

## Architecture boundary

Keep existing boring separation; add no framework:

1. **Transport/session controller:** `/home/momodding/Documents/agentic-remote/client/app/terminal/[id].tsx` and `SessionSocket` retain socket lifecycle, replay accumulation, close/detach behavior, multi-session routing, and PTY resize messages.
2. **Terminal view adapter:** platform files named `Terminal.tsx` and `Terminal.web.tsx` retain current props/handle. Native adapter translates renderer bytes and layout to existing string callbacks. Web remains xterm.
3. **Input controller:** native key/text events call `Terminal.onInput`; route and multi-terminal continue forwarding them through `ShortcutKeyboard.input`, preserving Ctrl/Alt translation and broadcast behavior. Shortcut toolbar remains reusable and independent of renderer.
4. **Snapshot/preview:** backend `Manager` remains sole persistence owner. Dashboard renders `SessionSummary.preview`; no AsyncStorage, image capture, client ANSI parser, timer, or new endpoint.

## Execution plan

### Phase 1 — Compatibility spike; no product cutover

1. In `/home/momodding/Documents/agentic-remote/client/package.json` and `/home/momodding/Documents/agentic-remote/client/bun.lock`, pin one exact `@next_term/native` prerelease version, never a tag/range. Install only its required peers. Do not remove WebView/xterm yet.
2. Add required Expo config plugin/native peer setup only if exact package metadata requires it. Preserve `/home/momodding/Documents/agentic-remote/client/app.json` values including `newArchEnabled: true`, `softwareKeyboardLayoutMode: "resize"`, package ID, permissions, and existing plugins. Produce a development build; do not claim Expo Go support.
3. Create smallest throwaway native-only spike surface in existing `/home/momodding/Documents/agentic-remote/client/src/components/Terminal.tsx`: mount component, feed ANSI text, capture typed text/key bytes, resize from measured bounds, and render visible cells. No transport or dashboard changes.
4. Verify on physical Android development build, then iOS development build if iOS remains a supported migration target. Required observable gates:
   - visible ASCII and ANSI color/style output;
   - cursor movement, clear-screen, carriage return, line wrapping, UTF-8, and 1000+ streamed chunks without blank surface/crash;
   - software keyboard input and hardware Enter, Backspace, Tab, arrows, Ctrl+C, Alt+key deliver expected PTY bytes once;
   - focus/blur opens and closes keyboard;
   - rotation and keyboard resize produce positive integer columns/rows and retain displayed content;
   - scrollback, selection, copy, paste, and select-all work through real package APIs;
   - two simultaneous terminal instances render and accept input independently.
5. Stop/go gate: proceed only if all gates pass without patching `node_modules`, maintaining a fork, writing a renderer, or replacing package internals. Otherwise remove spike dependency/config and keep current WebView. Record failed gates and defer migration until upstream supplies production surface, resize preservation, selection/clipboard, and Expo/RN 0.86 support. This is expected outcome for inspected source.

### Phase 2 — Native adapter cutover, conditional on spike success

6. Replace spike with production `/home/momodding/Documents/agentic-remote/client/src/components/Terminal.tsx`, preserving exported `TerminalHandle` and props exactly so `/home/momodding/Documents/agentic-remote/client/app/terminal/[id].tsx` and `/home/momodding/Documents/agentic-remote/client/src/components/MultiTerminal.tsx` need no renderer-specific branches.
7. Terminal engine: hold one native terminal ref per mounted pane. Stream only suffix when `output` extends prior output; reset and replay full `output` when socket reconnect clears/replaces it. Flush package writes in order; use a single queued `setImmediate` macrotask only if device spike proves synchronous burst writes block frames. Do not keep a second terminal buffer in React state.
8. View/layout: measure container with `onLayout`; derive `cols = max(2, floor(width / cellWidth))` and `rows = max(1, floor(height / cellHeight))` from package-reported metrics. Resize engine first, then call `onResize` only when integer dimensions change. Never hard-code screen dimensions. Preserve dark theme/current font size and accessibility label.
9. Input: decode package `Uint8Array` via one module-level `TextDecoder` and call existing `onInput` once. Keep `/home/momodding/Documents/agentic-remote/client/src/components/ShortcutKeyboard.tsx` as sole Ctrl/Alt adapter; do not modify or bypass `modifiedTerminalInput`. Keep multi-session broadcast in route unchanged.
10. Clipboard/selection: implement existing imperative methods using package-supported selection APIs plus `expo-clipboard`. `paste()` reads clipboard and sends text through existing `onInput` path; `copy()` writes selected text; `selectAll()` selects terminal buffer; `focus()`/`blur()` delegate to native handle. Do not emulate missing selection in app code; a missing API fails Phase 1.
11. Keep `/home/momodding/Documents/agentic-remote/client/src/components/Terminal.web.tsx`, `xterm`, and `xterm-addon-fit` unchanged. After mobile verification, remove `/home/momodding/Documents/agentic-remote/client/src/components/terminal_html.ts` and `react-native-webview` only if no references remain. Do not remove web xterm dependencies.
12. Run focused client tests after each adapter behavior: append versus replay, ordered byte decoding, resize deduplication/clamping, imperative clipboard calls, and cleanup with pending flush. Mock package boundary, not parser internals.
13. Device smoke single-session: start real daemon/session, observe replayed scrollback, run interactive shell command, resize/rotate, background/foreground reconnect, detach/reopen, copy/paste/select-all, shortcut Ctrl/Alt/arrows, then natural exit and manual close. Confirm no duplicated output/input and inherited daemon environment remains intact; do not alter backend process environment or replace it with a TERM-only map.
14. Device smoke multi-session: open two panes, type into focused pane, broadcast once to both, drag/split panes, resize, switch focus, use shortcuts/clipboard against focused terminal, close one, background/restore. Confirm refs and buffers stay isolated.

### Phase 3 — Persistent preview, using existing backend contract

15. Do not add storage. Keep `/home/momodding/Documents/agentic-remote/backend/internal/session/manager.go` scrollback append, cap, ANSI stripping, preview restoration, and metadata persistence unchanged unless a failing focused test exposes a defect.
16. Add backend contract coverage in `/home/momodding/Documents/agentic-remote/backend/internal/session/manager_test.go` only where absent: output containing ANSI/blank lines yields at most six latest non-empty plain lines; a new manager over same state directory reconstructs same preview from capped `.scrollback`. Exercise real manager output and polling pattern already used by tests.
17. Extract `SessionCard` from `/home/momodding/Documents/agentic-remote/client/app/index.tsx` only if required for a focused render test; otherwise keep it inline. Continue `session.preview.join('\n') || 'No output yet'`, cap presentation with existing `numberOfLines={5}`, and expose plain text to accessibility. No polling beyond existing session-list refresh/AppState behavior.
18. Add one dashboard behavior test proving preview lines from API render and `No output yet` remains fallback. Do not use snapshots.
19. Restart daemon against same temporary state directory in backend test and confirm preview persists. Run client dashboard test and manually verify session card after app background/foreground refresh.

### Phase 4 — Final verification and cleanup

20. Run `/home/momodding/Documents/agentic-remote/client` focused Jest tests, then `make client-test`.
21. Run `make backend-test` if Phase 3 added/changed backend tests or code.
22. Run `make lint` for Go vet and TypeScript checks.
23. Run `make client-build-web` to prove platform resolution still bundles xterm web implementation and no native package leaks into web bundle.
24. Build/install Android development or release artifact and repeat single/multi terminal smoke on physical device. Build/test iOS too before declaring iOS migrated; otherwise scope release note to Android and leave iOS on old adapter via platform file.
25. Remove only proven-dead mobile bridge code/dependency and spike-only config. Search all imports before deletion. Keep web xterm and backend persistence.
26. Update existing user/developer docs and changelog only where they already describe Expo Go, mobile terminal runtime, build prerequisites, or previews: native mobile terminal requires dev/production build; web still uses xterm; daemon owns persistent scrollback/preview. No new architecture document.

## Acceptance criteria

- Android native terminal renders real PTY output and supports interactive input, resize, scrollback, focus, selection, copy/paste/select-all, reconnect replay, shortcuts, and two isolated panes without WebView.
- Web terminal behavior/build remains xterm-based.
- SessionSocket protocol, auth, replay, close/detach, and broadcast semantics remain unchanged.
- Native events pass through existing `modifiedTerminalInput`; no double modifier translation.
- No process launch changes; inherited environment stays preserved.
- Dashboard preview survives daemon restart because existing `.scrollback` + metadata path is verified, not duplicated client-side.
- No AsyncStorage snapshot cache, screenshot files, extra REST/WSS messages, timers, parser fork, custom renderer, or patched dependency.
- If exact `@next_term/native` cannot pass Phase 1, completed deliverable is evidence-backed no-go plus reverted spike—not fragile production cutover.
