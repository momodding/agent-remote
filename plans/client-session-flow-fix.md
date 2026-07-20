# client-session-flow-fix
<!-- source-branch: main -->
<!-- work-branch: omp/client-session-flow-fix -->

## Findings

- Client Auth-v2 is a stub: `AgenticRemoteApi._authenticate` sets `bearerToken = 'dev-no-auth'` and never opens `/v1/ws/sessions/bootstrap`.
- Client REST calls do not send `Authorization: Bearer <sessionToken>`.
- Backend does not enforce auth on `/v1/sessions` and starts session WebSockets as already authenticated (`authed := true`). This contradicts `docs/protocol.md` and masks the client auth stub.
- Browser REST requests need CORS for `Authorization`/JSON requests; `server.Handler` has no CORS handling.
- Browser WebSockets cannot send custom `Authorization` headers through `web_socket_channel`; use one initial `auth.token` frame on non-bootstrap session WSS instead of query tokens.
- Dashboard creates a session but only refreshes the list; it does not navigate to `TerminalScreen`.
- Session cards are tappable but have no visible Open button; Close button is a no-op.
- `TerminalScreen.dispose` only cancels the output subscription; it leaves the session WebSocket attached. Closing the terminal screen should disconnect/minimize only.
- `session.Manager.Close` marks a session exited but keeps it in `List`; user expects explicit connection close to delete/remove the session. App minimize/kill should not call this path.

## Plan

1. Implement real client Auth-v2 in `client/lib/src/services/agentic_remote_api.dart`.
   - Add a minimal Dart `clientProof(...)` using installed `cryptography` (`Argon2id(parallelism: 1, memory: 64 * 1024, iterations: 3, hashLength: 32)`) plus `Hmac.sha256()`.
   - Generate raw-url-base64 32-byte client nonces with `Random.secure()`.
   - `_authenticate` opens `/v1/ws/sessions/bootstrap`, sends `auth.hello`, answers `auth.challenge`, stores `auth.ok.sessionToken`, then closes bootstrap WSS.
   - Keep existing TLS/fingerprint transport path; no new dependency.

2. Attach bearer auth to client control calls.
   - Add one private `_headers({bool json = false})` helper.
   - Use it in `fetchSessions`, `createSession`, and new `closeSession`.
   - Add `disconnectSession()` that only closes the active WSS and clears the channel.
   - Use an initial `auth.token` frame on session WSS so native and web share one path.

3. Fix backend auth and browser access in `backend/internal/server/server.go`.
   - Wrap handlers with a small CORS middleware: echo `Access-Control-Allow-Origin` for request origins, allow `Authorization, Content-Type`, handle `OPTIONS` with 204. Bearer token auth means no cookies needed.
   - Protect `/v1/sessions` with `withAuth`.
   - Add `/v1/sessions/{id}/close` route.
   - Split session WSS behavior:
     - `/v1/ws/sessions/bootstrap`: only accepts `auth.hello`/`auth.proof`; returns `auth.ok`.
     - `/v1/ws/sessions/{id}`: starts unauthenticated, accepts exactly `auth.token`, verifies it, then subscribes and accepts PTY frames.
   - Do not subscribe before auth.

4. Make explicit close remove sessions.
   - Extend `SessionAPI`/manager behavior only as needed: `Close(id)` deletes the session from the in-memory map, emits close state before removal if cheap, persists metadata, and removes the scrollback file if present.
   - Keep app minimize/kill safe by not wiring lifecycle close events.

5. Fix dashboard/terminal UI flow.
   - In `SessionDashboard`, when New session succeeds, navigate directly to `TerminalScreen` for the returned session.
   - Add visible `Open` button on `_SessionCard`; keep card tap as a secondary shortcut.
   - Wire `Close` button to `api.closeSession(session.id)` then refresh/listen through existing `fetchSessions` result.
   - Pass callbacks instead of letting `_SessionCard` own API side effects.
   - In `TerminalScreen.dispose`, call `api.disconnectSession()` after canceling subscription.

6. Add focused regressions.
   - Client API tests:
     - Auth-v2 `clientProof` matches a fixed server-generated vector.
     - REST calls include `Authorization: Bearer <token>`.
     - `closeSession` posts `/v1/sessions/{id}/close` and refreshes sessions.
   - Dashboard tests:
     - New session opens `TerminalScreen`.
     - Open button opens `TerminalScreen`.
     - Close button calls API close and removes/refreshes the card.
     - Popping terminal calls `disconnectSession` but not `closeSession`.
   - Backend tests:
     - `/v1/sessions` rejects missing bearer and accepts a valid bearer.
     - Bootstrap rejects PTY frames before auth.
     - Bootstrap Auth-v2 returns a usable bearer token.
     - Session WSS rejects PTY before `auth.token` and accepts it after token auth.
     - Close endpoint removes the session from `List`.
     - CORS preflight allows `Authorization`.

## Verification

- `make backend-test`
- `cd client && flutter test test/agentic_remote_api_test.dart test/session_dashboard_test.dart`

## Ponytail cuts

- No saved client credentials yet; connect from QR/paste each app start. Add persistence only after reconnect UX is requested.
- No lifecycle observer; doing nothing on app minimize/kill already preserves sessions.
- No custom router/state package; direct `Navigator.push` is enough.
