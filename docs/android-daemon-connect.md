# Run the daemon and connect with Expo Go

Use this when connecting an Expo Go client to the daemon from Android.

## TLS requirements

Expo Go cannot dynamically trust or pin the daemon's self-signed certificate. For a direct LAN or Tailscale daemon, set `skipFingerprintVerification: true` in the daemon configuration and pairing payload. A public endpoint must serve a browser-trusted TLS certificate; Expo Go cannot accept a self-signed public certificate.

## Public endpoint or tunnel

Use this for Cloudflare Tunnel, a reverse proxy, or another public TLS endpoint. The public URL must have a browser-trusted certificate. Since TLS terminates before the daemon, skip the daemon fingerprint check.

### 1. Build the daemon

From the repository root:

```sh
make backend-build
```

### 2. Create a public config

Replace `https://remote.example.com` with the exact HTTPS URL the phone will use.

```sh
cat > examples/config.android.public.json <<'JSON'
{
  "listenAddr": "127.0.0.1:8765",
  "listenScheme": "https",
  "publicEndpoint": "https://remote.example.com",
  "stateDir": ".agenticremote-android-public",
  "workspaceRoot": ".",
  "uploadDir": "uploads",
  "allowedCidrs": ["127.0.0.0/8", "::1/128"],
  "maxConnections": 8,
  "maxSessions": 16,
  "channelBufferSize": 256,
  "maxScrollbackBytes": 10485760,
  "allowDestructiveFiles": false,
  "skipFingerprintVerification": true,
  "expoPushEndpoint": "https://exp.host/--/api/v2/push/send"
}
JSON
```

The daemon's QR JSON must include:

```json
"skipFingerprintVerification": true
```

### 3. Start the daemon

```sh
backend/bin/agenticRemote serve --config examples/config.android.public.json
```

Leave this terminal running. It prints a daemon pairing QR and raw JSON payload; the QR rotates every 45 seconds.

### 4. Point the proxy or tunnel at the daemon

Configure the public endpoint to forward to:

```text
https://127.0.0.1:8765
```

If the proxy requires a trusted origin, configure it to allow the daemon's self-signed origin certificate or give the daemon an origin certificate trusted by the proxy.

### 5. Start Expo Go

```sh
cd client
bun install
bun expo start
```

Open Expo Go on Android and scan the Metro QR. This opens the managed app; it is separate from the daemon pairing QR.

### 6. Connect

1. Enter a device name in the app.
2. Scan the daemon pairing QR, or paste its raw JSON payload.
3. Connect. The pairing payload's `skipFingerprintVerification` setting is used automatically.

## Direct LAN or Tailscale connection

Use this when the phone reaches the daemon directly. Expo Go cannot dynamically pin the daemon's self-signed certificate, so `skipFingerprintVerification` must be `true`.

### 1. Create a direct config

Replace `100.64.1.2` with the host or IP the phone can reach.

```sh
cat > examples/config.android.direct.json <<'JSON'
{
  "listenAddr": "0.0.0.0:8765",
  "listenScheme": "https",
  "publicEndpoint": "https://100.64.1.2:8765",
  "stateDir": ".agenticremote-android-direct",
  "workspaceRoot": ".",
  "uploadDir": "uploads",
  "allowedCidrs": ["127.0.0.0/8", "::1/128", "100.64.0.0/10", "192.168.0.0/16", "10.0.0.0/8"],
  "maxConnections": 8,
  "maxSessions": 16,
  "channelBufferSize": 256,
  "maxScrollbackBytes": 10485760,
  "allowDestructiveFiles": false,
  "skipFingerprintVerification": true,
  "expoPushEndpoint": "https://exp.host/--/api/v2/push/send"
}
JSON
```

### 2. Regenerate TLS if the endpoint changed

The daemon reuses saved TLS files. If `publicEndpoint` changed for this state directory, remove only that configuration's TLS files before starting:

```sh
rm -f examples/.agenticremote-android-direct/tls/cert.pem examples/.agenticremote-android-direct/tls/key.pem
```

### 3. Start the daemon

```sh
backend/bin/agenticRemote serve --config examples/config.android.direct.json
```

### 4. Open and pair in Expo Go

```sh
cd client
bun install
bun expo start
```

1. Open Expo Go and scan the Metro QR.
2. Enter a device name.
3. Scan the daemon pairing QR, or paste its raw JSON payload.
4. Connect; the pairing payload skips fingerprint verification.

## Quick failure checks

- Public endpoint: the URL must serve a browser-trusted TLS certificate, and the daemon config and pairing payload must set `skipFingerprintVerification` to `true` when TLS terminates at a proxy or tunnel.
- Direct daemon endpoint: `publicEndpoint` must be the exact host or IP the phone uses, the saved daemon certificate must match that endpoint, and `skipFingerprintVerification` must be `true`.
- Stale pairing payload: scan the newest daemon QR; it rotates every 45 seconds and tokens expire after 2 minutes.
