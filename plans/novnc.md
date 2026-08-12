<!-- source_branch: main -->
<!-- work_branch: omp/novnc -->
## Context

Integrate noVNC into agenticRemote: a backend WebSocket-to-TCP proxy (websockify pattern) bridging from clients to the host's local VNC server, a VNC availability check on daemon startup, connection-type logging for debugging, and a conditionally-compiled Expo client screen wrapping the noVNC JavaScript viewer in a WebView. The VNC WebSocket endpoint reuses existing session token verification — isolated to a query parameter for browser-based WebSocket clients (noVNC's RFB) to authenticate without bleeding query auth to REST endpoints or leaking tokens in logs.

## Approach

### Step 1 — Config: Add VNC port field (independent)

**`backend/internal/config/config.go`**:
- Add `VNCPort int \`json:"vncPort"\`` to `Config` struct (after `PairingPagePassword`).
- In `Default()`, set `VNCPort: 5900`.
- In `Validate()`, add: `if cfg.VNCPort < 1 || cfg.VNCPort > 65535 { return errors.New("vncPort must be 1-65535") }`.

### Step 2 — Backend: VNC availability check at startup (depends on Step 1)

**`backend/cmd/agenticRemote/main.go`** in `serve()`:
Insert right before the test-oneshot block (line 330):
```go
vncAddr := fmt.Sprintf("127.0.0.1:%d", cfg.VNCPort)
if conn, err := net.DialTimeout("tcp", vncAddr, 2*time.Second); err != nil {
    log.Printf("[WARNING] Local VNC server not detected on %s — Remote Desktop will be unavailable", vncAddr)
} else {
    conn.Close()
    log.Printf("[INFO] Local VNC server detected on %s — Remote Desktop proxy available", vncAddr)
}
```

### Step 3 — Backend: Token redaction & connection logging (independent)

**`backend/internal/server/server.go`** `logRequests` (line 108):
Use `url.URL` to redact the query securely before logging. Change to:
```go
func logRequests(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        started := time.Now()
        
        logURL := *r.URL
        if q := logURL.Query(); q.Has("token") {
            q.Set("token", "REDACTED")
            logURL.RawQuery = q.Encode()
        }
        uri := logURL.RequestURI()

        log.Printf("request start remote=%s method=%s path=%s", r.RemoteAddr, r.Method, uri)
        rec := &statusRecorder{ResponseWriter: w}
        next.ServeHTTP(rec, r)
        if rec.status == 0 {
            rec.status = http.StatusOK
        }
        log.Printf("request complete remote=%s method=%s path=%s status=%d duration=%s", r.RemoteAddr, r.Method, uri, rec.status, time.Since(started))
    })
}
```

**`backend/internal/server/server.go`** `handleSessionWS` (line 498):
At the top of the function (before `AcquireWS`), add connection-type logging:
```go
connType := "Terminal"
sessionID := strings.TrimPrefix(r.URL.Path, "/v1/ws/sessions/")
if sessionID == "bootstrap" {
    connType = "Auth-Bootstrap"
}
log.Printf("[INFO] Connection opened | Type: %s | IP: %s | Endpoint: %s", connType, r.RemoteAddr, r.URL.Path)
```
Remove the duplicate `sessionID` declaration that exists slightly below.

### Step 4 — Backend: VNC WebSocket proxy handler (depends on Steps 1, 3)

**`backend/internal/server/server.go`** — add a self-contained handler incorporating VNC-only query auth, limits acquisition, timeout clearing, and bidirectional copying:

```go
func (s *Server) handleVNCProxy(w http.ResponseWriter, r *http.Request) {
    // 1. Auth via query token (VNC-only)
    token := r.URL.Query().Get("token")
    if token == "" || s.auth == nil || !s.authSession(token) {
        writeJSON(w, http.StatusUnauthorized, protocol.ErrorEnvelope{Type: "error", Code: "unauthorized", Message: "authentication failed"})
        return
    }

    log.Printf("[INFO] Connection opened | Type: noVNC | IP: %s | Endpoint: %s", r.RemoteAddr, r.URL.Path)

    // 2. Resource limits
    if err := s.limits.AcquireWS(r.Context()); err != nil {
        writeJSON(w, http.StatusTooManyRequests, protocol.ErrorEnvelope{Type: "error", Code: "max_connections", Message: err.Error()})
        return
    }
    defer s.limits.ReleaseWS()

    // 3. Backend availability
    vncAddr := fmt.Sprintf("127.0.0.1:%d", s.cfg.VNCPort)
    tcpConn, err := net.DialTimeout("tcp", vncAddr, 5*time.Second)
    if err != nil {
        log.Printf("[ERROR] VNC proxy: cannot reach %s: %v", vncAddr, err)
        writeJSON(w, http.StatusServiceUnavailable, protocol.ErrorEnvelope{Type: "error", Code: "vnc_unavailable", Message: "VNC server is not running"})
        return
    }

    // 4. Disable global write timeouts on the HTTP connection
    rc := http.NewResponseController(w)
    _ = rc.SetReadDeadline(time.Time{})
    _ = rc.SetWriteDeadline(time.Time{})

    // 5. Upgrade
    acceptOpts := &websocket.AcceptOptions{InsecureSkipVerify: true}
    if protos := websocket.Subprotocols(r); len(protos) > 0 {
        acceptOpts.Subprotocols = protos
    }
    wsConn, err := websocket.Accept(w, r, acceptOpts)
    if err != nil {
        tcpConn.Close()
        log.Printf("[ERROR] VNC proxy: websocket accept: %v", err)
        return
    }

    nc := websocket.NetConn(r.Context(), wsConn, websocket.MessageBinary)

    // 6. Bridge
    errc := make(chan error, 2)
    go func() { defer tcpConn.Close(); _, err := io.Copy(tcpConn, nc); errc <- err }()
    go func() { defer wsConn.CloseNow(); _, err := io.Copy(nc, tcpConn); errc <- err }()
    <-errc
}
```

Add `"io"` and `"net"` to the import block.
Do NOT modify `authorized()`.

In `Handler()`, add the route without wrapper (it does its own auth):
```go
mux.HandleFunc("/v1/ws/vnc", s.handleVNCProxy)
```

### Step 5 — Client: noVNC desktop screen (depends on Step 4)

**`client/app/desktop.tsx`** — new file. Full implementation:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { WebView } from 'react-native-webview';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import { getConnection, loadConnections, type Connection } from '../src/lib/connection';

function buildDesktopHTML(wsURL: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body,#screen{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000}</style>
</head><body><div id="screen"></div>
<script type="module">
import RFB from 'https://unpkg.com/@novnc/novnc@1.5.0/core/rfb.js';
const rfb = new RFB(document.getElementById('screen'), '\${wsURL}');
rfb.scaleViewport = true;
rfb.resizeSession = true;
</script></body></html>`;
}

export default function DesktopScreen() {
  const { connectionEndpoint } = useLocalSearchParams<{ connectionEndpoint: string }>();
  const [connection, setConnection] = useState<Connection | null>(null);

  useEffect(() => {
    loadConnections().then((store) => {
      setConnection(getConnection(store, connectionEndpoint) ?? null);
    });
  }, [connectionEndpoint]);

  const html = useMemo(() => {
    if (!connection) return '';
    const wsBase = connection.endpoint.replace(/^http/, 'ws').replace(/\\/$/, '');
    return buildDesktopHTML(`\${wsBase}/v1/ws/vnc?token=\${encodeURIComponent(connection.token)}`);
  }, [connection]);

  if (!connection) return <SafeAreaView style={styles.screen}><Text style={styles.text}>Loading...</Text></SafeAreaView>;

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.topbar}>
        <Pressable accessibilityLabel="Back" style={styles.back} onPress={() => router.back()}>
          <Feather name="arrow-left" size={20} color="#F0F0F0" />
        </Pressable>
        <Text style={styles.title}>Remote Desktop</Text>
      </View>
      {Platform.OS === 'web' ? (
        <iframe srcDoc={html} style={{ flex: 1, border: 'none', width: '100%', height: '100%' }} />
      ) : (
        <WebView source={{ html }} originWhitelist={['*']} style={styles.webview}
          javaScriptEnabled mixedContentMode="always" />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0A0A0A' },
  topbar: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12, borderBottomWidth: 1, borderColor: '#262626' },
  back: { padding: 6 },
  title: { color: '#F0F0F0', fontSize: 17, fontWeight: '700' },
  text: { color: '#888', textAlign: 'center', marginTop: 40 },
  webview: { flex: 1, backgroundColor: '#000' },
});
```

### Step 6 — Client: Conditional build flag and navigation (depends on Step 5)

**`client/app/index.tsx`** (line 149, inside the `<View style={styles.actions}>` block):
Add a conditional Desktop button alongside the existing Refresh and Files buttons:
```tsx
{process.env.EXPO_PUBLIC_ENABLE_NOVNC === 'true' && (
  <Pressable accessibilityLabel="Desktop" style={styles.action}
    onPress={() => router.push({ pathname: '/desktop', params: { connectionEndpoint: connection.endpoint } })}>
    <Feather name="monitor" size={18} color="#46B8C4" />
  </Pressable>
)}
```