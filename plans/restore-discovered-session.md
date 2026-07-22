# Restore discovered web sessions
<!-- source-branch: main -->
<!-- work-branch: omp/restore-discovered-session -->

## Problem
A session listed from a previously saved daemon connection can be opened in the Expo web client, but `client/src/components/Terminal.tsx` returns an empty `View` for `Platform.OS === 'web'`. The terminal route still creates `SessionSocket`, so there is no rejected-session or WebSocket error, but there is no xterm instance to render output, accept keyboard input, or report dimensions. The affected session is live in the same daemon process; `backend/internal/session.Manager` already retains and reuses that session's PTY. This is not daemon-state restoration work.

The native HTML bundle is not the missing bridge: the generated tail of `client/src/components/terminal_html.ts` creates `Terminal`, loads `FitAddon`, opens `#terminal`, forwards `onData` and resize through `ReactNativeWebView.postMessage`, and consumes output/clear messages. The defect is the explicit web placeholder. A secondary transport bug is also observable: `client/src/lib/session-socket.ts:50-52` silently drops input and resize while the WebSocket is connecting, including xterm's initial resize and any immediate keystrokes.

## Scope
Touch only:
- `client/src/components/Terminal.tsx`
- a small web-only terminal component beside it (prefer `client/src/components/Terminal.web.tsx` if Metro platform resolution allows the native file to stay unchanged; otherwise keep the web branch in `Terminal.tsx`)
- `client/src/lib/session-socket.ts`
- `client/app/terminal/[id].tsx`
- focused client tests for the changed contracts

Do not change backend session restore/lifecycle code, protocol wire types, or `terminal_html.ts`. Do not touch unrelated dirty Flutter/Expo/config work.

## Implementation

### 1. Render the installed xterm implementation on web
Replace the web placeholder in `client/src/components/Terminal.tsx` with a browser renderer using the already installed `xterm` and `xterm-addon-fit` packages.

Required behavior:
- Own a container `div` through a React ref; instantiate one `Terminal` and one `FitAddon` after mount, using the same options/theme as `terminal_html.ts`.
- Load the addon, open the container, subscribe to `terminal.onData(onInput)`, call `fit.fit()`, and report `onResize(terminal.cols, terminal.rows)` after the first fit.
- Use `ResizeObserver` to repeat fit + resize reporting when the container changes size. This is the browser-native equivalent of the generated HTML bridge; do not add a dependency.
- Reuse the existing output-delta contract: write only the appended suffix when `output` extends the previous value; clear and rewrite when output is reset or replaced. This preserves the route's accumulated scrollback model and avoids duplicate writes.
- Dispose the input subscription, observer, and terminal on unmount.
- Preserve the native `react-native-webview` implementation and generated `terminal_html.ts` unchanged.
- Make the container fill the existing terminal area and retain the dark background. Import xterm CSS in the web implementation so glyph/layout measurements work in the Expo web export.

### 2. Preserve frames emitted before the socket opens
Update `client/src/lib/session-socket.ts` so input/resize produced during connection setup is delivered instead of silently discarded.

Required behavior:
- Keep one FIFO array for pending `pty.input` frames and one latest pending `pty.resize` frame. Input is loss-sensitive; resize is state, so only the newest dimensions matter.
- `send()` sends immediately only when the current socket is `WebSocket.OPEN`; otherwise enqueue input or replace the pending resize.
- In `onopen`, send `auth.token` first, then flush the pending resize and ordered input through that same socket. The backend's authenticated handler consumes the auth frame synchronously before subsequent frames, so no new `auth.ok` protocol is needed.
- Guard callbacks against stale sockets after reconnect (`if (this.socket !== socket) return`) so an old socket cannot flush, emit errors/output/state, or clear current state.
- `connect()`/`close()` must clear pending frames so data queued for one connection is never replayed into a later reconnect. Since `connect()` calls `close()`, establish the new queues after closing.
- Keep the existing public API and wire frame shapes.

### 3. Expose close management from the open terminal
In `client/app/terminal/[id].tsx`:
- Construct `AgenticRemoteAPI` from the loaded connection and add a `Close` header action alongside `Clear`.
- Confirm with `Alert.alert` using destructive/cancel buttons. On confirmation, call the existing `closeSession(id)` endpoint, close the local `SessionSocket`, then `router.back()` so the session returns to the dashboard rather than leaving a live orphan.
- Surface API failure through the existing alert style and remain on the terminal screen.
- Keep dashboard card management unchanged.

## Regression checks

### Automated
1. Extend `client/src/lib/session-socket.test.ts` with a controllable mocked `WebSocket` and prove:
   - input and multiple resizes issued before `onopen` produce no early sends;
   - `onopen` sends `auth.token` first, the latest resize once, then every queued input in original order;
   - later input sends immediately;
   - close/reconnect does not replay stale queued frames or accept callbacks from the old socket.
2. Add a focused terminal component test (Jest Expo + existing `react-test-renderer`; no new test package) for the web implementation with mocked `xterm`, `FitAddon`, and `ResizeObserver`. Prove initial output is written once, appended output writes only the suffix, input reaches `onInput`, fitting reports dimensions, and cleanup disposes resources.
3. Add a focused terminal-route test only for the new management contract: confirmation invokes `AgenticRemoteAPI.closeSession(id)` and navigates back on success; cancellation does not close; rejection displays the error and stays put. Mock connection/socket/API/router boundaries—do not introduce a full navigation harness.
4. Run `cd client && bun run test --runInBand` and `cd client && bun run typecheck`.
5. Run `cd client && bun run build:web` to prove Metro resolves the web component and xterm CSS in the actual export path.

### Browser smoke test
1. Start the daemon and Expo web client with the existing project commands.
2. Pair/save the daemon connection, create a shell session, return to the dashboard, then open that same running session from the existing-session card.
3. Verify historical/live output renders; click the xterm surface and type a command immediately after opening; confirm the command reaches the same PTY and output appears.
4. Resize the browser and verify the terminal refits without duplicated output.
5. Use the terminal header Close action, confirm it, verify navigation returns to the dashboard and refresh shows the session finished/removed according to the existing close/list behavior.
6. Reopen another running session to verify close did not damage the saved daemon connection.

## Non-goals
- Persisting a PTY across daemon process restart. True process continuity would require a durable PTY owner/broker and is unrelated to this same-process web rendering defect.
- Relaunching saved commands, history-only restoration, a second session-discovery protocol, or a new WebSocket auth acknowledgment.
- Rebuilding or hand-editing generated `terminal_html.ts`.
