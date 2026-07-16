<!-- omp-work-branch: omp/dual-http-https-listener -->
<!-- omp-source-branch: main -->
## Context

User reports a proxy/plain `curl` reaching the daemon as HTTP while the daemon only accepts HTTPS, producing `http: TLS handshake error ... client sent an HTTP request to an HTTPS server`; the Flutter client then fails bootstrap with `failed to connect websocket`. Current code confirms `backend/cmd/agenticRemote/main.go:123-140` starts one TCP listener and always calls `ServeTLS`, while `client/lib/src/services/agentic_remote_api.dart:120-131` always builds a `wss://` bootstrap URL. End state: the daemon defaults to current HTTPS/WSS behavior, can be configured to serve plaintext HTTP/WS instead, QR payloads may advertise either `http://` or `https://`, the client derives `ws://` vs `wss://` from that endpoint, and server logs show each handler-level request attempt.

This implements the user's configurable fallback, not simultaneous HTTP+HTTPS on one port. One-port simultaneous serving would require custom TCP protocol sniffing or a second listener address; the minimal stdlib-safe fix is one explicit listener scheme.

## Approach

### Backend listener configuration

1. In `backend/internal/config/config.go`, add a field `ListenScheme string` with struct tag `json:"listenScheme"` to `Config` immediately after `ListenAddr`.
   - Default literal in `Default()`: `ListenScheme: "https"`.
   - In `Validate`, reject anything except exactly `"http"` or `"https"` with `errors.New("listenScheme must be http or https")`.
   - Change `publicEndpoint` validation to accept schemes `"http"` and `"https"`; reject every other scheme with `errors.New("publicEndpoint must use http or https")`.
   - Keep the existing `publicEndpoint` host/path/query/fragment validation unchanged.
   - Do not infer `listenScheme` from `publicEndpoint`; `listenScheme:"http"` with `publicEndpoint:"https://proxy-host"` is valid for a TLS-terminating proxy.

2. Update `backend/internal/config/config_test.go`.
   - In `TestDefaultValues`, assert `cfg.ListenScheme == "https"`.
   - In `TestPublicEndpointValidation`, replace the current `http://host:8765` rejection case with `{name: "rejects unsupported scheme", endpoint: "ftp://host:8765", wantErr: true}`.
   - Add `{name: "accepts http host", endpoint: "http://host.example.com:8765", wantErr: false}` to `TestPublicEndpointValidation`.
   - Add `TestListenSchemeValidation` with cases: default/`"https"` valid, `"http"` valid, `"tcp"` invalid.

3. In `backend/cmd/agenticRemote/main.go`, keep `security.EnsureTLS(stateDir, cfg.ListenAddr, cfg.PublicEndpoint)` unconditionally so existing QR schema and HTTPS mode keep a fingerprint.
   - Replace `httpServer := &http.Server{Addr: cfg.ListenAddr, Handler: srv.Handler(), TLSConfig: srv.TLSConfig()}` with:
     ```go
     httpServer := server.ServerTimeouts(srv.Handler(), cfg.ListenAddr)
     httpServer.TLSConfig = srv.TLSConfig()
     ```
   - Add this helper in the same file:
     ```go
     func serveListener(httpServer *http.Server, listener net.Listener, cfg config.Config, tlsMaterial *security.TLSMaterial) error {
         if cfg.ListenScheme == "http" {
             log.Printf("serving HTTP on %s", listener.Addr())
             return httpServer.Serve(listener)
         }
         log.Printf("serving HTTPS on %s", listener.Addr())
         return httpServer.ServeTLS(listener, tlsMaterial.CertPath, tlsMaterial.KeyPath)
     }
     ```
   - Replace the final `httpServer.ServeTLS(listener, tlsMaterial.CertPath, tlsMaterial.KeyPath)` call with `serveListener(httpServer, listener, cfg, tlsMaterial)` and keep the existing `!errors.Is(err, http.ErrServerClosed)` handling.
   - Do not add redirect behavior, auto-upgrade, a second port, or a compatibility alias.

4. Update `backend/cmd/agenticRemote/main_test.go`.
   - Extend `writeConfig` JSON with `"listenScheme": "https"` after `listenAddr` so the sample test config covers the new field.
   - Add `TestServeListenerHTTPModeAcceptsPlainHealth` in `main_test.go`:
     - Create `listener, err := net.Listen("tcp", "127.0.0.1:0")`.
     - Use `cfg := config.Default(); cfg.ListenScheme = "http"`.
     - Use `httpServer := server.ServerTimeouts(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }), listener.Addr().String())`.
     - Run `go func() { errCh <- serveListener(httpServer, listener, cfg, nil) }()`.
     - `http.Get("http://" + listener.Addr().String())` must return status `200`.
     - Shut down with `httpServer.Shutdown(context.Background())`; allow only `nil` or `http.ErrServerClosed` from `errCh`.

### Request attempt logging

5. In `backend/internal/server/server.go`, wrap the mux returned by `Handler()` with a new `logRequests` middleware.
   - Add imports `log` and `time`.
   - Change the end of `Handler()` from `return mux` to `return logRequests(mux)`.
   - Add the exact middleware below the `Handler()` function:
     ```go
     type statusRecorder struct {
         http.ResponseWriter
         status int
     }

     func (r *statusRecorder) WriteHeader(status int) {
         if r.status == 0 {
             r.status = status
         }
         r.ResponseWriter.WriteHeader(status)
     }

     func (r *statusRecorder) Write(data []byte) (int, error) {
         if r.status == 0 {
             r.status = http.StatusOK
         }
         return r.ResponseWriter.Write(data)
     }

     func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

     func logRequests(next http.Handler) http.Handler {
         return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
             started := time.Now()
             log.Printf("request start remote=%s method=%s path=%s", r.RemoteAddr, r.Method, r.URL.RequestURI())
             rec := &statusRecorder{ResponseWriter: w}
             next.ServeHTTP(rec, r)
             if rec.status == 0 {
                 rec.status = http.StatusOK
             }
             log.Printf("request complete remote=%s method=%s path=%s status=%d duration=%s", r.RemoteAddr, r.Method, r.URL.RequestURI(), rec.status, time.Since(started))
         })
     }
     ```
   - Keep `Unwrap()` so Go's `http.ResponseController` can reach the underlying writer for WebSocket upgrades.
   - This logs handler-level attempts. If `listenScheme:"https"` receives plaintext HTTP, the TLS handshake still fails before a handler exists; the existing Go TLS handshake error remains the only possible log for that mismatch.

6. Update `backend/internal/server/server_test.go`.
   - Add imports `bytes`, `log`, and `strings`.
   - Add `TestHandlerLogsRequestAttempt`:
     - Capture `log` output with `var buf bytes.Buffer; old := log.Writer(); log.SetOutput(&buf); defer log.SetOutput(old)`.
     - Call `srv.Handler().ServeHTTP` with `httptest.NewRequest(http.MethodGet, "/healthz", nil)`.
     - Assert `buf.String()` contains `request start`, `method=GET`, and `path=/healthz`.

### Client HTTP WebSocket support

7. In `client/lib/src/services/agentic_remote_api.dart`, add a visible-for-testing helper next to `agenticEndpointUri`:
   ```dart
   @visibleForTesting
   String agenticWebSocketScheme(String endpoint) =>
       Uri.parse(endpoint).scheme == 'http' ? 'ws' : 'wss';
   ```

8. In `AgenticRemoteApi.connectFromPayload`, make diagnostics match HTTP vs HTTPS.
   - After `pairing = PairingPayload.fromJson(...)`, compute `final endpointScheme = Uri.parse(pairing!.endpoint).scheme;`.
   - Keep `diagnostics.add('Resolving endpoint...');`.
   - If `endpointScheme == 'http'`, add `diagnostics.add('Using plaintext HTTP endpoint...');` and do not add `Initiating TLS Handshake...` or `Validating Certificate Fingerprint...`.
   - Otherwise keep the current TLS diagnostic lines unchanged, including the allow-bad-certificates wording.

9. In `AgenticRemoteApi._validateEndpointTrust`, skip TLS certificate checks for plaintext HTTP.
   - Immediately after `final uri = Uri.parse(pairing!.endpoint); _trustedFingerprint = null;`, add:
     ```dart
     if (uri.scheme == 'http') {
       client = createHttpClient(
         trustedFingerprint: null,
         formatFingerprint: _formatFingerprint,
         allowBadCertificates: false,
       );
       return;
     }
     ```
   - Keep all existing HTTPS/web/fingerprint behavior unchanged.
   - The QR `fingerprint` field remains required by `PairingPayload`; HTTP clients ignore it because no peer certificate exists.

10. In `AgenticRemoteApi._authenticate`, replace the hardcoded `scheme: 'wss'` with `scheme: agenticWebSocketScheme(pairing!.endpoint)`.

11. Update `client/test/agentic_remote_api_test.dart`.
   - Keep the existing HTTPS bootstrap test expecting `wss://host.example/v1/ws/sessions/bootstrap`.
   - Add a test that builds the same bootstrap path from `http://host.example` using `scheme: agenticWebSocketScheme('http://host.example')` and expects `ws://host.example/v1/ws/sessions/bootstrap`.
   - Add direct expectations: `agenticWebSocketScheme('https://host.example') == 'wss'` and `agenticWebSocketScheme('http://host.example') == 'ws'`.

## Critical files & anchors

- `backend/cmd/agenticRemote/main.go:76-146` — daemon startup, listener creation, shutdown sentinel, and the `ServeTLS` call being made configurable.
- `backend/internal/config/config.go:14-80` — config schema/defaults and the current HTTPS-only `publicEndpoint` validation.
- `backend/internal/server/server.go:53-72` — route mux and TLS config; wrap the mux here for request attempt logging without touching each handler.
- `client/lib/src/services/agentic_remote_api.dart:42-131` — pairing endpoint trust flow and bootstrap WebSocket URL construction.
- `client/test/agentic_remote_api_test.dart:4-21` — existing pure URL construction tests to extend for `http` → `ws`.

## Verification

Run these from the repository root after implementation.

1. Backend unit proof for config, listener mode, and request logging:
   ```sh
   cd backend && go test ./internal/config ./internal/server ./cmd/agenticRemote
   ```
   Expected: all listed packages pass. New coverage: `listenScheme:"http"` validates, plaintext `http.Get` succeeds through `serveListener`, and `/healthz` emits a `request start ... method=GET path=/healthz` log.

2. Client URL proof:
   ```sh
   cd client && flutter test test/agentic_remote_api_test.dart
   ```
   Expected: tests pass; `http://host.example` bootstrap endpoint becomes `ws://host.example/v1/ws/sessions/bootstrap`, while HTTPS still becomes `wss://...`.

3. Manual smoke proof for the reported curl/proxy shape:
   ```sh
   make backend-build
   tmp="$(mktemp -d)"
   port="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
PY
)"
   cat >"$tmp/config.json" <<EOF
{
  "listenAddr": "127.0.0.1:$port",
  "listenScheme": "http",
  "publicEndpoint": "http://127.0.0.1:$port",
  "stateDir": ".agenticremote",
  "workspaceRoot": ".",
  "uploadDir": "uploads",
  "allowedCidrs": ["127.0.0.0/8", "::1/128"],
  "maxConnections": 8,
  "maxSessions": 16,
  "channelBufferSize": 256,
  "maxScrollbackBytes": 10485760,
  "allowDestructiveFiles": false,
  "expoPushEndpoint": "https://exp.host/--/api/v2/push/send"
}
EOF
   backend/bin/agenticRemote serve --config "$tmp/config.json" >"$tmp/stdout.log" 2>"$tmp/stderr.log" &
   pid=$!
   trap 'kill "$pid" 2>/dev/null || true' EXIT
   for i in $(seq 1 50); do curl -fsS "http://127.0.0.1:$port/healthz" && break || sleep 0.1; done
   curl -fsS "http://127.0.0.1:$port/healthz"
   grep 'request start .*method=GET path=/healthz' "$tmp/stderr.log"
   grep '"endpoint":"http://127.0.0.1:' "$tmp/stdout.log"
   kill "$pid"
   trap - EXIT
   ```
   Expected: both curl calls return `{"ok":true,"version":"dev"}`, stderr contains the request attempt log, and the printed QR JSON advertises an `http://127.0.0.1:<port>` endpoint.

## Assumptions & contingencies

- Default remains `listenScheme:"https"` to preserve existing secure behavior and existing configs that omit the new field.
- Direct plaintext pairing requires `publicEndpoint` to be `http://...`; TLS-terminating proxy pairing should use `listenScheme:"http"` and a proxy-facing `publicEndpoint:"https://..."`, so the client still uses `wss://` to the proxy while the daemon receives HTTP from the proxy.
- Browser clients may block `http://` or `ws://` from a secure Flutter Web origin as mixed content; for browser use, keep `publicEndpoint:"https://..."` through a trusted TLS endpoint. Native clients can use direct `http://` after this change.
- If the manual smoke port is taken between selection and daemon start, rerun the same command; do not change implementation behavior for that test race.
