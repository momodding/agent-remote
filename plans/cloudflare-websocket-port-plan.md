<!-- omp-work-branch: omp/cloudflare-websocket-port-plan -->
<!-- omp-source-branch: main -->
## Context

The Flutter client is attempting to open `https://agent-mac.paperplain.tech:0/v1/ws/sessions/bootstrap`, which Cloudflare answers with HTTP 400 because `:0` is not a valid public WebSocket endpoint port. The requested outcome is that a client can connect to a machine server exposed through a Cloudflare Zero Trust tunnel even when the pairing endpoint contains `:0`. Implement the smallest client-side cutover: treat explicit endpoint port `0` as “use the scheme default port” in the shared URI builder, then use that normalized URI for TLS trust probing, WebSocket bootstrap, and REST calls.

## Approach

1. Replace the body of `agenticEndpointUri(String endpoint, String path, {String? scheme})` in `client/lib/src/services/agentic_remote_api.dart` with a `Uri(...)` constructor that omits explicit port `0`.
   - Current behavior read: lines 15-22 parse `endpoint` and call `base.replace(scheme: ..., path: path, query: null, fragment: null)`, which preserves `:0`.
   - A read-only Dart check in this session showed `Uri.replace(port: null)` also preserves the old `:0`, so do not use `replace(port: null)` for this fix.
   - Exact final helper shape:
     ```dart
     @visibleForTesting
     Uri agenticEndpointUri(String endpoint, String path, {String? scheme}) {
       final base = Uri.parse(endpoint);
       return Uri(
         scheme: scheme ?? base.scheme,
         userInfo: base.userInfo,
         host: base.host,
         port: base.hasPort && base.port != 0 ? base.port : null,
         path: path,
       );
     }
     ```
   - This reuses Dart `Uri`; no new helper, dependency, or transport-layer special case.
   - Existing non-zero explicit ports stay unchanged: `https://host.example:8765` still yields `https://host.example:8765/...`.
   - Endpoints without an explicit port stay unchanged: `https://host.example` still yields `https://host.example/...`.
   - Query and fragment stay intentionally dropped, matching the current helper behavior at lines 20-21.
   - Edge handling: malformed endpoint strings continue to throw from `Uri.parse` exactly as before; do not add validation here.

2. Change `_validateEndpointTrust({required bool webTrustConfirmed})` in `client/lib/src/services/agentic_remote_api.dart` to use the normalized URI.
   - Current behavior read: line 75 uses `final uri = Uri.parse(pairing!.endpoint);`, so native trust probing can still try port `0` before authentication.
   - Concrete edit: replace that line with `final uri = agenticEndpointUri(pairing!.endpoint, '');`.
   - This routes native `platformTrustsEndpoint(uri)` and `peerCertificateDer(uri)` through the same zero-port normalization as WebSocket and REST without changing the transport implementations.

3. Leave `agenticWebSocketScheme(String endpoint)` unchanged in `client/lib/src/services/agentic_remote_api.dart`.
   - Current behavior read: lines 26-27 map `http` to `ws` and everything else to `wss`.
   - It is not the source of `:0`; changing it would add scope without fixing the bad URI.

4. Leave `client/lib/src/services/agentic_remote_transport_io.dart` and `client/lib/src/services/agentic_remote_transport_web.dart` unchanged.
   - Current IO behavior read: `_endpointPort(Uri uri)` at lines 82-90 maps missing `https`/`wss` ports to `443` and `http`/`ws` to `80`.
   - Current web behavior read: `connectWebSocket` at `client/lib/src/services/agentic_remote_transport_web.dart` line 21 passes the URI directly to `WebSocketChannel.connect`.
   - Fixing transport would miss REST `fetchSessions()` and would duplicate the same policy in two platform files.

5. Add one unit test in `client/test/agentic_remote_api_test.dart` beside the existing `agenticEndpointUri` tests.
   - Exact test name: `agenticEndpointUri drops explicit zero port`.
   - Exact assertions:
     ```dart
     test('agenticEndpointUri drops explicit zero port', () {
       expect(
         agenticEndpointUri(
           'https://host.example:0',
           '/v1/ws/sessions/bootstrap',
           scheme: 'wss',
         ).toString(),
         'wss://host.example/v1/ws/sessions/bootstrap',
       );
       expect(
         agenticEndpointUri('https://host.example:0', '/v1/sessions')
             .toString(),
         'https://host.example/v1/sessions',
       );
     });
     ```
   - This covers both URL-building callsites found by grep: `_authenticate()` uses WebSocket bootstrap at `client/lib/src/services/agentic_remote_api.dart` lines 140-145, and `fetchSessions()` uses REST at lines 214-218.

6. Do not change backend pairing generation or config validation in this fix.
   - Current backend behavior read: `backend/cmd/agenticRemote/main.go` line 165 passes `cfg.PublicEndpoint` directly to `PairingStore.Create`, `backend/internal/security/pairing.go` line 83 embeds that endpoint unchanged in `PairingPayload`, and `backend/internal/config/config.go` lines 70-85 validate scheme/host/path/query/fragment but do not reject port `0`.
   - The requested failing path is the client attempting to connect through Cloudflare with an already-present `:0` endpoint. Client normalization fixes QR/paste payloads that already exist and avoids requiring a daemon config change before connecting.

## Critical files & anchors

- `client/lib/src/services/agentic_remote_api.dart` — `agenticEndpointUri` is the URL construction point; `_validateEndpointTrust()`, `_authenticate()`, and `fetchSessions()` must all use normalized endpoint URIs.
- `client/test/agentic_remote_api_test.dart` — existing helper tests; add the zero-port regression test here.
- `client/lib/src/services/agentic_remote_transport_io.dart` — confirms missing ports already become default ports in native socket dialing once the URI no longer explicitly contains `:0`.
- `client/lib/src/services/agentic_remote_transport_web.dart` — confirms web WebSocket dialing uses the URI as built by `agenticEndpointUri`, so normalization must happen before transport.
- `backend/cmd/agenticRemote/main.go` — `rotatePairing()` passes `cfg.PublicEndpoint` into the QR payload unchanged; leave it unchanged for this client compatibility fix.

## Verification

Run from repository root after editing:

1. `cd client && flutter test test/agentic_remote_api_test.dart`
   - New behavior check: the new `agenticEndpointUri drops explicit zero port` test must pass, proving `https://host.example:0` becomes `wss://host.example/v1/ws/sessions/bootstrap` for WebSocket bootstrap and `https://host.example/v1/sessions` for REST.
   - Existing behavior check: the existing tests in the same file must still pass, proving normal HTTPS, plaintext HTTP/WS, and sessions path construction did not regress.

2. `make client-test`
   - Confirms the Flutter test suite still passes with the shared helper and trust-probe caller change.

Manual smoke check if a Cloudflare tunnel endpoint is available:

1. Start the daemon with `publicEndpoint` set to a Cloudflare hostname that currently appears in the QR/paste payload as `https://agent-mac.paperplain.tech:0`.
2. Paste or scan that payload in the Flutter client.
3. Expected observable result: connection reaches the Auth-v2 step using `wss://agent-mac.paperplain.tech/v1/ws/sessions/bootstrap` rather than any URL containing `:0`; the previous client-side exception with HTTP status 400 must not occur.

## Assumptions & contingencies

- Treat explicit endpoint port `0` as “use the scheme default port,” not as a real remote port. This matches the Cloudflare tunnel use case and keeps non-zero daemon ports intact.
- If execution discovers the `Uri(...)` constructor above produces malformed output for an existing test case, keep the same policy but build from `base.replace(...)` only for non-zero ports and use `Uri(...)` only for `base.port == 0`; the expected strings in `client/test/agentic_remote_api_test.dart` remain authoritative.
