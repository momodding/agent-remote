<!-- omp-source-branch: main -->
<!-- omp-work-branch: omp/fingerprint-bypass-2 -->
## Context

Android client connection to an arm64 daemon can fail with `Bad state: client certificate mismatch`. The current repo already has QR fingerprints (`backend/internal/security/pairing.go`), daemon JSON config (`backend/internal/config/config.go`), and a Flutter checkbox/API parameter named `skipFingerprintVerification`, but `client/lib/src/services/agentic_remote_transport_io.dart` currently ignores the fingerprint arguments and accepts every bad certificate. End state: fingerprint validation is enforced by default on native clients, and an explicit opt-in bypass can be enabled from daemon JSON config, client build config, or the existing Android checkbox.

## Approach

### Backend: carry an explicit bypass bit in config and QR payload

1. Add `SkipFingerprintVerification bool` with JSON tag `json:"skipFingerprintVerification"` to `backend/internal/config.Config` next to `AllowDestructiveFiles`; set `SkipFingerprintVerification: false` in `Default()`. Do not add validation: both boolean values are valid, and false is the safe default.
2. Add `SkipFingerprintVerification bool` with JSON tag `json:"skipFingerprintVerification,omitempty"` to `backend/internal/security.PairingPayload`. Keep the existing required `fingerprint` field populated even when bypass is true so older clients and diagnostics still see the daemon certificate fingerprint.
3. Change `(*PairingStore).Create` in `backend/internal/security/pairing.go` from `Create(endpoint, fingerprint string, now time.Time)` to `Create(endpoint, fingerprint string, skipFingerprintVerification bool, now time.Time)`. Set the returned payload field from the new argument.
4. Update every `PairingStore.Create` callsite. The exact grep `\.Create\(` under `backend/internal/security;backend/cmd;backend/internal;backend/*` currently returns:
   - `backend/cmd/agenticRemote/main.go:233`: pass `cfg.SkipFingerprintVerification`.
   - `backend/internal/security/auth_test.go:18,38,64,77,96,127`: pass `false`, except the new bypass payload test below passes `true`.
5. Update `backend/cmd/agenticRemote/main_test.go` helper `writeConfig` to include `"skipFingerprintVerification": false` after `"allowDestructiveFiles": false` so the explicit sample config remains complete.
6. Update `examples/config.local.json` and `examples/config.local.http.json` to include `"skipFingerprintVerification": false` after `"allowDestructiveFiles": false`.
7. Add backend tests:
   - In `backend/internal/config/config_test.go`, extend `TestDefaultValues` with `if cfg.SkipFingerprintVerification { t.Fatal("fingerprint bypass must default off") }`.
   - Add `TestLoadAcceptsFingerprintBypass` in `backend/internal/config/config_test.go`: write a temp JSON config containing the same required fields as `backend/cmd/agenticRemote/main_test.go:121-135` plus `"skipFingerprintVerification": true`, call `Load(path)`, and assert `cfg.SkipFingerprintVerification` is true.
   - Add `TestPairingPayloadCarriesFingerprintBypass` in `backend/internal/security/auth_test.go`: create a pairing with `store.Create("https://127.0.0.1:8765", "AA:BB", true, time.Now().UTC())`, assert `payload.SkipFingerprintVerification` is true, marshal it with `json.Marshal`, and assert the JSON contains `"skipFingerprintVerification":true`. Reuse existing imports `encoding/json`, `strings`, and `time` already present in that file.

### Client protocol and config: make bypass explicit and default-off

1. Add `final bool skipFingerprintVerification;` to `client/lib/src/protocol/messages.dart` `PairingPayload`.
2. Change the `PairingPayload` constructor to include `this.skipFingerprintVerification = false` so existing test object construction and old QR payloads remain valid.
3. Keep `PairingPayload.fromJson` required-field validation unchanged for `v`, `endpoint`, `fingerprint`, `pairingId`, `token`, and `expiresAt`; parse the new optional field as `skipFingerprintVerification: json['skipFingerprintVerification'] == true`. Missing, null, or false means false.
4. Add a client build-config flag in `client/lib/src/services/agentic_remote_api.dart`: `const bool clientConfigSkipFingerprintVerification = bool.fromEnvironment('AGENTICREMOTE_SKIP_FINGERPRINT_VERIFICATION');`. This is the client config flag; set it with Flutter `--dart-define=AGENTICREMOTE_SKIP_FINGERPRINT_VERIFICATION=true` for builds that should default to bypass.
5. Add `@visibleForTesting bool shouldSkipFingerprintVerification(PairingPayload payload, bool requestedSkip)` in `client/lib/src/services/agentic_remote_api.dart`; return `requestedSkip || payload.skipFingerprintVerification || clientConfigSkipFingerprintVerification`.
6. In `AgenticRemoteApi.connectFromPayload`, compute `_skipFingerprintVerification = shouldSkipFingerprintVerification(pairing!, skipFingerprintVerification)` after parsing `pairing`. Use that field for diagnostics and for both transport calls. Keep the existing literal diagnostic `Fingerprint verification skipped` when effective skip is true.
7. In `client/lib/src/state/app_state.dart`, expose `static const bool defaultSkipFingerprintVerification = clientConfigSkipFingerprintVerification;` inside `AppState` so UI defaults can copy the build config without duplicating the Dart-define key.
8. In `client/lib/src/features/dashboard/session_dashboard.dart`, initialize `_SessionDashboardState.skipFingerprintVerification` to `AppState.defaultSkipFingerprintVerification` instead of `false`. Keep the existing checkbox label `Skip fingerprint verification`; it remains the runtime per-connection override on Android/native clients.

### Native certificate validation: enforce pinning unless bypass is effective

1. In `client/lib/src/services/agentic_remote_api.dart`, import `dart:typed_data` and `package:crypto/crypto.dart`.
2. Add `@visibleForTesting String formatCertificateFingerprint(Uint8List der)` that returns uppercase SHA-256 bytes joined by `:`. Exact implementation: `sha256.convert(der).bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0').toUpperCase()).join(':')`.
3. Replace both current `formatFingerprint: (_) => ''` arguments in `AgenticRemoteApi.connectFromPayload` and `_authenticate` with `formatFingerprint: formatCertificateFingerprint`.
4. In `client/lib/src/services/agentic_remote_transport_io.dart`, replace `_insecureHttpClient()` with `_httpClient({String? trustedFingerprint, required String Function(Uint8List) formatFingerprint, required bool skipFingerprintVerification})`.
5. Update `createHttpClient` to return `IOClient(_httpClient(trustedFingerprint: trustedFingerprint, formatFingerprint: formatFingerprint, skipFingerprintVerification: skipFingerprintVerification))`.
6. Update `connectWebSocket` to pass the same `_httpClient(...)` as `customClient` to `IOWebSocketChannel.connect`.
7. `_httpClient` behavior:
   - Always create a `HttpClient`.
   - If `skipFingerprintVerification` is true, set `client.badCertificateCallback = (cert, host, port) => true` and return it. Keep a `// ponytail:` comment on this branch: `// ponytail: internal-only escape hatch; remove when managed CA trust exists.`
   - If `skipFingerprintVerification` is false, set `client.badCertificateCallback` to return false when `trustedFingerprint` is null or empty; otherwise return `formatFingerprint(cert.der) == trustedFingerprint.toUpperCase()`. This lets platform-trusted certificates pass normally without the callback, lets self-signed daemon certificates pass only when their presented DER hash matches the QR fingerprint, and rejects mismatches.
8. Do not change `client/lib/src/services/agentic_remote_transport_web.dart`: web clients cannot pin certificates, and the current web implementation ignores the fingerprint parameters because browser TLS trust is the only available verifier.

### Client tests for the new observable behavior

1. In `client/test/protocol_messages_test.dart`, extend the accept test to assert missing `skipFingerprintVerification` defaults false. Add a second accepted payload with `"skipFingerprintVerification": true` and assert `payload.skipFingerprintVerification` is true. Keep the missing-fingerprint rejection unchanged.
2. In `client/test/agentic_remote_api_test.dart`, add tests for:
   - `formatCertificateFingerprint(Uint8List.fromList([1, 2, 3]))` equals the SHA-256 fingerprint string produced by the implementation. Compute the expected literal once during implementation and put the literal in the test; do not duplicate the hashing algorithm in the test.
   - `shouldSkipFingerprintVerification` returns false when both the QR payload field and requested checkbox flag are false.
   - `shouldSkipFingerprintVerification` returns true when the requested checkbox flag is true.
   - `shouldSkipFingerprintVerification` returns true when the QR payload contains `skipFingerprintVerification: true`.
3. In `client/test/session_dashboard_test.dart`, add a widget test that pumps `SessionDashboard(state: AppState())` and asserts the text `Skip fingerprint verification` is present on non-web test runs. The current file already imports `ShadInput`, `SessionDashboard`, and `AppState`; no new dependency is needed.

## Critical files & anchors

- `backend/internal/config/config.go` — `Config`, `Default`, and `Load` define daemon JSON config shape and defaults.
- `backend/internal/security/pairing.go` — `PairingPayload` and `PairingStore.Create` define the QR JSON that the client consumes.
- `backend/cmd/agenticRemote/main.go` — `serve` and `rotatePairing` are where daemon config reaches QR payload creation.
- `client/lib/src/protocol/messages.dart` — `PairingPayload.fromJson` is the client QR parser; keep the new bypass field optional.
- `client/lib/src/services/agentic_remote_transport_io.dart` — native HTTP/WebSocket TLS handling currently ignores fingerprint arguments; this is the root-cause fix for enforcing or bypassing certificate validation.

## Verification

Run from repo root unless noted.

1. Backend targeted proof: `cd backend && go test ./internal/config ./internal/security ./cmd/agenticRemote`. Expected: all tests pass, including the new default-off config test, load-true config test, and QR payload bypass JSON test.
2. Client targeted proof: `cd client && flutter test test/protocol_messages_test.dart test/agentic_remote_api_test.dart test/session_dashboard_test.dart`. Expected: all tests pass, including optional QR field parsing, fingerprint formatting, effective bypass precedence, and dashboard checkbox visibility.
3. End-to-end smoke proof for bypass config:
   - Create a temp daemon config from `examples/config.local.json` with `listenAddr` changed to `127.0.0.1:0` and `skipFingerprintVerification` changed to `true`.
   - Run `cd backend && AGENTICREMOTE_TEST_ONESHOT=1 go run ./cmd/agenticRemote serve --config <temp-config>`, capturing stdout.
   - Expected stdout JSON QR payload contains both a non-empty `"fingerprint":"..."` and `"skipFingerprintVerification":true`.
   - This proves daemon config reaches the client-visible QR payload; the client tests prove that payload disables fingerprint validation.
4. Build/typecheck proof after targeted tests: run `make backend-test` and `make client-test` if the targeted commands pass. Expected: both pass.

## Assumptions & contingencies

- The daemon config flag is named `skipFingerprintVerification` to match the existing Flutter parameter and checkbox. If another config key with the same meaning appears during implementation, reuse the existing key and update all references to that exact name instead of adding a duplicate.
- The client config flag is a Flutter compile-time environment flag, `AGENTICREMOTE_SKIP_FINGERPRINT_VERIFICATION`, because this client currently has no persistent settings/config file and `pubspec.yaml` has no preferences package. If a persistent client config file is discovered during implementation, add a stored bool with the same semantic name there and use it as the default checkbox value; do not add a new dependency.
- Effective client bypass is `checkbox/requested skip OR QR payload skip OR client build config skip`. This makes either side's explicit bypass setting sufficient to connect without fingerprint verification while preserving default validation when all flags are false.
- If native `HttpClient.badCertificateCallback` is not invoked for platform-trusted certificates, do not force extra pin checks for trusted public-CA endpoints; existing protocol docs say native clients first accept platform-trusted TLS, otherwise require the QR fingerprint.
