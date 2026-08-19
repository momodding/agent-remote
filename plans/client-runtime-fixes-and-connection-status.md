# Client runtime fixes and connection status

<!-- source-branch: main -->
<!-- work-branch: omp/client-runtime-fixes-and-connection-status -->

## Context

Fix seven reported defects on web and Android: the Android noVNC channel disconnect, missing web VNC controls, file-route text-node crashes, session-sheet input failure and excessive web height, split-session limits, terminal edge/selection errors, and malformed zsh output. Add a dashboard daemon-state indicator, per-connection state plus latency, and QR/raw-JSON import in the connection editor.

The implementation is a clean cutover. It reuses the existing noVNC bridge, pairing parser/camera flow, `/ping` endpoint, API object, terminal fit logic, and multi-session state helpers. No new dependency, compatibility shim, protocol endpoint, or backend wire type is needed.

## Implementation

### 1. Correct the PTY environment at process creation

Files:
- `/home/momodding/Documents/agentic-remote/backend/internal/session/manager.go`
- `/home/momodding/Documents/agentic-remote/backend/internal/session/manager_test.go`

Changes:
- In `Manager.Create`, set the PTY command environment to `append(os.Environ(), "TERM=xterm-256color")` immediately before `pty.StartWithSize`.
- Preserve the complete inherited environment; do not replace it with a TERM-only environment and do not modify shell startup files or terminal output after the fact.
- Add one observable PTY test using the existing manager/session read path. The child shell prints `$TERM` and a sentinel inherited environment variable; assert `xterm-256color` and the sentinel both reach the PTY. This guards the zsh/theme fix and prevents a regression that strips the daemon environment.

Acceptance:
- Newly created zsh sessions receive a real xterm capability name, render prompts/themes through the existing terminal emulator, and no longer concatenate prompt, command, and command output because the shell is no longer operating with an absent/dumb terminal definition.

### 2. Complete the Android noVNC raw-channel contract and restore web controls

Files:
- `/home/momodding/Documents/agentic-remote/client/app/desktop.tsx`
- `/home/momodding/Documents/agentic-remote/client/src/desktop-route.test.tsx`

Changes:
- In the native WebView HTML builder, make the object passed to noVNC satisfy every property that `@novnc/novnc/lib/websock.js` validates: `send`, `close`, `binaryType`, `onerror`, `onmessage`, `onopen`, `protocol`, and `readyState`.
- Initialize `binaryType` to `arraybuffer`, `protocol` to an empty string, callback properties to nullable functions, and `readyState` to numeric WebSocket OPEN (`1`). Keep `send` routed through the existing WebView `postMessage` bridge. Implement `close` as a no-op because React Native owns and closes the real WebSocket on route teardown; no second socket lifecycle is introduced in the WebView.
- Keep inbound binary frames delivered through the channel's assigned `onmessage` callback with an ArrayBuffer payload; keep bridge errors delivered through `onerror` rather than treating setup as an immediate disconnect.
- In the web HTML builder, render the existing VNC shortcut definitions as the same visible control/menu surface available in the native builder. Wire each button to the existing noVNC `sendKey`/shortcut dispatch, including Ctrl+Alt+Delete; do not add a second shortcut table.
- Extend route tests to assert the full raw-channel shape and numeric OPEN state in native HTML, and to assert the web HTML contains the shortcut/menu controls and their dispatch wiring.

Acceptance:
- Android noVNC attaches to the bridged channel without `desktop disconnected unexpectedly` from raw-channel validation.
- Web desktop exposes the VNC menu/shortcut controls and sends keys through the live RFB instance.

### 3. Remove invalid React Native text children and fix the session sheet on web

Files:
- `/home/momodding/Documents/agentic-remote/client/app/files.tsx`
- `/home/momodding/Documents/agentic-remote/client/src/files-route.test.tsx`
- `/home/momodding/Documents/agentic-remote/client/src/components/AddSessionFAB.tsx`
- `/home/momodding/Documents/agentic-remote/client/src/components/GlassBottomSheet.tsx`
- The existing AddSessionFAB/GlassBottomSheet test file under `/home/momodding/Documents/agentic-remote/client/src/` if present; otherwise add `/home/momodding/Documents/agentic-remote/client/src/components/AddSessionFAB.test.tsx`.

Changes:
- In `files.tsx`, replace string-valued `value && <Component>` children under React Native `View` nodes with explicit ternaries returning the component or `null`. Apply this to every affected loading/error/selection/path/empty-state branch in the route, not only the reported branch. Keep strings inside `Text` nodes.
- Add a route regression case with empty optional strings and no selection; render must complete without a raw text child under `View`.
- In `AddSessionFAB.tsx`, select the input component once: React Native `TextInput` on web, existing `BottomSheetTextInput` on native. Preserve all current props, validation, focus behavior, and submit behavior. This avoids the bottom-sheet library's unsupported `RNTextInput.default.State.currentlyFocusedInput` call on React Native Web without changing Android behavior.
- In `GlassBottomSheet.tsx`, use `['55%', '90%']` snap points on web and retain `['55%', '100%']` on native. Keep the existing bottom-sheet component and gesture behavior.
- Test that the web branch renders the plain React Native input and receives `['55%', '90%']`; test the native branch retains the bottom-sheet input and current native snap points.

Acceptance:
- `/files` renders on web and Android when optional values are empty, with no `Unexpected text node` exception.
- Opening/using New Session on web does not call the unsupported bottom-sheet focus API.
- The expanded web sheet stops at 90% and does not intersect the browser address-bar area; Android retains full-height expansion.

### 4. Generalize split placement to four web slots while retaining two mobile slots

Files:
- `/home/momodding/Documents/agentic-remote/client/src/lib/multi-session.ts`
- `/home/momodding/Documents/agentic-remote/client/src/lib/multi-session.test.ts`
- `/home/momodding/Documents/agentic-remote/client/src/components/MultiTerminal.tsx`
- The existing MultiTerminal component test under `/home/momodding/Documents/agentic-remote/client/src/` if present.

Changes:
- Replace the fixed `{ left, right }` `SplitLayout` with one ordered `slots: Array<string | null>` representation. Migrate every helper and caller in the files above; remove all left/right compatibility paths.
- Keep `MAX_MULTI_SESSIONS = 5`: one primary session plus at most four auxiliary split sessions on web. Derive the auxiliary slot count as `4` for `Platform.OS === 'web'` and `2` otherwise.
- Normalize layouts to the active platform's slot count when sessions are added, removed, selected, or restored: retain occupied slots in order, remove IDs no longer present, prevent duplicates, and fill missing entries with `null`.
- Render web auxiliary terminals as a stable 2-by-2 grid ordered top-left, top-right, bottom-left, bottom-right. Render mobile auxiliary terminals in the existing two-pane arrangement.
- Replace the fixed left/right drop rectangles with indexed slot rectangles. For web, compute quadrant from measured container bounds using column `index % 2` and row `Math.floor(index / 2)`; for mobile, preserve the current two horizontal targets. Drag hover and drop update the indexed slot only and continue preventing the primary/duplicate session from being assigned twice.
- Extend pure helper tests for the two-slot and four-slot limits, session removal, duplicate prevention, and deterministic slot compaction. Extend the component test for four web drop targets and two native targets.

Acceptance:
- Web supports one primary terminal plus four split terminals in a 2-by-2 auxiliary grid.
- Android supports one primary terminal plus two split terminals and cannot expose/drop into a third auxiliary slot.
- Existing session switching, closing, and drag/drop preserve unique session placement.

### 5. Put terminal padding outside xterm's hit-test rectangle

Files:
- `/home/momodding/Documents/agentic-remote/client/src/components/Terminal.web.tsx`
- `/home/momodding/Documents/agentic-remote/client/src/components/Terminal.tsx`
- `/home/momodding/Documents/agentic-remote/client/src/components/terminal_html.ts`
- `/home/momodding/Documents/agentic-remote/client/src/lib/touch-select.ts`
- `/home/momodding/Documents/agentic-remote/client/src/lib/touch-select.test.ts`
- Update the checked-in terminal HTML source used to generate `/home/momodding/Documents/agentic-remote/client/src/components/terminal_html.ts` if that source is present; regenerate with the repository's existing generator rather than hand-diverging the two copies.

Changes:
- Remove padding from the xterm element/body whose bounding rectangle is used for pointer/touch cell conversion.
- Add the same 8px inset to an outer React Native/web or HTML shell. The inner terminal remains `width: 100%`, `height: 100%`, and is the element observed by `FitAddon`/resize logic, so fitted columns and rows account for the inset instead of being clipped.
- On web, place the xterm host div inside the padded wrapper and keep resize observation/fitting attached to the inner host.
- In native terminal HTML, place `#terminal` inside a padded, border-box shell; keep `term.element.getBoundingClientRect()` as the selection origin. Do not subtract padding in JavaScript: the outer shell makes the terminal rectangle itself authoritative.
- Keep `Terminal.tsx` WebView layout edge-to-edge; padding belongs inside the HTML shell so WebView message coordinates and xterm coordinates share the same origin.
- Extend touch-selection tests with a non-zero terminal rectangle origin and boundary clicks to prove the first/last visible cells map correctly and clicks in the outer padding do not shift selection.

Acceptance:
- Terminal glyphs have an 8px visual inset on web and Android, the final row/column are not truncated, and click/touch selection maps to the intended cell at both edges.

### 6. Add one reusable `/ping`-backed connection indicator

Files:
- `/home/momodding/Documents/agentic-remote/client/src/lib/api.ts`
- `/home/momodding/Documents/agentic-remote/client/src/components/ConnectionStatusIndicator.tsx` (new)
- `/home/momodding/Documents/agentic-remote/client/src/components/ConnectionStatusIndicator.test.tsx` (new)
- `/home/momodding/Documents/agentic-remote/client/app/index.tsx`
- `/home/momodding/Documents/agentic-remote/client/src/dashboard-route.test.tsx`
- `/home/momodding/Documents/agentic-remote/client/src/components/ConnectionSheet.tsx`

Changes:
- Add `AgenticRemoteAPI.ping(signal?: AbortSignal): Promise<void>`. Request the existing HTTPS `/ping` endpoint through the API's existing authenticated fetch/configuration path, read text rather than JSON, and reject unless the successful response body is exactly `pong`. Do not add a backend endpoint or protocol model.
- Add a small `ConnectionStatusIndicator` component that accepts an API instance and optional `showLatency`/label props. On mount or API change it immediately enters `connecting`, measures one ping with `performance.now()`, then renders `ready` plus rounded milliseconds or `error`. Poll every five seconds; prevent overlapping probes; abort and clear the timer on unmount/API change. A ready indicator remains green during background refresh to avoid five-second yellow flicker; an error retry enters yellow until it succeeds or fails.
- Use fixed accessible state text and colors: red + `Error`, yellow + `Connecting`, green + `Ready`; do not rely on color alone. When `showLatency` is true and a successful sample exists, append ` · N ms`.
- Render the indicator in the main dashboard header for the currently selected endpoint/API. With no selected endpoint, render red `Error` and do not poll.
- Render one indicator in each `ConnectionSheet` connection row using that row's existing connection/API configuration, with latency enabled. Keep row selection/edit actions independent of the status component.
- Test initial yellow, successful green with latency, failed red, retry transition, interval cleanup, and stale-response suppression after API change. Update dashboard tests for selected and absent endpoint states.

Acceptance:
- Dashboard header shows red on missing/failed daemon, yellow during initial/retry connection, and green when `/ping` returns `pong`.
- Every connection row shows the same state bullet plus its latest successful round-trip latency.

### 7. Import connection fields from QR or raw pairing JSON

Files:
- `/home/momodding/Documents/agentic-remote/client/src/components/ConnectionSheet.tsx`
- The existing ConnectionSheet test under `/home/momodding/Documents/agentic-remote/client/src/` if present; otherwise add `/home/momodding/Documents/agentic-remote/client/src/components/ConnectionSheet.test.tsx`.

Changes:
- Reuse `parsePairingPayload` from `/home/momodding/Documents/agentic-remote/client/src/lib/connection.ts` and the existing `CameraView`/`useCameraPermissions` QR flow from `/home/momodding/Documents/agentic-remote/client/src/components/PairingSheet.tsx`; do not introduce another payload parser or camera dependency.
- Add one local `applyPairingPayload(raw)` path. It parses the raw string, maps the parsed daemon URL, fingerprint/verification option, pairing credential, and display metadata into the same editable draft fields used by manual inputs, and does not save automatically. Both scanner and paste actions call this function.
- Add `Scan QR` and `Paste JSON` controls alongside the manual edit fields. `Scan QR` requests permission when needed, shows an inline QR-only `CameraView`, ignores duplicate scans while applying, populates the draft, and closes the scanner. Denied permission shows the existing inline error treatment and leaves manual/paste entry available.
- Add a multiline raw JSON input and `Apply JSON` action. Successful parse fills the draft while leaving it editable for review; invalid JSON/payload displays the parser error and preserves the current draft. Saving still goes through the existing validation and persistence callback.
- Reset scanner lock, raw input, and import error when the sheet closes or switches to another connection.
- Test raw JSON success, invalid input preservation, QR success, duplicate-scan suppression, permission denial, and the fact that import does not persist until the existing Save action runs.

Acceptance:
- A user can populate the connection editor by scanning the existing pairing QR payload or pasting its raw JSON, review/edit all populated fields, and save through the existing path on web and Android where camera support is available.

### 8. Cleanup and complete verification

Files:
- Any existing documentation/changelog entry that already enumerates supported UI behavior; update only if the changed split limits or connection import behavior is documented there. Do not create a new documentation file for these fixes.

Actions:
1. Run focused backend proof from `/home/momodding/Documents/agentic-remote`: `go test ./internal/session` with working directory `/home/momodding/Documents/agentic-remote/backend`.
2. Run the focused client Jest files covering desktop, files, dashboard, multi-session, terminal touch selection, AddSessionFAB/GlassBottomSheet, ConnectionStatusIndicator, and ConnectionSheet from `/home/momodding/Documents/agentic-remote/client` using the package's existing Bun/Jest command.
3. Run `/home/momodding/Documents/agentic-remote` command `make backend-test`.
4. Run `/home/momodding/Documents/agentic-remote` command `make client-test`.
5. Run `/home/momodding/Documents/agentic-remote` command `make lint`.
6. Run `/home/momodding/Documents/agentic-remote` command `make client-build-web`.
7. Launch the web client and daemon with the repository commands. In a real browser, verify: dashboard indicator yellow→green and latency; connection editor raw import and invalid error; web four-slot layout/drop targets; terminal 8px inset and first/last-cell selection; VNC menu visibility; files route; New Session sheet maximum height.
8. Launch the managed Android client against the daemon. Verify: noVNC reaches the connected desktop; mobile exposes only two auxiliary split targets; terminal edge selection; files route; QR import/permission behavior; a newly created zsh session renders prompt, command, and `pwd` output on separate lines.

If no Android device/emulator or VNC server is available, retain the automated bridge/layout/PTTY proof and report those two runtime checks as unperformed; do not claim visual/native verification.

## Critical anchors

- `/home/momodding/Documents/agentic-remote/backend/internal/session/manager.go`: `Manager.Create`, immediately before `pty.StartWithSize`.
- `/home/momodding/Documents/agentic-remote/client/app/desktop.tsx`: native raw WebSocket-channel object and web shortcut/menu HTML builders.
- `/home/momodding/Documents/agentic-remote/client/app/files.tsx`: conditional React children inside `View`.
- `/home/momodding/Documents/agentic-remote/client/src/components/AddSessionFAB.tsx`: input component chosen by platform.
- `/home/momodding/Documents/agentic-remote/client/src/components/GlassBottomSheet.tsx`: platform-specific snap points.
- `/home/momodding/Documents/agentic-remote/client/src/lib/multi-session.ts`: sole split-layout representation and normalization logic.
- `/home/momodding/Documents/agentic-remote/client/src/components/MultiTerminal.tsx`: platform slot count, grid rendering, and indexed drop rectangles.
- `/home/momodding/Documents/agentic-remote/client/src/components/terminal_html.ts`: outer inset/inner terminal geometry.
- `/home/momodding/Documents/agentic-remote/client/src/lib/api.ts`: text-returning `/ping` method.
- `/home/momodding/Documents/agentic-remote/client/src/components/ConnectionStatusIndicator.tsx`: sole polling/state/latency implementation.
- `/home/momodding/Documents/agentic-remote/client/src/components/ConnectionSheet.tsx`: per-row indicator and single parser path shared by QR/paste import.

## Assumptions and contingencies

- “Web max 4 splits; mobile max 2” means four/two auxiliary terminals in addition to the primary terminal. The existing `MAX_MULTI_SESSIONS = 5` confirms the web total of five.
- `/ping` remains the existing exact-text `pong` endpoint. Authentication/TLS/fingerprint behavior continues through `AgenticRemoteAPI`; no plaintext fallback is permitted.
- The pairing QR encodes the same payload accepted by `parsePairingPayload`. Scanner and paste deliberately populate the draft rather than triggering pairing or persistence.
- The native noVNC `close` method is intentionally inert because the React Native owner controls the real WebSocket. If runtime evidence shows noVNC must initiate closure, route a close bridge message through the existing owner instead of creating a second WebSocket.
- `TERM=xterm-256color` is applied only to new sessions. Persisted/running PTYs are not mutated.
- No new dependencies. Existing Expo Managed/Expo Go compatibility is preserved.