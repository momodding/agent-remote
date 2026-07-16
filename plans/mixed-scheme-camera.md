# Mixed-scheme listener + Android release camera fix

<!-- omp-source-branch: main -->

## Context

Two independent issues:

1. **Daemon listener rejects plain HTTP** — Cloudflare Zero Trust tunnel sends cleartext HTTP to the daemon's HTTPS listener, producing `TLS handshake error: client sent an HTTP request to an HTTPS server`. The daemon must accept both cleartext HTTP and HTTPS on the same TCP port, detecting the scheme from the first bytes of each connection (TLS ClientHello vs plain HTTP request line).

2. **Android release APK camera doesn't open** — `mobile_scanner` works in debug but fails on release. The Flutter plugin declares `<uses-permission android:name="android.permission.CAMERA">` in its own manifest, but Flutter's manifest merger may exclude plugin-only permissions in release builds. Also, the current widget has no `errorBuilder`, so camera errors (permission denied, unsupported) show a blank rectangle with no feedback.

## Approach

### Part A — TLS-sniffing listener

**File:** `backend/cmd/agenticRemote/main.go`

**Strategy:** Wrap the `net.Listener` with a `sniffListener` that peeks at the first byte of each accepted connection. If byte `0x16` (TLS ClientHello), wrap the connection with `tls.Server` + `prependConn` (replays the peeked byte). Otherwise wrap with just `prependConn` for plain HTTP. Both paths need the first byte replayed — `tls.Server` consumes it during handshake, `http.Server`'s internal buffering needs it for parsing.

**Why this over alternatives:**
- Go stdlib `http.Server` has no "both schemes" mode.
- Two listeners on different ports requires network infra changes.
- First-byte detection is how nginx/HAProxy do it; 0x16 = TLS, anything else = plain text. Unambiguous.

**Implementation steps:**

1. **Add types** to `main.go` (package level after imports):
   ```go
   type sniffListener struct {
       net.Listener
       tlsConfig *tls.Config
   }

   type prependConn struct {
       net.Conn
       buf  byte
       done bool
   }

   func (c *prependConn) Read(p []byte) (int, error) {
       if !c.done {
           c.done = true
           p[0] = c.buf
           if len(p) == 1 {
               return 1, nil
           }
           n, err := c.Conn.Read(p[1:])
           return n + 1, err
       }
       return c.Conn.Read(p)
   }
   ```

2. **Implement `sniffListener.Accept`:**
   ```go
   func (l *sniffListener) Accept() (net.Conn, error) {
       conn, err := l.Listener.Accept()
       if err != nil {
           return nil, err
       }
       var buf [1]byte
       if _, err := io.ReadFull(conn, buf[:]); err != nil {
           conn.Close()
           return nil, &tempError{err} // temporary so http.Server logs and continues
       }
       if buf[0] == 0x16 {
           return tls.Server(&prependConn{Conn: conn, buf: buf[0]}, l.tlsConfig), nil
       }
       return &prependConn{Conn: conn, buf: buf[0]}, nil
   }

   type tempError struct{ err error }
   func (e *tempError) Error() string   { return e.err.Error() }
   func (e *tempError) Temporary() bool { return true }
   func (e *tempError) Timeout() bool {
       if ne, ok := e.err.(net.Error); ok {
           return ne.Timeout()
       }
       return false
   }
   func (e *tempError) Unwrap() error   { return e.err }
   ```
   **Edge handling:**
   - `net.Listener.Accept()` errors (socket close): propagate directly — `http.Server.Serve` exits, same as current behavior.
   - `io.ReadFull` error on an already-accepted conn (client RST, timeout): close conn, return `tempError`. `http.Server.Serve` checks `net.Error.Temporary()` → logs and continues accepting.
   - `ReadHeaderTimeout` covers idle connections after handoff; peek blocks until first byte arrives (same window as first HTTP Read would see).
   - No dependencies on `bufio` — `io.ReadFull` with a 1-byte buffer is sufficient.

3. **Add imports:** `"crypto/tls"`, `"io"` (already there: `"io"` not currently in main.go imports, `"crypto/tls"` not currently imported — check). Add both.

4. **Modify `serve` function:**
   Replace:
   ```go
   httpServer := server.ServerTimeouts(srv.Handler(), cfg.ListenAddr)
   httpServer.TLSConfig = srv.TLSConfig()
   listener, err := net.Listen("tcp", cfg.ListenAddr)
   ...
   if err := serveListener(httpServer, listener, cfg, tlsMaterial); err != nil && !errors.Is(err, http.ErrServerClosed) {
   ```
   With:
   ```go
   httpServer := server.ServerTimeouts(srv.Handler(), cfg.ListenAddr)
   tlsConfig := srv.TLSConfig()
   rawListener, err := net.Listen("tcp", cfg.ListenAddr)
   ...
   listener := &sniffListener{Listener: rawListener, tlsConfig: tlsConfig}
   log.Printf("serving on %s (accepting HTTP and HTTPS)", listener.Addr())
   if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
   ```

5. **Delete `serveListener` function** (lines 150-157 in current file).

6. **Update test** `TestServeListenerHTTPModeAcceptsPlainHealth` in `main_test.go`:
   - Rename to `TestServeListenerAcceptsPlainHTTP`.
   - Remove `cfg` and `serveListener` call.
   - Create `sniffListener` wrapping the raw listener (no TLS config — test handler doesn't use TLS).
   - Call `httpServer.Serve(listener)` directly.
   - Verify HTTP GET returns 200.

**Files changed:**
- `backend/cmd/agenticRemote/main.go` — add ~40 lines (types + Accept + prependConn + tempError), modify ~10 lines (serve), delete ~8 lines (serveListener).
- `backend/cmd/agenticRemote/main_test.go` — rewrite one test function.

### Part B — Android release camera permission

**Root cause hypothesis:** `mobile_scanner` declares `CAMERA` in its own manifest, but the app's `src/main/AndroidManifest.xml` declares zero permissions. Flutter's manifest merger may drop plugin-only permissions in release builds when the base manifest lacks its own matching declaration. Adding the permission explicitly fixes it. Separately, the widget lacks `errorBuilder` so errors show as a blank rectangle.

**Steps:**

1. **Add CAMERA permission** to `client/android/app/src/main/AndroidManifest.xml`:
   Insert after `<manifest ...>` line (line 1), before `<application>`:
   ```xml
   <uses-permission android:name="android.permission.CAMERA"/>
   ```

2. **Add `errorBuilder`** to `MobileScanner` widget in `client/lib/src/features/dashboard/session_dashboard.dart`:
   ```dart
   errorBuilder: (context, error) {
     return Center(
       child: Padding(
         padding: EdgeInsets.all(16),
         child: Text(
           'Camera error: ${error.errorDetails?.message ?? error.errorCode.message}',
           textAlign: TextAlign.center,
         ),
       ),
     );
   },
   ```
   Insert after `onDetect:` parameter, before the closing `),`.

**Files changed:**
- `client/android/app/src/main/AndroidManifest.xml` — 1 line added.
- `client/lib/src/features/dashboard/session_dashboard.dart` — ~10 lines added (errorBuilder parameter).

## Critical files & anchors

| File | Region | Why |
|------|--------|-----|
| `backend/cmd/agenticRemote/main.go` | `serve()` + `serveListener()` | Listener creation and scheme dispatch — core of Part A |
| `backend/cmd/agenticRemote/main_test.go` | `TestServeListenerHTTPModeAcceptsPlainHealth` | Only test exercising the serve path directly |
| `client/android/app/src/main/AndroidManifest.xml` | line 1 `<manifest>` | Insert CAMERA permission before `<application>` |
| `client/lib/src/features/dashboard/session_dashboard.dart` | `MobileScanner` widget | Add `errorBuilder` parameter |

## Verification

### Part A
1. `cd backend && go build ./cmd/agenticRemote/` — compiles.
2. `cd backend && go test ./cmd/agenticRemote/ -run TestServeListenerHTTPModeAcceptsPlainHealth -v` — passes (test renamed; adjust pattern).
3. `cd backend && go test ./cmd/agenticRemote/ -v -count=1` — all tests pass (especially `TestRunServeStartsDaemon` which exercises the full HTTPS path through the sniff listener).
4. Manual: start daemon with default config, `curl http://127.0.0.1:8765/v1/health` — returns valid JSON. `curl -k https://127.0.0.1:8765/v1/health` — also works.

### Part B
1. `cd client && flutter build apk --release` — builds without error.
2. Manual: install release APK, navigate to dashboard, tap "Scan QR" — camera opens. If permission denied, visible error text appears instead of blank rectangle.

## Assumptions & contingencies

- The `serveListener` function is only called from one place (`serve()` → `main.go:141`). Verified by grep. Inlining is safe.
- `prependConn` implements only `Read`. `http.Server` uses `Read`, `Write`, `Close`, `LocalAddr`/`RemoteAddr` — all delegated via embedded `net.Conn` (from `tls.Conn` or raw conn). No other methods are needed; `SetDeadline`/`SetReadDeadline` are not called directly by `http.Server`.
- If the Android camera release issue has a different root cause (Android 14+ foreground service type, Flutter engine regression), the `errorBuilder` provides a visible diagnosis path. The manifest permission is the most common cause and the fix is zero-cost.
- `tempError` uses `Temporary() bool` which was deprecated in Go 1.20+ but still recognized by `net.Error` interface check in `http.Server.Serve`. No replacement interface exists in stdlib, so this is the correct approach for the current Go version. If `Temporary()` is removed in a future Go release, replace with a `conn.Close(); continue;` pattern inside the `Accept` loop (lifted out of `http.Server`).
