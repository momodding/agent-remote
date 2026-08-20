<!-- omp-source-branch: main -->
<!-- omp-work-branch: omp/fix-migration-regressions -->

## Context

Fix four regressions introduced by the terminal/client migration without changing protocol shapes or adding dependencies: split-terminal panes currently tile by array order rather than their assigned slots and provide no minimize action; macOS/zsh PTY output can corrupt split UTF-8 sequences and modifier handling can double-process the triggering key; an absolute `workspaceRoot` is incorrectly prefixed with the config directory; and Desktop/noVNC uses an IIFE artifact in the Expo web bundle while the native raw-channel bridge can send before its injected receiver is ready and closes the VNC socket as a normal WebSocket cleanup.

Preserve live terminal components, PTYs, sockets, scrollback, snapshots, resize behavior, filesystem confinement, authenticated WSS, binary VNC frames, and both web/native desktop controls. No dependency upgrades, reconnect loop, arbitrary delay, daemon-install change, protocol migration, or unrelated redesign.

## Approach

Execute these issue groups in order. Every code edit is a targeted **SWAP**: replace only the named complete function/component/method body or declaration body, preserving all unrelated statements in that body.

### Issue 1 — multi-terminal panel layout and minimize behavior

**Confirmed root cause**

`client/src/components/MultiTerminal.tsx` computes a slot-bearing `SplitLayout`, then discards slot positions by filtering nulls into `visibleSessions` and rendering the compacted result with `flexWrap`. A session assigned to slot 4 therefore renders in the first available visual cell. Tabs expose only close; selecting an inactive tab resets the layout through `reconcileSplit([sessionId], ...)`, evicting every visible pane. There is no non-destructive minimize transition.

**Files changed**

- `/home/momodding/Documents/agentic-remote/client/src/components/MultiTerminal.tsx`
- `/home/momodding/Documents/agentic-remote/client/src/components/MultiTerminal.test.tsx`
- `/home/momodding/Documents/agentic-remote/client/src/lib/multi-session.test.ts` only if no existing test already pins the chosen empty-slot behavior

**Fix**

1. SWAP the complete `DraggableTab` component body/signature. Keep drag, select, and close behavior. Add an `onMinimize` callback and a separate accessible minimize button (minus icon) next to close. Active tabs expose minimize; inactive tabs expose restore/select. Do not call `onClose` from minimize.
2. SWAP the complete `MultiTerminal` component body. Keep all existing refs, effects, drag/drop, keyboard, and Terminal props. Add:
   - `minimizeTab(sessionId)`: replace that session’s occupied slot with `null`, retain all other slot indices, and move focus to the first remaining visible session.
   - `restoreTab(sessionId)`: call existing `placeInSplit` for the first empty auxiliary slot in ascending order; if all auxiliary slots are occupied, deterministically replace the focused auxiliary slot, otherwise the first auxiliary slot. Focus the restored session.
   - `selectTab(sessionId)`: focus an already-visible session without altering layout; restore an inactive session through `restoreTab` instead of rebuilding the whole layout.
   - slot-preserving rendering: map every auxiliary slot index and render either its assigned `Terminal` or an empty cell. Use fixed row/column wrappers rather than compacting `layout`; web is 2×2, native portrait is 1×2, native landscape is 2×1. Preserve stable `sessionId` keys so minimizing only removes that pane and never closes its backend session.
   - existing `ShortcutKeyboard` routing unchanged: one focused terminal receives each input frame; do not add broadcast logic.
3. SWAP the complete `StyleSheet.create` declaration body only as needed for explicit grid rows/cells and the minimize button. Reuse existing colors, dimensions, drop-zone styles, and spacing.

**Tests**

- Extend `/home/momodding/Documents/agentic-remote/client/src/components/MultiTerminal.test.tsx` with observable tests that assign sessions to non-leading slots and assert the corresponding slot test IDs, proving null slots are not compacted.
- Press minimize and assert the pane disappears while `onClose` is not called and the tab remains. Press/select the inactive tab and assert restoration to the first available slot.
- Assert minimizing the focused pane routes subsequent shortcut input to the deterministic remaining focus; keep the existing one-input/one-session assertion.
- Assert web exposes four fixed slots and native portrait/landscape expose two fixed slots using the existing mocked dimensions/platform seams.

### Issue 2 — malformed macOS/zsh rendering and modifier input

**Confirmed root cause**

`backend/internal/session/manager.go` emits each PTY `Read` as an independently encoded frame. `client/src/lib/session-socket.ts` calls the shared stateless `text()` decoder for each frame. `client/src/lib/bytes.ts` owns one `TextDecoder` but invokes it without streaming, so a multi-byte UTF-8 sequence split across PTY reads becomes replacement characters. This is independent of zsh startup; the manager already launches `$SHELL` and preserves `os.Environ()` plus `TERM=xterm-256color`.

`client/src/components/ShortcutKeyboard.tsx`’s `modifiedTerminalInput` emits the control/alt transformation and returns `false`, allowing the same physical key to continue through xterm’s normal input path. Modifier shortcuts can therefore send both transformed and literal input. `MultiTerminal.tsx` already gates the shared keyboard by `focusedSessionId`; there is no N² fan-out to replace.

**Files changed**

- `/home/momodding/Documents/agentic-remote/client/src/lib/session-socket.ts`
- `/home/momodding/Documents/agentic-remote/client/src/lib/session-socket.test.ts`
- `/home/momodding/Documents/agentic-remote/client/src/components/ShortcutKeyboard.tsx`
- `/home/momodding/Documents/agentic-remote/client/src/ShortcutKeyboard.test.ts`

**Fix**

1. SWAP the complete `SessionSocket` class declaration body. Give each socket instance its own `TextDecoder`; reset it in `connect()` and `close()`. For `pty.output`, decode `decodeBase64(frame.data)` with `{ stream: true }` and call `onOutput` only for non-empty decoded text. Preserve auth ordering, pending input/resize semantics, stale-socket guards, errors, and all public method signatures.
2. SWAP the complete `modifiedTerminalInput` method body in `ShortcutKeyboard.tsx`. Preserve existing modifier mappings and state reset. Return `true` whenever this method emitted transformed control/alt data so xterm treats the event as handled; return the existing pass-through value only when no modifier transformation occurred. Do not add timeouts, debounce, key-name special cases, or a second input path.
3. Do not alter `backend/internal/session/manager.go`, shell selection, command/args protocol fields, or environment construction: existing code is correct for native macOS zsh execution, and the corruption boundary is client frame decoding.

**Tests**

- Add a `SessionSocket` test that delivers one Unicode scalar split across two valid `pty.output` frames and asserts exactly one intact character, with no replacement character and no early output for the incomplete prefix.
- Extend `ShortcutKeyboard.test.ts` to assert a modifier-transformed key is consumed and emits exactly one transformed payload; assert an unmodified key remains pass-through.
- Retain existing terminal-route and MultiTerminal tests proving ordinary xterm input still reaches only the focused session.
- Manual boundary: on macOS with zsh, run a command that prints repeated non-ASCII text plus ANSI color while resizing. Confirm intact glyphs, prompt redraw, backspace, arrows, Ctrl+C, Option/Alt input, and full-screen TUI redraw. Automation covers byte boundaries and duplicate routing; only a real PTY/device can validate IME/keyboard and terminal appearance.

### Issue 3 — absolute workspaceRoot outside config directory

**Confirmed root cause**

`backend/cmd/agenticRemote/main.go` unconditionally passes `filepath.Join(root, cfg.WorkspaceRoot)` to `fs.New`. Go’s `filepath.Join` does not preserve the later absolute operand as a replacement for the earlier root in this usage, so `/Users/name/work` becomes rooted beneath the daemon config directory and the file manager reads the wrong/empty tree. `fs.FS` already confines requested paths to whichever workspace root it receives, and `config.Validate` separately proves `uploadDir` stays inside `workspaceRoot`.

**Files changed**

- `/home/momodding/Documents/agentic-remote/backend/cmd/agenticRemote/main.go`
- `/home/momodding/Documents/agentic-remote/backend/cmd/agenticRemote/main_test.go`

**Fix**

1. SWAP the complete `workspaceRoot` helper/function body introduced beside `runServe` (or, if execution confirms no helper seam is needed, SWAP the complete smallest enclosing `runServe` setup body while preserving all other setup). Resolve the configured path with the standard library only:
   - if `filepath.IsAbs(cfg.WorkspaceRoot)`, `filepath.Clean` and use it directly;
   - otherwise join it to the existing config/state `root` and clean it.
2. Pass that resolved value to `fs.New`. Do not weaken `fs.resolve`, expose the config directory, change upload validation, or add a second filesystem root.

**Tests**

- Add table-driven tests in `main_test.go` for relative workspace roots, absolute Unix roots, and cleaned relative paths. The absolute result must equal the configured absolute path, not a descendant of config root.
- Add/extend the existing serve integration test with a temporary absolute workspace outside the temporary config/state directory; create a file there, authenticate through the existing helper, and assert `/v1/files` lists it.
- Keep existing `backend/internal/fs` traversal/symlink tests unchanged; they remain the confinement proof.

### Issue 4 — noVNC web build and mobile disconnects

**Confirmed root cause**

`client/app/desktop.tsx` imports `src/generated/novnc_script.ts` at module scope. That generated string is an IIFE intended for WebView HTML, so Expo web parses and ships the generated artifact even though web needs the package’s ESM `RFB` implementation. On native, `connectSocket` opens the React Native WebSocket only after WebView load, but inbound binary immediately calls injected `window.__agenticReceive(...)`; the receiver is created by noVNC’s raw-channel setup later, so early VNC bytes can be dropped. Cleanup closes the socket with the default close code, and the backend VNC proxy treats any client close as terminal rather than preserving the upstream half while flushing peer completion.

**Files changed**

- `/home/momodding/Documents/agentic-remote/client/app/desktop.tsx`
- `/home/momodding/Documents/agentic-remote/client/src/desktop-route.test.tsx`
- `/home/momodding/Documents/agentic-remote/backend/internal/server/server.go`
- `/home/momodding/Documents/agentic-remote/backend/internal/server/server_test.go`
- `/home/momodding/Documents/agentic-remote/client/scripts/build-novnc.ts` only if the platform-specific import split cannot prevent the generated module from entering the web graph; default is no script change

**Fix**

1. SWAP the complete noVNC HTML builder declarations in `desktop.tsx` so platform imports are isolated:
   - web uses a platform-specific ESM wrapper/module that imports `@novnc/novnc/lib/rfb` and instantiates `RFB` against the authenticated WSS URL directly;
   - native alone consumes the generated IIFE string inside WebView HTML. Avoid a new bundler plugin or dependency.
   If Expo Router cannot statically exclude a platform-specific sibling, use existing `.web.tsx`/`.native.tsx` module resolution with the smallest shared props contract; do not use runtime `require` in render.
2. SWAP the complete native bridged HTML builder body. Preserve noVNC’s required raw channel methods/properties from `websock.js`. Add one tiny inbound queue plus `setImmediate` flush helper: `window.__agenticReceive` enqueues decoded `ArrayBuffer`s; the macrotask drains only after raw-channel setup has installed its receive callback. This addresses receiver ordering without an arbitrary duration or reconnect loop. Outbound data remains base64 through `window.ReactNativeWebView.postMessage`.
3. SWAP the complete `connectSocket` callback body. Preserve bearer subprotocol/auth URL, `binaryType = 'arraybuffer'`, status updates, base64 conversion, stale-socket guards, and cleanup. Connect once per loaded WebView/connection. Use an explicit normal close code/reason on intentional unmount so backend can distinguish it from transport failure; do not reconnect automatically.
4. SWAP the complete VNC WebSocket proxy handler body in `backend/internal/server/server.go`. Keep authentication, connection limits, local `127.0.0.1:<vncPort>` dialing, binary-only enforcement, deadlines/limits, and error mapping. Run client→TCP and TCP→client pumps concurrently; on clean client close, half-close the TCP write side when supported and allow the TCP→client pump to flush before final teardown. On protocol/error close, cancel both directions immediately. Serialize WebSocket writes as the current handler requires.
5. Keep Desktop control actions (Ctrl+Alt+Del, Esc, Tab) and their shared styling unchanged. Do not upgrade `@novnc/novnc`.

**Tests**

- Update `desktop-route.test.tsx` to assert web does not create a React Native bridge WebSocket and uses the direct noVNC path; native still uses bridged HTML with no embedded WSS URL.
- Add fake-timer coverage that sends native inbound binary before `__agenticReceive`’s raw receiver is installed, installs it, advances one `setImmediate` macrotask, and asserts ordered, lossless delivery. Assert outbound binary still reaches the React Native socket and unmount sends the intentional close code/reason exactly once.
- In `backend/internal/server/server_test.go`, start a local `net.Listen("tcp", "127.0.0.1:0")` server in a goroutine, point the test server’s VNC port at it, and test the real bridge both ways with binary payloads. The goroutine must accept one connection, read the client payload, reply, then close; use channels/deadlines for deterministic completion and `t.Cleanup` for listener shutdown. Add a clean WebSocket-close case proving the TCP peer receives EOF and its final reply is flushed; retain binary-only and auth rejection coverage.
- Run an Expo web export with noVNC enabled to prove module resolution/build, then inspect/use the emitted Desktop route in a browser against a local authenticated daemon plus local VNC endpoint. Manual mobile validation on Android/iOS confirms connect, Ctrl+Alt+Del/Esc/Tab, background/foreground teardown, and no unexpected disconnect. Automation covers build graph and socket ordering; device lifecycle and visual framebuffer behavior remain manual.

## Critical files & anchors

- `/home/momodding/Documents/agentic-remote/client/src/components/MultiTerminal.tsx`: `DraggableTab`, `MultiTerminal`, `styles`; preserve fixed slot identity and focused-session keyboard routing.
- `/home/momodding/Documents/agentic-remote/client/src/lib/multi-session.ts`: reuse `reconcileSplit`, `placeInSplit`, and `auxSlotCount`; do not introduce a second layout model.
- `/home/momodding/Documents/agentic-remote/client/src/components/ShortcutKeyboard.tsx`: `modifiedTerminalInput`; consume only transformed modifier events.
- `/home/momodding/Documents/agentic-remote/client/src/lib/session-socket.ts`: `SessionSocket.connect`, `close`, and per-instance streaming decoder state.
- `/home/momodding/Documents/agentic-remote/backend/cmd/agenticRemote/main.go`: `runServe` filesystem setup near the current `fs.New(filepath.Join(root, cfg.WorkspaceRoot), ...)` call.
- `/home/momodding/Documents/agentic-remote/backend/internal/config/config.go`: retain `Validate` upload confinement semantics.
- `/home/momodding/Documents/agentic-remote/backend/internal/fs/fs.go`: retain workspace path/symlink confinement unchanged.
- `/home/momodding/Documents/agentic-remote/client/app/desktop.tsx`: noVNC HTML builders, native bridge, `connectSocket`, and platform render branch.
- `/home/momodding/Documents/agentic-remote/client/scripts/build-novnc.ts`: generated native IIFE boundary; change only if static platform resolution still includes it on web.
- `/home/momodding/Documents/agentic-remote/backend/internal/server/server.go`: authenticated VNC WebSocket handler and two-way TCP proxy lifecycle.
- `/home/momodding/Documents/agentic-remote/backend/internal/server/server_test.go`: existing VNC auth/binary tests plus the required local TCP goroutine integration.

## Verification

Planning is read-only; these commands are the exact baseline/final sequence for execution, not claims of current results.

1. Baseline, before edits, record focused failures and build behavior:
   - `cd /home/momodding/Documents/agentic-remote/backend && go test ./cmd/agenticRemote ./internal/server`
   - `cd /home/momodding/Documents/agentic-remote/client && bun run test -- MultiTerminal.test.tsx ShortcutKeyboard.test.ts session-socket.test.ts desktop-route.test.tsx`
   - `cd /home/momodding/Documents/agentic-remote/client && EXPO_PUBLIC_ENABLE_NOVNC=true bun run build:web`
2. After each issue’s SWAPs, run its focused tests from the commands above. A newly added regression test must fail against the baseline behavior and pass after its corresponding fix.
3. Final automated verification:
   - `cd /home/momodding/Documents/agentic-remote && make backend-test`
   - `cd /home/momodding/Documents/agentic-remote && make client-test`
   - `cd /home/momodding/Documents/agentic-remote && make client-build-web ENABLE_NOVNC=true`
   - `cd /home/momodding/Documents/agentic-remote && make lint`
4. Final runtime/manual verification:
   - Web: launch the daemon and Expo web client, open at least four terminal sessions, place each in every grid slot, minimize/restore without closing, type into each focus, and resize. Open Desktop against a local VNC server and confirm framebuffer updates and control buttons.
   - macOS native: exercise zsh Unicode/ANSI/TUI output and modifier keys as specified in Issue 2.
   - Mobile: exercise the native VNC bridge on Android or iOS, including intentional navigation away/backgrounding. Record platform/version and whether teardown is expected or unexpected.
5. Produce the PR description from verified facts only, with: summary bullets for the four fixes; test commands and results; manual validation performed/not performed; and noVNC/macOS device limitations explicitly stated. Do not claim a device scenario that was not run.

## Assumptions & contingencies

- Absolute `workspaceRoot` is intentionally allowed outside daemon config/state storage; filesystem requests remain confined to that configured root by `fs.FS`.
- Minimize means UI-only removal from the visible split. It never invokes the API close path, destroys a PTY/socket, or removes the session tab. Restore uses the first available slot deterministically.
- The existing shared `ShortcutKeyboard` plus `focusedSessionId` routing is retained because repository tests/code show no broadcast fan-out; only modifier consumption and streaming UTF-8 decoding change.
- Streaming UTF-8 state belongs to each `SessionSocket`; reconnect/close discards an incomplete trailing sequence rather than carrying bytes into a new PTY stream.
- The noVNC native queue is bounded by connection startup ordering in one WebView load. If runtime evidence shows the receiver never installs, surface the existing status/error instead of retrying or growing an unbounded reconnect mechanism.
- Backend VNC integration binds loopback only and uses ephemeral ports. No external VNC service, network access, sleep-based synchronization, or privileged port is required.
- If Expo’s platform resolver still pulls the generated IIFE into the web build, split the Desktop implementation into `.web.tsx` and `.native.tsx` siblings with a shared controls helper; this is the sole pre-decided fallback. Do not modify Metro configuration.
- Darwin daemon installation/service management is not part of these four regressions. If later requested, use a user LaunchAgent/launchd convention rather than systemd.
