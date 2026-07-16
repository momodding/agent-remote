<!-- source-branch: main -->
## Context

The user expects the Flutter client to connect to the backend daemon when the daemon is reachable through a VPN, Tailscale, or a plain Cloudflare Tunnel public hostname. The intended end state is one configured reachable endpoint per daemon run: the daemon binds to non-loopback when requested, pairing QR advertises that one endpoint, TLS material includes that endpoint identity, native clients either use platform-trusted TLS or fall back to fingerprint-pinned self-signed TLS, and web clients work only when the browser already trusts the endpoint. Do not add a relay, broker, Cloudflare Access login, or multi-endpoint QR format.

## Findings

- `backend/internal/config/config.go` defaults `ListenAddr` to `"127.0.0.1:8765"` and `PublicEndpoint` to `"https://127.0.0.1:8765"`; this binds and advertises loopback only.
- `backend/cmd/agenticRemote/main.go` passes `cfg.ListenAddr` into `security.EnsureTLS`, listens with `net.Listen("tcp", cfg.ListenAddr)`, and prints pairing payloads from `store.Create(cfg.PublicEndpoint, fingerprint, now)`.
- `backend/internal/security/tls.go` creates a persisted self-signed cert once. Its SANs come only from `certificateIPs(listenAddr)`, which currently includes loopback plus the literal IP from `listenAddr`; hostnames and `publicEndpoint` hosts are not represented.
- `client/lib/src/services/agentic_remote_api.dart` parses the QR `endpoint`, validates the presented certificate fingerprint on native clients with `SecureSocket.connect(uri.host, uri.port, onBadCertificate: (_) => true)`, authenticates over `pairing.endpoint` converted from `https://` to `wss://`, and fetches sessions from `${pairing.endpoint}/v1/sessions`.
- Browser/web clients cannot inspect peer certificates or accept an untrusted self-signed cert in Dart. Web remote access therefore requires a browser-trusted endpoint: Cloudflare/public CA, or a cert installed into the user's OS/browser trust store.
- `allowedCidrs` is only validated in config and is not enforced anywhere in `backend/internal/server` or `backend/cmd`; remote enablement should not depend on it.
## Approach

### 1. Normalize and validate the configured public endpoint

Edit `backend/internal/config/config.go` only.

- Add `net/url` to imports.
- In `Validate(cfg Config)`, after the positive limit check and before CIDR parsing, parse `cfg.PublicEndpoint` with `url.Parse` and reject invalid remote endpoints with exact errors:
  - if parse fails, return `fmt.Errorf("invalid publicEndpoint: %w", err)`.
  - if `u.Scheme != "https"`, return `errors.New("publicEndpoint must use https")`.
  - if `u.Host == ""`, return `errors.New("publicEndpoint must include host")`.
  - if `u.Path != "" && u.Path != "/"`, return `errors.New("publicEndpoint must not include path")`.
  - if `u.RawQuery != "" || u.Fragment != ""`, return `errors.New("publicEndpoint must not include query or fragment")`.
- Reject non-root paths because the Go daemon registers `/healthz` and `/v1/...` at root; supporting path prefixes correctly requires a proxy that strips the prefix, which is a separate deployment concern.
- Leave `AllowedCIDRs` as validation-only. Do not enforce it in this refactor; the current default is loopback-only and enforcing it would break the requested remote access.
- Extend `backend/internal/config/config_test.go`:
  - Keep `TestDefaultValues` expecting `ListenAddr == "127.0.0.1:8765"`; do not change defaults to remote-open because that would expose existing installs without an explicit config change.
  - Add table-driven `TestPublicEndpointValidation` with cases: `http://host:8765` fails, `https://` fails, `https://host:8765?x=1` fails, `https://host.example.com/base` fails, `https://host.example.com:8765` passes.

### 2. Generate TLS SANs from listen address and public endpoint

Edit `backend/internal/security/tls.go`, then update the one caller in `backend/cmd/agenticRemote/main.go` and tests.

- Change `func EnsureTLS(stateDir, listenAddr string) (*TLSMaterial, error)` to exact signature `func EnsureTLS(stateDir, listenAddr, publicEndpoint string) (*TLSMaterial, error)`.
- Change the certificate template construction to use a new helper with exact signature `func certificateHosts(listenAddr, publicEndpoint string) ([]net.IP, []string)` and assign both fields:
  - `IPAddresses: ips,`
  - `DNSNames: dnsNames,`
- `certificateHosts` behavior:
  - Always include IP SANs `127.0.0.1` and `::1`.
  - If `listenAddr` has an IP host from `net.SplitHostPort`, include it unless it is unspecified (`0.0.0.0` or `::`); unspecified bind addresses are not routable client identities.
  - Parse `publicEndpoint` with `url.Parse`; if it has an IP host, include it in IP SANs; if it has a non-empty hostname, include it in DNS SANs. Lowercase the DNS name using `strings.ToLower`.
  - Deduplicate IPs by `ip.String()` and DNS names by exact lowercased name while preserving first-seen order.
  - If `publicEndpoint` is invalid, return only listen/loopback entries; config validation will reject invalid values before daemon startup.
- Keep existing persisted cert behavior: if `cert.pem` and `key.pem` already exist, `EnsureTLS` returns `loadTLS` and does not regenerate. Add a `// ponytail:` comment beside this existing behavior noting users must delete the persisted cert or state dir after changing `publicEndpoint` if they need browser hostname SANs; native clients can still use fingerprint pinning when the endpoint presents the daemon cert.
- In `backend/cmd/agenticRemote/main.go`, update the call at `serve` to `security.EnsureTLS(stateDir, cfg.ListenAddr, cfg.PublicEndpoint)`.
- Update tests/calls in `backend/internal/server/server_test.go` and any security tests that call `EnsureTLS` directly.
- Add `backend/internal/security/tls_test.go` if absent. Test `certificateHosts("0.0.0.0:8765", "https://tail-host.ts.net:8765")` returns DNS `tail-host.ts.net` and does not return IP `0.0.0.0`; test `certificateHosts("127.0.0.1:8765", "https://100.64.1.2:8765")` includes IP `100.64.1.2` once.

### 3. Add a minimal platform transport for native pinning and web trust

Create three small client service files and update `client/lib/src/services/agentic_remote_api.dart` to use them. This is required because `agentic_remote_api.dart` currently imports `dart:io`, which cannot compile for web, and native `WebSocketChannel.connect`/`http.Client()` will reject the daemon's self-signed cert even after fingerprint validation.

- Create `client/lib/src/services/agentic_remote_transport.dart` as a conditional export:
  - `export 'agentic_remote_transport_web.dart' if (dart.library.io) 'agentic_remote_transport_io.dart';`
- Create `client/lib/src/services/agentic_remote_transport_web.dart` with imports `dart:typed_data`, `package:http/http.dart` as `http`, and `package:web_socket_channel/web_socket_channel.dart`; no `dart:io` import. Implement these exact functions:
  - `Future<bool> platformTrustsEndpoint(Uri uri) async => true;`
  - `Future<Uint8List?> peerCertificateDer(Uri uri) async => null;`
  - `http.Client createHttpClient({String? trustedFingerprint, required String Function(Uint8List) formatFingerprint}) => http.Client();`
  - `WebSocketChannel connectWebSocket(Uri uri, {String? trustedFingerprint, required String Function(Uint8List) formatFingerprint}) => WebSocketChannel.connect(uri);`
- Create `client/lib/src/services/agentic_remote_transport_io.dart` with `dart:io`, `dart:typed_data`, `package:http/io_client.dart`, `package:http/http.dart` as `http`, `package:web_socket_channel/io.dart`, and `package:web_socket_channel/web_socket_channel.dart` imports. Implement the same four functions:
  - `platformTrustsEndpoint` opens `SecureSocket.connect(uri.host, _endpointPort(uri))` without `onBadCertificate`; return `true` on success after destroying the socket, return `false` only for `HandshakeException`, and rethrow other errors.
  - `peerCertificateDer` opens `SecureSocket.connect(uri.host, _endpointPort(uri), onBadCertificate: (_) => true)`, returns `socket.peerCertificate?.der`, and always destroys the socket.
  - `createHttpClient` returns default `http.Client()` when `trustedFingerprint == null`; otherwise returns `IOClient(_pinnedHttpClient(trustedFingerprint, formatFingerprint))`.
  - `connectWebSocket` returns `WebSocketChannel.connect(uri)` when `trustedFingerprint == null`; otherwise returns `IOWebSocketChannel.connect(uri, customClient: _pinnedHttpClient(trustedFingerprint, formatFingerprint))`.
  - `_pinnedHttpClient` sets `HttpClient.badCertificateCallback` to return `trustedFingerprint == formatFingerprint(cert.der)`.
  - `_endpointPort` returns `uri.port` when present, otherwise `443` for `https`/`wss` and `80` for `http`/`ws`.

### 4. Refactor client endpoint and trust flow without changing pairing JSON

Edit `client/lib/src/services/agentic_remote_api.dart`.

- Remove the direct `dart:io` import and import `agentic_remote_transport.dart` plus `package:flutter/foundation.dart` remains for `kIsWeb` and `@visibleForTesting`.
- Add fields to `AgenticRemoteApi`:
  - `String? _trustedFingerprint;`
- Replace `_validateFingerprint()` with exact signature `_validateEndpointTrust({required bool webTrustConfirmed})`:
  - Parse `pairing!.endpoint` as `uri` and set `_trustedFingerprint = null` before any trust checks so reconnecting to a platform-trusted endpoint cannot reuse an old pinned client.
  - If `kIsWeb`, keep the existing manual confirmation behavior: add the existing diagnostic `Browser TLS fingerprint access unavailable; relying on HTTPS origin trust for web`, throw `StateError('Manual endpoint confirmation required')` and add `Failed: Manual endpoint confirmation required` when `webTrustConfirmed` is false, set `client = createHttpClient(trustedFingerprint: null, formatFingerprint: _formatFingerprint)`, and return when confirmed. Web relies on browser TLS origin trust and cannot pin.
  - If `await platformTrustsEndpoint(uri)` is true, set `client = createHttpClient(trustedFingerprint: null, formatFingerprint: _formatFingerprint)` and return; this supports plain Cloudflare Tunnel/public CA/user-installed trust.
  - Otherwise call `peerCertificateDer(uri)`, throw `StateError('No certificate presented')` if null, compare `_formatFingerprint(der)` to `pairing!.fingerprint`, and on match set `_trustedFingerprint = pairing!.fingerprint`; on mismatch keep the existing diagnostic `Failed: Certificate fingerprint mismatch` and throw `StateError('Certificate fingerprint mismatch')`.
  - After a fingerprint match, assign `client = createHttpClient(trustedFingerprint: _trustedFingerprint, formatFingerprint: _formatFingerprint)` so REST uses the same pinned trust decision.
- In `connectFromPayload`, remove the old inline `if (kIsWeb) ... else ...` block and call `_validateEndpointTrust(webTrustConfirmed: webTrustConfirmed)` after the existing diagnostics strings.
- Add top-level testable helper:
  - `@visibleForTesting Uri agenticEndpointUri(String endpoint, String path, {String? scheme})`
  - It parses `endpoint` and returns `base.replace(scheme: scheme ?? base.scheme, path: path, query: '', fragment: '')`; `path` must be passed with a leading slash.
- In `_authenticate`, use `final endpoint = agenticEndpointUri(pairing!.endpoint, '/v1/ws/sessions/bootstrap', scheme: 'wss');` and create the channel with `connectWebSocket(endpoint, trustedFingerprint: _trustedFingerprint, formatFingerprint: _formatFingerprint)`.
- In `fetchSessions`, use `agenticEndpointUri(pairing!.endpoint, '/v1/sessions')` instead of string concatenation.
- Do not add or remove fields from `backend/internal/security.PairingPayload` or `client/lib/src/protocol/PairingPayload`; pairing JSON stays `v`, `endpoint`, `fingerprint`, `pairingId`, `token`, `expiresAt`.

### 5. Document the exact remote trust semantics

Edit `docs/protocol.md` under `## Rolling QR pairing and Auth-v2`.

- Keep the existing QR field list unchanged.
- Add one short paragraph after item 1: `endpoint` is one HTTPS root base URL for this daemon run; it may be loopback, VPN/Tailscale, or a plain Cloudflare Tunnel/public-CA hostname. Native clients first accept platform-trusted TLS, otherwise they require the QR `fingerprint` to match the presented daemon certificate. Web clients cannot pin certificates and require the browser to trust the endpoint.
- Do not document Cloudflare Access/Zero Trust login as supported.

### 6. Keep examples local by default

Do not edit `examples/config.local.json`. Local defaults are safer; remote access is an explicit config choice documented and verified by the temp-config smoke command.

## Critical files & anchors

- `backend/internal/config/config.go` — `Config`, `Default`, and `Validate`; this is where `publicEndpoint` becomes a validated HTTPS remote identity without opening defaults.
- `backend/internal/security/tls.go` — `EnsureTLS` and `certificateIPs`; this is the root cause for hostname/IP SAN support when the endpoint is Tailscale, VPN, or plain Cloudflare Tunnel.
- `backend/cmd/agenticRemote/main.go` — `serve` and `rotatePairing`; this wires `PublicEndpoint` into TLS generation and QR payloads.
- `client/lib/src/services/agentic_remote_api.dart` plus new `agentic_remote_transport_*.dart` files — endpoint building, web-safe imports, native platform-trust fallback, and fingerprint-pinned REST/WSS.
- `docs/protocol.md` — user-visible remote endpoint and trust-mode semantics; no QR schema change.

## Verification

Run from repo root unless a command says otherwise.

1. Backend targeted tests:
   - `cd backend && go test ./internal/config ./internal/security ./internal/server ./cmd/agenticRemote`
   - Expected: all packages pass. New checks prove `publicEndpoint` accepts `https://host:port`, rejects non-HTTPS/query/fragment/path, and `certificateHosts` includes Tailscale/VPN identity while excluding `0.0.0.0`.
2. Client endpoint helper test:
   - Add `client/test/agentic_remote_api_test.dart` importing `package:agentic_remote/src/services/agentic_remote_api.dart`.
   - Test `agenticEndpointUri('https://host.example', '/v1/ws/sessions/bootstrap', scheme: 'wss').toString()` equals `wss://host.example/v1/ws/sessions/bootstrap`.
   - Test `agenticEndpointUri('https://host.example', '/v1/sessions').toString()` equals `https://host.example/v1/sessions`.
   - Run `cd client && flutter test test/agentic_remote_api_test.dart test/protocol_messages_test.dart`.
3. Web compile proof:
   - Run `make client-build-web`.
   - Expected: web build passes, proving `agentic_remote_api.dart` no longer imports `dart:io` into the web target.
4. Smoke the remote daemon path with a temporary config generated outside tracked files:
   - Create a temp config containing `"listenAddr": "0.0.0.0:0"` and `"publicEndpoint": "https://tail-host.ts.net:8765"` plus the same required fields as `examples/config.local.json`.
   - Run `cd backend && AGENTICREMOTE_TEST_ONESHOT=1 go run ./cmd/agenticRemote serve --config /tmp/<config>.json`.
   - Expected: command exits with the existing `daemon exited` sentinel and prints a pairing JSON line whose `endpoint` is exactly `https://tail-host.ts.net:8765`.
5. Full proof after targeted checks:
   - `make backend-test`
   - `make client-test`

Manual environment proof after deployment: set `listenAddr` to `0.0.0.0:8765` or the specific VPN/Tailscale interface IP and set `publicEndpoint` to exactly one reachable URL for that daemon run, e.g. `https://100.x.y.z:8765`, `https://device.tailnet.ts.net:8765`, or `https://daemon.example.com`. Pair from a native client using the printed QR/JSON; expected diagnostics reach `Session Established`, and the sessions list loads over the same endpoint. For web, use `https://daemon.example.com` with Cloudflare/public CA or a user-installed trusted cert; self-signed VPN/Tailscale endpoints are not supportable in browser code.

## Assumptions & contingencies

- One pairing QR advertises exactly one endpoint. For VPN, Tailscale, and Cloudflare together, run with the endpoint the client should use for that session; do not invent multi-endpoint selection in this refactor.
- Cloudflare support means a plain Cloudflare Tunnel hostname where the browser/native client sees a trusted Cloudflare/public-CA certificate. Cloudflare Access/Zero Trust login is not included; if required later, add explicit REST and WSS header/cookie support in the client and config.
- Defaults stay loopback-only for safety. Remote access requires an explicit config change to `listenAddr` and `publicEndpoint`.
- If a user changes `publicEndpoint` after a cert already exists, native clients still work when either the endpoint is platform-trusted or the presented cert matches the QR fingerprint; browsers may reject a self-signed origin whose SAN lacks the new hostname. The decided fallback is operational, not code: delete the daemon state's `tls/cert.pem` and `tls/key.pem` or the whole test state dir to regenerate TLS material for the new public endpoint.
