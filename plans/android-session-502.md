<!-- source-branch: main -->
<!-- work-branch: omp/android-session-502 -->
## Context

Android client shows `fetch session failed:502` after connecting to a daemon that already has an active PTY session. The user expects the phone to cover the common “daemon already has sessions” flow: connect to the daemon, fetch active sessions, and show/use them from the Sessions tab instead of surfacing a raw 502. Current code confirms the failing text is thrown only by `AgenticRemoteApi.fetchSessions()` in `client/lib/src/services/agentic_remote_api.dart` when `GET /v1/sessions` returns any non-200; `AppState.connectFromPayload()` immediately calls that fetch after WebSocket bootstrap, so one transient/proxy 502 blocks the whole connect UI.

Keep the fix client-side and minimal. Backend `backend/internal/server/server.go` already returns `200` for `GET /v1/sessions`, and `backend/internal/session/manager.go` already lists active sessions from the in-memory/restored manager, so there is no server-side active-session discovery to invent.

## Approach

1. Add a tiny HTTP client injection point for `AgenticRemoteApi` tests, not a new abstraction layer.
   - Edit `client/lib/src/services/agentic_remote_api.dart` constructor area around `class AgenticRemoteApi`.
   - Add an unnamed constructor with exact signature:
     ```dart
     AgenticRemoteApi({http.Client? client}) : client = client ?? http.Client();
     ```
   - Change the existing field initializer `http.Client client = http.Client();` to `http.Client client;`.
   - Keep the existing assignment in `connectFromPayload()` that replaces `client` with `createHttpClient(...)`; tests can set `pairing` and inject a `MockClient` without going through TLS/WebSocket.
   - Do not introduce a repository/service interface; `package:http/testing.dart` is already available through the existing `http` dependency.

2. Make `fetchSessions()` cover a transient 502 and preserve last known sessions if a later 502 repeats.
   - Edit only `AgenticRemoteApi.fetchSessions()` in `client/lib/src/services/agentic_remote_api.dart`.
   - Add a private cache field to the class:
     ```dart
     List<SessionSummary> _lastSessions = const <SessionSummary>[];
     ```
   - In `fetchSessions()`, call `GET /v1/sessions` as today, but if the response status is exactly `502`, immediately retry the same `GET /v1/sessions` once before deciding failure. Do not retry other status codes; the reported bug is 502 and auth/bad-request failures should stay visible.
   - On a `200`, parse exactly as today, then assign `_lastSessions = items;`, emit `sessions.add(items);`, and return `items`.
   - After the retry, if the final status is `502` and `_lastSessions.isNotEmpty`, add diagnostic text exactly:
     ```dart
     diagnostics.add('Session fetch failed (502); showing last known sessions');
     ```
     then emit `sessions.add(_lastSessions);` and return `_lastSessions`.
   - On a non-200 with no cached sessions, or any non-502 failure, keep the current failure contract and exact exception text pattern `StateError('fetch sessions failed: ${response.statusCode}')`; this avoids pretending an unknown daemon has sessions.
   - Do not create a fake session from the WebSocket or QR payload. The existing session schema requires `id`, `name`, `command`, `cwd`, `state`, timestamps, and preview; inventing those would create a dead terminal card.

3. Add two narrow regression tests in `client/test/agentic_remote_api_test.dart`.
   - Import `dart:convert` and `package:http/testing.dart` as `http_testing`; keep existing imports.
   - Test 1 name: `fetchSessions retries one gateway error and returns active sessions`.
     - Use the existing `payload` fixture by constructing `final api = AgenticRemoteApi(client: http_testing.MockClient(...));` and then setting `api.pairing = payload;`.
     - Mock two `GET /v1/sessions` calls: first returns `502` with body `bad gateway`; second returns `200` with a one-item JSON array containing a real `SessionSummary` shape.
     - Expected behavior: `await api.fetchSessions()` returns a list with one item whose `id` is `active-1`; the mock call counter is `2`.
   - Test 2 name: `fetchSessions reuses cached sessions after repeated gateway errors`.
     - Use a fresh `AgenticRemoteApi(client: http_testing.MockClient(...))` with `api.pairing = payload`.
     - Mock three `GET /v1/sessions` calls: first returns `200` with the same `active-1` JSON array; second returns `502`; third returns `502`.
     - Before the second `fetchSessions()` call, subscribe with `final diagnostic = api.diagnostics.stream.first;` so the broadcast event is not missed.
     - Expected behavior: first fetch returns `active-1`; second fetch returns cached `active-1` instead of throwing; `await diagnostic` equals `Session fetch failed (502); showing last known sessions`; the mock call counter is `3`.
   - Do not add UI tests for this; the behavior lives in the shared API method and both `AppState.connectFromPayload()` and the New session refresh path already call it.

4. Optional executor sanity check before editing: grep callers with this exact command-equivalent search, which currently returns only `client/lib/src/services/agentic_remote_api.dart`, `client/lib/src/state/app_state.dart`, and `client/lib/src/features/dashboard/session_dashboard.dart`:
   ```text
   fetchSessions\(
   ```
   If new callers appear, no code change is needed unless they bypass `AgenticRemoteApi.fetchSessions()`; this plan fixes the shared method.

## Critical files & anchors

- `client/lib/src/services/agentic_remote_api.dart` — `AgenticRemoteApi` fields and `fetchSessions()`; source of the displayed `fetch sessions failed: 502` exception.
- `client/lib/src/state/app_state.dart` — `connectFromPayload()` calls `api.fetchSessions()` immediately after connecting, so fetch failure blocks the connect flow.
- `client/lib/src/features/dashboard/session_dashboard.dart` — New session button also refreshes via `api.fetchSessions()`, so the shared API fallback covers both connect and manual refresh.
- `client/test/agentic_remote_api_test.dart` — existing API helper tests; add the regression test here with `http/testing.dart`.
- `backend/internal/server/server.go` — `handleSessions()` currently returns `200` for `GET /v1/sessions`; use as confirmation that 502 is a gateway/proxy/client-observed failure, not intentional backend behavior.

## Verification

1. From `client/`, run the targeted Flutter test file:
   ```sh
   flutter test test/agentic_remote_api_test.dart
   ```
   Expected: all tests in that file pass, including `fetchSessions retries one gateway error and returns active sessions` and `fetchSessions reuses cached sessions after repeated gateway errors`.

2. From the repo root, run the client suite to catch API constructor fallout:
   ```sh
   make client-test
   ```
   Expected: Flutter unit/widget tests pass.

3. Manual Android/daemon smoke path after building the app: start the daemon with an existing active session, connect Android from the QR/payload, and use the same reverse proxy/tunnel that produced the bug to make `/v1/sessions` return one transient 502 before a 200. Expected observable result: the Sessions tab shows the active session card and does not show `fetch sessions failed: 502`. If a later refresh returns repeated 502s after at least one successful session fetch, the Sessions tab keeps showing the last fetched active session card and diagnostics includes `Session fetch failed (502); showing last known sessions`.

## Assumptions & contingencies

- Assumption: the reported 502 is gateway/proxy behavior, not intentional backend behavior. This plan retries one 502 for the first-fetch case and caches only after a real successful session list; if every first-fetch attempt returns 502, keep the current error so setup/network misconfiguration stays visible.
- Assumption: “cover this scenario” means keep usable active-session UI when refresh has a transient/repeated gateway failure, not synthesize sessions from daemon process state. If execution finds a backend path that itself returns 502 for `GET /v1/sessions`, fix that backend root cause instead and keep the client retry/cache behavior only if the new regression tests still represent a real proxy failure.
- The user diagram names `mobilecli daemon (Rust)` and port `9847`, but this repository is `agenticRemote` with a Go daemon defaulting to `127.0.0.1:8765` in `backend/internal/config/config.go`. Do not rename binaries, change ports, or introduce Rust/mobilecli compatibility in this plan; that is a separate product-alignment task.
