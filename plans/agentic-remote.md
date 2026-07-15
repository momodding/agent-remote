<!-- source-branch: none -->
# agenticRemote Execution Plan

## Context

The repository at `/home/momodding/Documents/agentic-remote` now contains the initial `agenticRemote` monorepo: Go backend in `backend/`, Flutter client in `client/`, root `Makefile`, install scripts, docs, examples, and `AGENTS.md`. Final baseline verification already passed before this change: `make test`, `make lint`, `make backend-build`, `make client-build-web`, `backend/bin/agenticRemote version`, and the current stub `backend/bin/agenticRemote pair --config examples/config.local.json --name smoke`.

This plan replaces the stale greenfield execution text with the next implementation: `agenticRemote serve --config ...` must start the HTTPS/WSS daemon and immediately begin rolling QR pairing. The QR changes every 45 seconds. Device names are entered by the client after scanning, not supplied to a daemon-side `pair --name` command. Many devices can pair over time by consuming successive rolling QR tokens. Pairing must remain safe: never persist raw pairing tokens, consume each pairing token after the first successful `auth.proof`, immediately print the next QR after consumption, and reject unauthenticated filesystem/session endpoints.

Use the existing boring monorepo structure and existing protocol mirroring pattern. Keep the backend as a single Go binary named `agenticRemote`. Keep the Flutter client web-capable; do not use FFI-only crypto. Dart verifier derivation must use `cryptography: ^2.9.0` with `Argon2id(parallelism: 1, memory: 64 * 1024, iterations: 3, hashLength: 32)`, matching the backend Argon2id parameters.
## Approach

### 1. Wire `serve` as the single pairing entry point

1. Update `backend/cmd/agenticRemote/main.go` so `serve --config <path>` performs the real daemon startup instead of printing the stub:
   - Load and validate config.
   - Ensure TLS certificate/key and compute the fingerprint.
   - Load pairing and session-token stores.
   - Construct auth service, session manager/store, notifier, and HTTP/WSS handler using existing packages.
   - Start HTTPS/WSS serving on `Config.ListenAddr` with the existing TLS material.
   - Start a concurrent pairing QR rotation loop before blocking on the server.
2. Cut daemon-side device naming from the CLI flow:
   - Backend command list after this change is `serve --config <path>`, `config init --path <path>`, and `version`.
   - Remove the `pair` subcommand from usage/help and README/docs examples; `agenticRemote pair ...` should be an unknown command or a direct error that says pairing is started by `serve`, with no `--name` flag parsed.
   - Drop every user-facing `--name` pairing instruction; the client submits `clientName` during Auth-v2 after scanning or pasting the QR payload.
3. QR generation failure must not stop serving if TLS/auth store initialization succeeded. Log the failure, retry on the next rotation interval, and keep HTTP/WSS accepting connections.

### 2. Add rolling single-use pairing records

1. Update `backend/internal/security/pairing.go` around `PairingStore.Create`, `PairingPayload`, and `PairingRecord`:
   - `Create(endpoint, fingerprint, now)` no longer accepts `clientName`.
   - Generate a fresh `pairingId`, raw token, salt, verifier, and payload.
   - Persist only `pairingId`, base64url salt, base64url verifier, expiry, and any post-auth client name; never persist raw token.
   - Keep `PairingPayload` schema as `v`, `endpoint`, `fingerprint`, `pairingId`, `token`, `expiresAt`; no device name belongs in the QR.
2. Rotation contract:
   - Print a new QR immediately when `serve` starts.
   - Roll the visible QR every 45 seconds.
   - Set token expiry to 2 minutes after creation. This is intentionally longer than the 45-second display cadence so a scan just before rotation can still complete after the client name is typed.
   - Cleanup expired unused records on every rotation and auth attempt.
   - A successful `auth.proof` consumes that `pairingId` immediately; the same visible token cannot pair a second device.
   - After consumption, signal the QR loop to print the next QR immediately instead of waiting for the next 45-second tick.
3. Add terminal QR rendering with `github.com/skip2/go-qrcode` using `QRCode.ToSmallString(false)` or `ToString(false)` plus the raw JSON payload line for copy/paste/debug. Keep output readable in ordinary terminals.

### 3. Move device name into the authenticated client flow

1. Update protocol contracts in `backend/internal/protocol/protocol.go` and `client/lib/src/protocol/messages.dart`:
   - Add `clientName` to `auth.hello` or `auth.proof`; choose `auth.hello` so the server can validate and bind the pending challenge to the proposed name.
   - Mirror field names exactly as lowerCamelCase JSON.
2. Update `backend/internal/security/auth.go` around `HelloMessage`, `AuthService.Begin`, `AuthService.Complete`, and `ClientProof`:
   - Trim `clientName`.
   - Reject empty names.
   - Cap names at 64 Unicode code points.
   - Store the accepted name in the pending challenge.
   - On successful proof, persist it in `SessionTokenRecord.ClientName` and the consumed pairing record metadata if retained for audit.
   - Consume/delete the pairing record after successful proof.
3. Keep failure responses intentionally generic: expired, unknown, consumed, wrong proof, and invalid name all report `authentication failed` at the auth boundary, with only server logs carrying detail.

### 4. Fix unauthenticated WebSocket bootstrap without opening session APIs

1. Update `backend/internal/server/server.go` around `Handler` and `handleSessionWS`:
   - Allow unauthenticated WebSocket upgrade only for `/v1/ws/sessions/bootstrap`.
   - On bootstrap, accept only auth frames until `auth.ok` succeeds.
   - Reject any non-auth frame before authentication.
   - After authentication, allow session/control frames according to the existing authenticated WebSocket path.
2. Keep all REST filesystem/session endpoints behind `Authorization: Bearer <sessionToken>`.
3. Keep non-bootstrap session WebSocket endpoints requiring a valid bearer token in the request headers.

### 5. Make the Flutter proof path match the backend on web, mobile, and desktop

1. Update `client/pubspec.yaml` to add `cryptography: ^2.9.0`; do not use `argon2_ffi` or another FFI-only plugin because the client targets Chrome/web.
2. Update `client/lib/src/services/agentic_remote_api.dart` around `_authenticate`, `_clientProof`, and `_argonLike`:
   - Replace the SHA-256 placeholder `_argonLike` with `Argon2id(parallelism: 1, memory: 64 * 1024, iterations: 3, hashLength: 32).deriveKey(secretKey: SecretKey(utf8.encode(token)), nonce: saltBytes)`.
   - Preserve the existing HMAC-SHA256 proof shape after deriving the verifier bytes.
   - Send `clientName` in the auth frame selected in step 3.
   - Keep browser TLS fingerprint limitations surfaced through existing diagnostics/manual trust behavior.

### 6. Add client QR scan and device-name UX with existing UI patterns

1. Reuse the existing `mobile_scanner` dependency; do not add another scanner package.
2. Update connection UI/state around `client/lib/src/state/app_state.dart`, `client/lib/src/features/dashboard/session_dashboard.dart`, and the connection feature files:
   - Let the user scan a daemon QR payload.
   - After scan, ask for a device name before auth.
   - Validate locally with the same trim/non-empty/64-code-point rule before sending.
   - Show the existing connection diagnostics sequence, including TLS/fingerprint and Auth-v2 steps.
3. Keep the UI simple and web-capable. If camera access is unavailable in a browser, provide a paste-QR-payload fallback using the raw JSON line printed by the daemon.

### 7. Update docs and focused behavior tests

1. Update `README.md` quickstart:
   - Build backend.
   - Run `backend/bin/agenticRemote serve --config examples/config.local.json`.
   - State that serve prints a QR immediately and rolls it every 45 seconds.
   - Remove `agenticRemote pair --config ... --name ...` instructions.
2. Update `docs/protocol.md`:
   - Document rolling single-use QR payloads.
   - Document 45-second display cadence, 2-minute expiry, and immediate replacement after successful pairing.
   - Document client-submitted `clientName` in Auth-v2.
   - Document that bootstrap WebSocket is unauthenticated only until auth succeeds; filesystem/session APIs still require bearer auth.
3. Update tests that defend observable behavior:
   - Backend security/auth tests: raw token absent, valid proof with client name succeeds, empty/too-long names fail, successful proof consumes pairing, second proof on same pairing fails, expired pairing fails.
   - Backend pairing tests: rotation/cleanup semantics and expiry window are deterministic with injected time.
   - Backend server tests: bootstrap accepts auth frames without bearer token but rejects non-auth frames before auth; protected REST endpoints still return `401` without bearer token.
   - CLI tests or command-level smoke coverage: `serve` wiring produces a QR-capable daemon path; old `pair --name` UX is not advertised.
   - Client tests: `PairingPayload` still parses QR schema, Auth-v2 sends `clientName`, Dart Argon2id verifier matches a backend test vector, QR/paste connection UI validates device names.

### 8. Final verification

1. Format only after implementation works:
   - `gofmt -w ./internal ./cmd` from `backend/`.
   - `dart format lib test` from `client/`.
2. Run from repository root:
   - `make test`
   - `make lint`
   - `make backend-build`
   - `make client-build-web`
3. Behavior smoke:
   - Start `backend/bin/agenticRemote serve --config examples/config.local.json`.
   - Observe an initial terminal QR and raw JSON payload.
   - Wait more than 45 seconds and confirm the next printed QR/payload has a different `pairingId`/`token`.
   - Complete one auth flow with a client-submitted name and confirm a session token is issued.
   - Reusing the consumed `pairingId` must fail.
   - `curl -k https://127.0.0.1:8765/healthz` returns OK.
   - An unauthenticated REST call to `/v1/sessions` returns `401`.
## Critical files & anchors

- `backend/cmd/agenticRemote/main.go` — `run`, `serve`, and CLI usage; wire daemon startup and remove daemon-side `--name` pairing UX.
- `backend/internal/security/pairing.go` — `PairingStore.Create`, `PairingPayload`, `PairingRecord`; rolling single-use QR records, no raw token persistence, expiry/cleanup.
- `backend/internal/security/auth.go` — `HelloMessage`, `AuthService.Begin`, `AuthService.Complete`, `ClientProof`; client-submitted name validation, proof verification, pairing consumption, session token issuance.
- `backend/internal/server/server.go` — `Handler`, `handleSessionWS`; unauthenticated bootstrap auth only, authenticated REST/session enforcement.
- `backend/internal/protocol/protocol.go` — Go wire types mirrored in Dart; add `clientName` consistently.
- `client/lib/src/protocol/messages.dart` — Dart protocol mirror and QR payload parsing.
- `client/lib/src/services/agentic_remote_api.dart` — `_authenticate`, `_clientProof`, `_argonLike`; use `cryptography` Argon2id, send client name.
- `client/lib/src/state/app_state.dart` and connection/dashboard feature files — QR scan/paste flow and device-name UI.
- `README.md` and `docs/protocol.md` — remove old `pair --name` instructions and document rolling QR pairing.
## Verification

Run from repository root unless stated otherwise.

1. Backend unit proof: `make backend-test`. Expected: security, pairing, server auth bootstrap, CLI behavior, filesystem/session protection, detector, and scrollback tests pass.
2. Client unit/widget proof: `make client-test`. Expected: QR parsing, client-name validation, Argon2id verifier test vector, Auth-v2 frame shape, scanner/paste flow, diagnostics, shortcut keyboard, and dashboard tests pass.
3. Full test proof: `make test`. Expected: backend and client suites pass together.
4. Full lint proof: `make lint`. Expected: `go vet ./...` and `dart analyze` pass.
5. Backend build proof: `make backend-build`. Expected: `backend/bin/agenticRemote` exists and `backend/bin/agenticRemote version` prints `agenticRemote dev`.
6. Client web proof: `make client-build-web`. Expected: Flutter builds the Chrome/web target, proving the pairing crypto path did not depend on FFI-only plugins.
7. Rolling QR smoke proof:
   - Start `backend/bin/agenticRemote serve --config examples/config.local.json`.
   - Expected: HTTPS/WSS server starts and prints a terminal QR plus raw JSON payload immediately.
   - Wait more than 45 seconds. Expected: a new QR/raw payload is printed with a different `pairingId` and `token`.
   - Complete Auth-v2 with a client-submitted device name. Expected: `auth.ok` returns a session token, the session token record contains the accepted client name, and raw QR token material is absent from persisted JSON.
   - Retry the same consumed `pairingId`. Expected: authentication fails.
   - `curl -k https://127.0.0.1:8765/healthz` returns OK, while unauthenticated `/v1/sessions` returns `401`.

If Flutter or browser tooling is unavailable, record the exact binary/SDK error after backend verification; do not claim client tests/build passed.
## Assumptions & contingencies

- The current repository state is the baseline; do not recreate greenfield files or overwrite unrelated user changes.
- Git is not initialized, so branch/commit/merge workflow is skipped unless a git repo appears before execution begins.
- Product platform is adaptive because the Flutter client targets web, mobile, and desktop. The pairing proof path must work on Chrome/web; `cryptography` is acceptable because pub.dev documents `cryptography 2.9.0` as supporting Android, iOS, Linux, macOS, web, and Windows, and its Argon2id API is pure Dart-capable.
- Keep the QR payload small and explicit JSON. Do not add discovery services, accounts, cloud relays, or a pairing database beyond the existing local stores.
- The 2-minute token expiry is a deliberate grace window over the 45-second display cadence. It protects scans just before rotation without allowing reused pairings after success because successful proof consumes the pairing immediately.
- Many devices pair over time by scanning successive QR codes. One visible QR can authenticate only one device; the daemon immediately emits the next QR after successful consumption.
- If terminal QR rendering fails in a limited terminal, the raw JSON payload line remains the fallback for manual paste/scanner tests.
- Push notifications, PTY behavior, filesystem safety, and dashboard/terminal UX outside the pairing path should remain unchanged except where auth wiring requires it.
