# Fix Android SAF, open-with, and noVNC
<!-- source-branch: main -->
<!-- work-branch: omp/fix-android-saf-open-novnc-plan-2 -->

## Problem

Three Android paths fail for separate native reasons:

1. `FileSystem.copyAsync` treats a `content://` SAF destination as a filesystem path and calls `Uri.toFile()`, so downloads fail with “directory cannot be created.”
2. Direct `ACTION_VIEW` through `expo-intent-launcher` does not force a chooser and remains constrained by Android package visibility/content handling. `expo-sharing` already provides a native chooser with URI grants.
3. `react-native-webview` cancels every self-signed TLS error in `RNCWebViewClient.onReceivedSslError`. noVNC’s in-WebView `wss://` connection therefore dies before JavaScript receives a useful error. React Native’s socket path already supports the daemon’s explicit `skipFingerprintVerification` policy.

## Implementation

1. **Write SAF downloads through Expo’s resolver-backed API** — `client/app/files.tsx`
   - Keep existing temporary server download.
   - Read the temporary file as base64 with `FileSystem.readAsStringAsync(..., { encoding: FileSystem.EncodingType.Base64 })`.
   - Write that base64 payload to the SAF-created `content://` URI with `FileSystem.writeAsStringAsync(..., { encoding: FileSystem.EncodingType.Base64 })`.
   - Preserve existing cleanup and user-visible success/error handling.

2. **Use native sharing chooser for Android open-with** — `client/app/files.tsx`, `client/package.json`, `client/bun.lock`
   - Route Android `open` mode through existing `Sharing.shareAsync` with the downloaded file URI, MIME type, and UTI where available.
   - Remove direct `ACTION_VIEW` and all `expo-intent-launcher` imports/code.
   - Remove `expo-intent-launcher` dependency with Bun; add no replacement dependency.

3. **Move noVNC transport outside WebView** — `client/app/desktop.tsx`
   - Keep noVNC rendering/protocol logic in WebView, but replace its URL socket with a minimal WebSocket-compatible raw channel passed to `new RFB(target, channel)`.
   - Implement required channel surface only: `send`, `close`, `binaryType`, `onerror`, `onmessage`, `onopen`, `protocol`, and string-valued `readyState`.
   - Open authenticated VNC WSS from React Native using existing `SessionSocket`/global WebSocket path and existing `skipFingerprintVerification` setting.
   - Relay binary frames both ways as base64 through `WebView.postMessage` and `injectJavaScript`, matching established `Terminal.tsx` bridge pattern.
   - Forward open, close, and error state to channel; close socket on screen unmount. Do not add reconnect machinery or native code/config plugins.

4. **Cover changed Android contracts** — `client/src/files-route.test.tsx` and existing desktop-route test location (or one focused `client/src/desktop-route.test.tsx` if none exists)
   - Update filesystem mocks/assertions to prove SAF writes use base64 `readAsStringAsync` + `writeAsStringAsync`, never `copyAsync` to a content URI.
   - Update Android open assertions to prove `Sharing.shareAsync` receives downloaded URI and MIME metadata; remove intent-launcher mocks.
   - Add focused bridge assertions: WebView outbound binary reaches native socket, native binary is injected back into WebView, explicit fingerprint-skip option propagates, and cleanup closes socket.

5. **Verify**
   - Run focused Jest tests for files and desktop routes.
   - Run `make client-test`.
   - Run `make client-build-web` to catch Expo/TypeScript bundling errors.

## Non-goals

- No Android native project, config plugin, certificate trust override, new package, reconnect state machine, or backend protocol change.
- No change to iOS/web download or desktop behavior beyond shared code required by these fixes.
