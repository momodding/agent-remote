## Context

Android pairing currently has three separate reliability problems in the current Expo/React Native client:

- Scanned and pasted v2 payloads already converge through `PairingSheet.connect` → `parsePairingPayload` → `Dashboard.connect` → `authenticatePairing`, but `Dashboard.connect` catches connection errors and resolves. `PairingSheet` therefore dismisses as if pairing succeeded after a failed bootstrap.
- `PairingSheet` treats every non-granted camera state as requestable, does not distinguish initial permission loading from permanent denial, does not test camera availability, and does not surface `CameraView.onMountError`.
- `authenticatePairing` makes one `wss:` attempt. Android release builds reject cleartext by default, while Expo JavaScript cannot dynamically trust the daemon's self-signed certificate. The daemon already accepts HTTPS and plain HTTP on the same port through `sniffListener`, so a narrowly guarded Android `wss:` → `ws:` retry can provide direct-LAN connectivity without changing Auth-v2.

The daemon currently creates a v2 `security.PairingPayload` every rotation, prints its QR and raw JSON, and discards the command-layer reference. `/v1/pairing` is unsuitable for the requested browser UI because it is bearer-authenticated and mints an independent payload. The browser must display the exact payload most recently produced by `rotatePairing` and must use separate Basic Auth credentials.

Static source does not prove one runtime cause for the reported Android failure. Loopback `publicEndpoint`/`allowedCidrs`, stale native builds, camera permission state, self-signed TLS, and Android cleartext policy remain operational checks. Changes below fix code paths that are directly visible without claiming one of those was the sole cause.

## Approach

### 1. Publish the exact rotating payload safely

- In `backend/internal/security/pairing.go`, add an in-memory `PairingSnapshot` holding a cloned `*PairingPayload` behind `sync.RWMutex`.
  - `Store(*PairingPayload)` copies the struct before publishing it.
  - `Load() (*PairingPayload, bool)` returns another copy so HTTP rendering cannot race with or mutate rotation state.
  - Keep this separate from `PairingStore`: it is ephemeral presentation state, not another persisted or consumable credential record.
- In `backend/cmd/agenticRemote/main.go::serve`, create one snapshot before `server.New`, pass the same pointer to the server and rotation goroutine, and retain the existing paired hook/`qrRefresh` behavior.
- Change `rotatePairing` to accept `context.Context` and the snapshot. Production calls it with `context.Background()`; focused tests use `context.WithCancel`. After `PairingStore.Create` succeeds, publish that payload before terminal printing and before signaling `pairingReady`. Replace `time.After` with a stopped/drained `time.Timer` and select on timer, `qrRefresh`, and `ctx.Done()` so tests can stop the loop without leaking a goroutine or timer.
- Do not clear the snapshot when a proof consumes a payload. The existing paired hook immediately requests another rotation; leaving the last snapshot in place avoids a transient empty page until replacement creation succeeds. Failed creation keeps the last successfully published payload visible, with its real `expiresAt`, while the daemon logs the failure.
- Keep `printPairing` and terminal behavior unchanged. Both terminal QR and browser page serialize the same published `PairingPayload` fields.

### 2. Add opt-in pairing-page credentials to daemon config

- Extend `backend/internal/config/config.go::Config` with:
  - `PairingPageUsername string \`json:"pairingPageUsername"\``
  - `PairingPagePassword string \`json:"pairingPagePassword"\``
- Default both to empty strings. This preserves existing config files and avoids shipping a universal credential. Empty/empty disables and does not register the browser route; non-empty/non-empty enables it; exactly one non-empty value fails `Validate` with a specific both-or-neither error. Do not trim or rewrite credentials: compare exact configured bytes and document that leading/trailing whitespace is significant.
- `config init` continues to emit both fields through `WriteSample`, initially empty. Users must explicitly set both to expose the page. Because the JSON can now contain a password, change `WriteSample` to create/chmod daemon config files as owner-only `0600`; cover both newly created and overwritten files in tests and document the permission change.
- Update `examples/config.local.json`, `examples/config.local.http.json`, and `examples/config.daemonB.json` to include both keys as empty strings, keeping runnable examples securely disabled. Documentation may show `"pairing"` / `"replace-with-a-long-random-password"` only as values operators must replace before enabling the route or binding beyond loopback.
- Update config tests for default empty values, valid enabled/disabled pairs, each half-configured rejection, JSON overlay behavior, sample JSON output, and `0600` sample-file mode on platforms supporting POSIX permissions. Update full JSON fixtures/assertions in `backend/cmd/agenticRemote/main_test.go` so configuration initialization coverage includes the new keys.

### 3. Serve one Basic-Auth pairing page

- Extend `backend/internal/server/server.go::Server` and `server.New(...)` with the shared `*security.PairingSnapshot`; update both current call sites (`cmd/agenticRemote/main.go` and the server test helper).
- When both credentials are configured, register `GET /pairing` in `Server.Handler`. Do not reuse `withAuth` or `/v1/pairing`; existing bearer-token API behavior stays unchanged. The global allowed-CIDR middleware continues to protect this route as it protects every route.
- Add a pairing-page Basic Auth wrapper:
  - Read credentials with `r.BasicAuth()`.
  - Hash supplied and configured username/password with SHA-256 and compare both digests using `crypto/subtle.ConstantTimeCompare`; require both comparisons to succeed.
  - On missing or incorrect credentials, set `WWW-Authenticate: Basic realm="agenticRemote pairing", charset="UTF-8"` and return `401` without revealing which value failed.
  - Set `Cache-Control: no-store, max-age=0`, `Pragma: no-cache`, and `X-Content-Type-Options: nosniff` on success and error responses for this route.
  - Accept only `GET`; return `405` plus `Allow: GET` for other methods.
- For an authenticated request:
  - If no payload has been published yet, return a small HTML `503 Service Unavailable` page with the same no-store headers and a five-second refresh.
  - Load one snapshot, marshal it once with `encoding/json`, and use those exact bytes for both visible raw JSON and QR generation. This guarantees QR and displayed text cannot come from different rotations.
  - Generate a 384px PNG using existing `github.com/skip2/go-qrcode` via `qrcode.Encode(rawJSON, qrcode.Medium, 384)`, base64-encode it, and embed it as a `data:image/png;base64,...` URI. A single authenticated route avoids a second image request, another auth challenge, and a cross-rotation race.
  - Render through `html/template`, never string interpolation. Show QR image, raw JSON in `<pre>`, endpoint, and expiry. Add `<meta http-equiv="refresh" content="5">` and explanatory text so an open browser follows normal rotation and post-pair refresh. If JSON or QR rendering fails, log server-side and return generic `500` without payload details.
- Move `github.com/skip2/go-qrcode` into the direct `require` block when `go mod tidy` updates `backend/go.mod`; no new QR dependency is needed.

### 4. Add focused backend behavior tests

- In `backend/internal/security` tests, cover snapshot empty state, copy-on-store, and copy-on-load.
- In `backend/cmd/agenticRemote/main_test.go`, run cancellable `rotatePairing` with a temporary store, wait for `pairingReady`, and assert the snapshot payload matches the store-created endpoint/fingerprint/skip flag and terminal-ready generation. Cancel and assert prompt goroutine exit.
- In `backend/internal/server/server_test.go`, reuse existing `httptest`/server setup and deterministic payload values. Cover:
  - Route absent/`404` when both credential fields are empty.
  - Missing and incorrect Basic credentials return `401`, exact challenge header, and no-store headers.
  - Correct credentials before publication return `503`.
  - Correct credentials after publication return `200`, `text/html; charset=utf-8`, no-store headers, escaped visible payload text, expiry/endpoint, and the base64 of `qrcode.Encode` over the exact marshaled snapshot.
  - A payload containing HTML-sensitive endpoint text is escaped rather than executable.
  - A second snapshot replaces both displayed text and embedded QR.
  - Non-GET methods return `405` with `Allow: GET`.
  - Existing `/v1/pairing`, bearer auth, health, bootstrap, and CIDR tests remain unchanged.

### 5. Add guarded Android HTTPS-to-HTTP bootstrap fallback

- In `client/src/lib/api.ts`, extract one Auth-v2 WebSocket attempt into a private helper taking an explicit endpoint. Keep all existing `auth.hello`, Argon2id/HMAC `auth.proof`, `auth.ok`, and error-frame behavior unchanged; generate a fresh `clientNonce` per attempt.
- Track whether any server frame has been received. Introduce an internal transport-error type for `onerror` and premature `onclose`, carrying that state. Guard promise settlement so `close`/`error` events after `auth.ok` cannot reject an already successful attempt.
- `authenticatePairing` first tries the payload endpoint. Retry once with only the scheme changed from `https:` to `http:` when every condition is true:
  1. `Platform.OS === 'android'`.
  2. Original scheme is `https:`.
  3. `payload.skipFingerprintVerification === true` (from daemon payload or the explicit pairing-sheet switch).
  4. Host is demonstrably local: `localhost`, a `.local` name, IPv4 loopback/link-local/RFC1918/CGNAT (`127/8`, `169.254/16`, `10/8`, `172.16/12`, `192.168/16`, `100.64/10`), or IPv6 loopback/link-local/ULA (`::1`, `fe80::/10`, `fc00::/7`). Keep this classifier as a pure tested helper; do not treat arbitrary public or single-label hostnames as local.
  5. First failure is a transport error before any server frame.
- Never retry after `auth.challenge`, an Auth-v2 `error` frame, malformed server data, proof computation failure, token expiry, or any other protocol/authentication failure. This avoids replaying a pairing after the server has participated in Auth-v2.
- Preserve host, port, and any normalized root path; change only `https` → `http` (therefore `wss` → `ws`). Emit a diagnostic such as `Secure transport unavailable; retrying direct LAN over HTTP...` before the second attempt.
- Return and persist the endpoint that succeeded. Thus `client/app/index.tsx` continues to call `saveConnection` once, but direct-LAN success is saved as `http://...` and later REST/session WebSockets consistently use HTTP/WS. Keep original fingerprint and skip flag in `PairedConnection`; fallback does not alter Auth-v2 credentials or claim certificate verification occurred.
- If retry fails, throw that failure with a message that names both attempted transport URLs without including pairing token, proof, or session token. Public endpoints, iOS, web, and payloads without explicit fingerprint-skip opt-in retain current one-attempt behavior.

### 6. Enable cleartext only in generated Android native builds

- Add SDK-compatible `expo-build-properties` to `client/package.json` and `client/bun.lock`.
- In `client/app.json`, add `[
  "expo-build-properties",
  { "android": { "usesCleartextTraffic": true } }
]` to `expo.plugins`. Keep the existing camera permission and `expo-camera` plugin.
- Document that this changes Android manifest policy during Expo prebuild/EAS builds and requires rebuilding/reinstalling the Android binary. Metro reload cannot change an installed manifest, and project config cannot change Expo Go's own native manifest. Application code still limits automatic cleartext fallback to the direct-LAN conditions above.

### 7. Make camera permission, availability, and retry states explicit

- Refactor `client/src/components/PairingSheet.tsx` without changing the payload parser or `onConnect` contract.
- On opening scan mode:
  - `permission === null`: show a loading indicator/status, not an actionable permission button.
  - `permission.granted`: call `CameraView.isAvailableAsync()` and show a checking state; mount `CameraView` only when it resolves `true`.
  - `!permission.granted && permission.canAskAgain`: show `Allow camera`; await `requestPermission()` and let returned hook state select the next UI.
  - `!permission.granted && !permission.canAskAgain`: explain permanent denial, show `Open camera settings` using `Linking.openSettings()`, and retain `Use pasted JSON`.
  - Availability false/rejection or `CameraView.onMountError`: show an explicit camera-unavailable/error state plus `Retry camera` and `Use pasted JSON`; never leave a blank camera box.
- Always provide `Use pasted JSON` while in scan mode. Reset scan availability/error and duplicate-scan lock when the modal closes or reopens.
- Add a synchronous ref lock around barcode handling and disable `onBarcodeScanned` while processing so repeated native detections trigger one connection attempt. Temporarily unmount/cover the camera while parsing/authenticating.
- Make the local `connect(raw)` return success/failure. Dismiss only after `onConnect` resolves. On invalid QR or failed bootstrap, keep/reopen scan mode, clear the lock, show the existing alert with the real error, and allow a retry. Pasted failures remain on the paste form.
- In `client/app/index.tsx::connect`, remove the catch that swallows bootstrap/save/load errors (or rethrow without a second alert). Let `PairingSheet` own the pairing failure alert so one failure produces one alert and no false dismissal. Keep diagnostic collection and successful save/session loading unchanged.
- Add stable accessibility labels to camera actions/status where needed for component tests.

### 8. Add focused client tests

- Expand `client/src/lib/api.test.ts` using the existing `session-socket.test.ts` WebSocket mock pattern. Cover:
  - Existing URL normalization.
  - Normal HTTPS Auth-v2 success returns the original endpoint.
  - Android + local HTTPS + explicit skip: first pre-frame transport failure creates one HTTP/WS retry and returns the HTTP endpoint.
  - Fresh client nonce/hello is sent on each opened attempt.
  - No fallback for iOS/web, skip=false, public hostname, already-HTTP endpoint, Auth-v2 error frame, malformed frame, or transport failure after any frame.
  - Both-attempt failure message is sanitized and contains no token/proof.
  - Pure local-host classifier boundary cases, especially `100.63` vs `100.64`, `172.15`/`172.16`/`172.31`/`172.32`, IPv6 ULA/link-local, `.local`, and public names.
- Create `client/src/components/PairingSheet.test.tsx` using `react-test-renderer`, following `ConnectionSheet.test.tsx` conventions and mocking `expo-camera`. Cover initial permission loading, requestable permission and request call, permanent denial/settings redirect, unavailable camera, mount error/retry, paste fallback, one callback for duplicate scans, failed scan staying retryable without dismissal, successful scan dismissal, failed paste staying open, and scan/paste delivering the same parsed v2 payload shape plus skip merge.
- Add/update a focused dashboard test only if needed to prove `Dashboard.connect` no longer swallows the rejected `onConnect`; otherwise component rejection/dismissal coverage plus the direct source change is sufficient.

### 9. Update operator documentation and examples

- Update `README.md` to say the daemon still prints terminal QR/raw JSON and, when both page credentials are configured, serves the same current payload at `/pairing`.
- Update `docs/android-daemon-connect.md`:
  - Replace claims that Expo Go can perform this self-signed fallback with precise custom/preview Android build instructions.
  - Show `listenAddr: "0.0.0.0:8765"`, a phone-reachable private/Tailscale `publicEndpoint`, matching `allowedCidrs`, `skipFingerprintVerification: true`, and pairing-page credentials.
  - Tell operators to rebuild/reinstall after the manifest change, open `http(s)://<daemon-host>:8765/pairing`, authenticate, then scan the displayed daemon QR (distinct from Metro QR).
  - Warn that HTTP fallback is unencrypted, is limited to local hosts, and sends the one-time Auth-v2 bootstrap over LAN; recommend trusted public TLS/VPN where possible.
  - Keep loopback/CIDR, stale payload, and stale TLS-certificate checks. Explicitly state a physical phone cannot reach daemon-host `127.0.0.1` and loopback-only CIDRs reject it.
- Update `docs/protocol.md` to describe `/pairing` as presentation of the current rotating payload, not a new protocol endpoint, and to state that scanned and pasted JSON still use `/v1/ws/sessions/bootstrap` Auth-v2.

## Critical files & anchors

- `backend/internal/security/pairing.go` — `PairingPayload`, `PairingStore`; add ephemeral copy-safe `PairingSnapshot`.
- `backend/cmd/agenticRemote/main.go` — `serve`, `rotatePairing`, `printPairing`, `sniffListener`; wire snapshot and cancellable publication while preserving same-port HTTP/HTTPS serving.
- `backend/internal/config/config.go` — `Config`, `Default`, `Validate`, `WriteSample`; add opt-in Basic Auth fields and both-or-neither validation.
- `backend/internal/server/server.go` — `Server`, `New`, `Handler`; register and render authenticated `/pairing` separately from bearer API routes.
- `backend/internal/config/config_test.go`, `backend/cmd/agenticRemote/main_test.go`, `backend/internal/server/server_test.go` — config migration, rotation publication, Basic Auth/page behavior.
- `client/src/components/PairingSheet.tsx` — permission/availability/error state machine, duplicate-scan suppression, retry, and correct dismissal.
- `client/app/index.tsx` — `connect`; stop converting pairing failure into a fulfilled callback.
- `client/src/lib/api.ts` — `authenticatePairing`; guarded Android transport retry around unchanged Auth-v2.
- `client/src/lib/api.test.ts`, `client/src/components/PairingSheet.test.tsx` — transport and camera behavior tests.
- `client/app.json`, `client/package.json`, `client/bun.lock` — Android cleartext manifest configuration through `expo-build-properties`.
- `examples/config.local.json`, `examples/config.local.http.json`, `examples/config.daemonB.json` — credential examples.
- `README.md`, `docs/android-daemon-connect.md`, `docs/protocol.md` — browser route, secure configuration, rebuild, and end-to-end instructions.

## Verification

Run focused checks first, then project suites:

1. `cd backend && go test ./internal/security ./internal/config ./internal/server ./cmd/agenticRemote`
2. `cd backend && go test ./...`
3. `cd client && bun run typecheck`
4. `cd client && bun run test -- src/lib/api.test.ts src/components/PairingSheet.test.tsx`
5. `cd client && bun run test`
6. `cd client && bunx expo config --type public` and confirm resolved plugins include `expo-build-properties` with Android `usesCleartextTraffic: true`.
7. Build/reinstall a preview Android APK (`make client-build CLIENT_TARGET=android` or the repository's EAS preview command); a Metro reload is insufficient for manifest verification.

Manual end-to-end scenario:

1. Use a non-production test config with `listenAddr` reachable on LAN, private/Tailscale `publicEndpoint`, matching phone source CIDR, `skipFingerprintVerification: true`, and non-example pairing-page credentials. Start daemon.
2. Request `/pairing` without credentials and with a wrong password; verify `401`, Basic challenge, and no payload disclosure. Authenticate correctly; verify page shows same JSON currently printed in terminal and QR/text change after timed rotation.
3. Pair from Android by scanning browser QR. Verify camera requestable denial, permanent denial/settings, and paste fallback are usable; verify successful flow reaches Auth-v2 and session listing.
4. Paste exact same displayed JSON and verify it follows same Auth-v2/save/session path. Use a fresh rotating payload because pairing credentials are one-time.
5. With private `https:` endpoint and explicit skip enabled, make self-signed WSS fail; verify diagnostic announces one HTTP retry, pairing succeeds over `ws:`, and saved endpoint is `http:`. Confirm later REST and session sockets use that saved endpoint.
6. Repeat with skip disabled and with a public hostname; verify no HTTP retry. Send an Auth-v2 error frame and verify no retry. Confirm logs/errors never expose pairing token, proof, Basic password, or session token.
7. Confirm existing trusted-HTTPS web/iOS/Android pairing, bearer APIs, terminal QR output, immediate post-pair rotation, and CIDR enforcement remain intact.

## Assumptions & contingencies

- Direct Android fallback targets a generated custom/preview app. Expo project config cannot modify Expo Go's installed manifest; if Expo Go itself blocks cleartext on a target version, paste/scan still parse correctly but transport fallback requires the rebuilt app.
- Enabling `usesCleartextTraffic` is app-wide at Android manifest level. Risk is bounded in application logic by Android-only, explicit skip opt-in, local-host classification, one retry, and pre-frame transport failure. If product requirements demand hostname-based LAN servers outside `.local`, add an explicit payload/config transport opt-in rather than broadening classification to arbitrary hosts.
- `skipFingerprintVerification` is already the operator/user opt-in for direct self-signed endpoints in this repository. Plan uses it as one fallback gate but does not erase the fingerprint field or alter Auth-v2. Documentation must clearly distinguish skipped certificate verification from unencrypted HTTP.
- Empty pairing-page credentials intentionally disable route for backward compatibility and secure defaults. No default or generated secret is silently installed. Checked-in example configs remain disabled; documentation placeholders must be replaced with a strong unique password before enabling the page.
- Pairing page is still subject to `allowedCidrs`; operators must include browser/phone networks deliberately. Basic Auth does not bypass source filtering.
- Five-second browser refresh may briefly show a just-consumed payload until paired-hook rotation publishes replacement; it never mints a separate browser payload. Displayed `expiresAt` remains authoritative.
- Pairing JSON contains a live one-time secret. No-store headers, Basic Auth, CIDR filtering, HTML escaping, log redaction, and no third-party page assets are required, but operators should still use HTTPS or a trusted private network for the browser page.
<!-- omp:source-branch main -->

<!-- omp:work-branch omp/android-daemon-pairing-page -->
