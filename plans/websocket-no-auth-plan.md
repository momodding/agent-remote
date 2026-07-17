<!-- source-branch: main -->
<!-- work-branch: omp/websocket-no-auth-plan -->
## Context

The daemon returns HTTP 403 during `GET /v1/ws/sessions/bootstrap`; the code path confirms that `github.com/coder/websocket.Accept` rejects cross-origin websocket handshakes when `AcceptOptions.InsecureSkipVerify` is false. The requested end state is a development-first connection path: no pairing proof, no bearer-token gate for session management, and no websocket origin/certificate verification inside the app-controlled transport, so the client can connect and manage server sessions first.

## Approach

### Backend: make session management unauthenticated

1. In `backend/internal/server/server.go`, change `Handler` so `/v1/sessions` is registered directly as `s.handleSessions` instead of `s.withAuth(s.handleSessions)`. Leave filesystem, git, and notify routes behind `withAuth`; the request only needs connection and session management.
2. In `handleSessionWS`, delete the non-bootstrap bearer check:
   - Remove `if !bootstrap && !s.authorized(r) { ... }` entirely.
   - Replace `websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: false})` with `websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})`. This is the root cause for the observed 403 from `/v1/ws/sessions/bootstrap`; coder/websocket docs in `~/go/pkg/mod/github.com/coder/websocket@v1.8.15/accept.go` state false performs origin verification and writes 403 on origin failure.
   - Set `authed := true` immediately after `ctx := r.Context()` so bootstrap accepts `pty.input`/`pty.resize` frames without first sending `auth.hello`/`auth.proof`.
   - Keep the existing `if authed { s.sessions.Subscribe(...) }` block. Because `sessionID == "bootstrap"` has no real session, `Subscribe("bootstrap", ...)` returns an error that is already ignored; this is acceptable for the bootstrap control socket.
   - Leave the `auth.hello` and `auth.proof` switch cases in place for now. They become unused by the client but keeping them avoids a larger protocol cleanup while the goal is connection success.
3. Replace backend tests in `backend/internal/server/server_test.go` that assert the old auth behavior:
   - Change `TestProtectedSessionsRequireBearer` into `TestSessionsListDoesNotRequireBearer`: issue `GET /v1/sessions` with no `Authorization` header and assert HTTP 200.
   - Replace `TestBootstrapAllowsAuthThenRejectsNonAuthBeforeSuccess` with `TestBootstrapAcceptsSessionFramesWithoutAuth`: dial `ts.URL + "/v1/ws/sessions/bootstrap"`, send `{"type":"pty.resize","sessionId":"missing","cols":80,"rows":24}`, then close the websocket. The pass condition is that `websocket.Dial` succeeds and `wsWriteJSON` returns nil; no response is expected because `Resize("bootstrap", ...)` errors internally and the handler currently ignores session operation errors.
   - Delete pairing setup, `security.ClientProof`, and auth challenge assertions from that test; they are dead for the new dev-first flow.
   - Keep `newBootstrapServer` unless removing pairings makes the test helper simpler; do not add new dependencies.

### Client: skip TLS fingerprint and Auth-v2 during connect

1. In `client/lib/src/services/agentic_remote_api.dart`, simplify `connectFromPayload`:
   - Still parse `PairingPayload.fromJson(...)` so existing QR payloads keep working and endpoint extraction remains unchanged.
   - Set `_allowBadCertificates = true` unconditionally.
   - Delete the call to `_validateEndpointTrust(...)` and delete the Auth-v2 diagnostics line.
   - Call a rewritten `_authenticate(clientName.trim())` that only opens the websocket and assigns a dummy non-empty bearer token.
   - Keep the final diagnostic literal `Session Established`.
2. Rewrite `_authenticate(String clientName)` in the same file to the exact behavior below:
   - Build the same endpoint with `agenticEndpointUri(pairing!.endpoint, '/v1/ws/sessions/bootstrap', scheme: agenticWebSocketScheme(pairing!.endpoint))`.
   - Call `connectWebSocket(endpoint, trustedFingerprint: null, formatFingerprint: _formatFingerprint, allowBadCertificates: true)`.
   - Set `bearerToken = 'dev-no-auth'`.
   - Do not send `auth.hello`, do not read `auth.challenge`, do not compute `_clientProof`, and do not send/read `auth.proof`/`auth.ok`.
   - Add `clientName;` as a no-op statement only if Dart warns about the parameter being unused; otherwise omit it. Do not introduce a new auth result type.
3. Keep `_validateEndpointTrust`, `_clientProof`, `_argonLike`, and imports until `dart analyze` identifies dead-code or unused-import diagnostics. If diagnostics show they are unused, delete the private methods and remove only imports made unused by those deletions (`crypto`, `cryptography`, or `typed_data` as applicable). Do not rewrite `PairingPayload` or QR parsing.
4. In `client/lib/src/services/agentic_remote_transport_io.dart`, simplify both transport helpers for local/dev success:
   - `createHttpClient(...)` should always return `IOClient(_insecureHttpClient())`, ignoring `trustedFingerprint` and `allowBadCertificates`.
   - `connectWebSocket(...)` should always return `IOWebSocketChannel.connect(uri, customClient: _insecureHttpClient())`, ignoring `trustedFingerprint` and `allowBadCertificates`.
   - Keep `_insecureHttpClient` and its existing `badCertificateCallback`; delete `_pinnedHttpClient` if it becomes unused.
5. Leave `client/lib/src/services/agentic_remote_transport_web.dart` unchanged. Browser TLS policy cannot be bypassed from Dart; the plan only removes app-level verification.

### Client: actually manage server sessions after connect

1. In `client/lib/src/services/agentic_remote_api.dart`, add the minimum session-management methods because existing client code only has `fetchSessions`, `sendInput`, and `resizeSession`:
   - `Future<SessionSummary> createSession({String name = '', String command = '', String cwd = ''}) async { ... }`
   - POST to `agenticEndpointUri(pairing!.endpoint, '/v1/sessions')` with JSON body `{'name': name, 'command': command, 'args': <String>[], 'cwd': cwd, 'cols': 80, 'rows': 24}` and header `Content-Type: application/json`. Omit `Authorization`; backend no longer requires it for `/v1/sessions`.
   - Decode the response as `SessionSummary`, call `await fetchSessions()` after successful create, and return the created summary.
   - In `fetchSessions`, remove the `Authorization` header and add a status check: if `response.statusCode != 200`, throw `StateError('fetch sessions failed: ${response.statusCode}')`. Then decode the existing list shape.
2. In `client/lib/src/state/app_state.dart`, after `api.connectFromPayload(...)` completes, immediately call `sessions.value = await api.fetchSessions();` so a successful websocket connection populates server sessions in the dashboard.
3. In `client/lib/src/features/dashboard/session_dashboard.dart`, add one small management control above the search box:
   - Add a `ShadButton` with text `New session` after the pairing panel and before the search input.
   - On press, call `final session = await widget.state.api.createSession(name: 'remote session');` then set `widget.state.sessions.value = await widget.state.api.fetchSessions();`.
   - Keep errors simple: catch `Object error` and set `connectionError = error.toString()` using the existing error display. No dialog, no form, no new screen.
   - Do not wire terminal navigation in this pass; current code has `TerminalScreen` but no navigation entry point. Creating/listing sessions satisfies “manage session on server” with the smallest working diff.

## Critical files & anchors

- `backend/internal/server/server.go` — `Handler` lines 55-68 and `handleSessionWS` lines 257-331 contain the REST auth gate, websocket origin verification, and bootstrap auth gate causing the 403/connection failure.
- `backend/internal/server/server_test.go` — tests lines 27-105 currently encode bearer-required and bootstrap-auth-required behavior; update them to the new no-auth session behavior.
- `client/lib/src/services/agentic_remote_api.dart` — `connectFromPayload`, `_authenticate`, and `fetchSessions` are the client connection/auth/session REST path.
- `client/lib/src/services/agentic_remote_transport_io.dart` — `createHttpClient` and `connectWebSocket` are the app-level TLS/fingerprint verification path on mobile/desktop.
- `client/lib/src/features/dashboard/session_dashboard.dart` — the dashboard currently connects but has no create-session control; add the smallest button here.

## Verification

1. Backend proof from repo root: run `make backend-test`. Required new observable behavior: `TestSessionsListDoesNotRequireBearer` returns HTTP 200 for unauthenticated `GET /v1/sessions`, and `TestBootstrapAcceptsSessionFramesWithoutAuth` successfully dials `/v1/ws/sessions/bootstrap` and writes a session frame without auth frames.
2. Client proof from repo root: run `make client-test`. Update or add Flutter tests so they cover:
   - `agenticEndpointUri` still builds `wss://host.example/v1/ws/sessions/bootstrap` and `ws://host.example/v1/ws/sessions/bootstrap`.
   - `SessionDashboard` renders the `New session` button.
   - If an existing test harness can inject a fake `AgenticRemoteApi`, verify `AppState.connectFromPayload` refreshes `sessions.value` after connect; if not, do not build a fake framework just for this.
3. End-to-end smoke proof after tests: start the daemon with `make run-daemon`, run the client with `make run-client`, paste/scan a pairing payload, press `Connect`, observe `Session Established`, press `New session`, and confirm the new `remote session` card appears. If browser/web client is used with self-signed HTTPS and the browser blocks TLS before Dart runs, switch to the Flutter mobile/desktop target or an HTTP endpoint; do not add browser TLS bypass code because browsers do not expose it.

## Assumptions & contingencies

- Security is deliberately disabled only for session connection and management because the request prioritizes websocket success. Filesystem, git, and notify endpoints stay authenticated unless a later request asks to remove all daemon security.
- The observed 403 is treated as websocket origin verification, not bearer auth, because the bootstrap path skips `authorized(r)` but coder/websocket writes 403 when `InsecureSkipVerify` is false and origin verification fails.
- If `make client-test` or `dart analyze` reports unused private auth helpers/imports after `_authenticate` stops using them, delete only those unused helpers/imports. Do not remove backend `security.AuthService` wiring or pairing QR generation in this change.
- If the `New session` button creates the session but the dashboard does not refresh due to duplicate fetch timing, set `widget.state.sessions.value = [...widget.state.sessions.value, session];` instead of the second fetch; prefer the fetch first because it reflects server state.
