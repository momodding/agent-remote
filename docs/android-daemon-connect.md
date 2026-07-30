# Run the daemon and connect an Android build

Use this when connecting the Android client to the daemon. Expo Go cannot embed the custom native config (`expo-build-properties`) this app needs for its guarded HTTP fallback, and it cannot dynamically trust or pin a self-signed certificate either. **Build and install a custom dev client or EAS preview APK** (`make client-build-android` or `eas build -p android --profile preview`) instead of using Expo Go for anything beyond the loopback emulator case.

## TLS requirements

For a direct LAN or Tailscale daemon, set `skipFingerprintVerification: true` in the daemon configuration and pairing payload. When that flag is set and the endpoint host is a loopback/private-LAN hostname, the client automatically retries over unencrypted `ws:`/`http:` if the `wss:` handshake fails before completing a frame — see "Guarded HTTP fallback" below. A public endpoint must serve a browser-trusted TLS certificate; the client never falls back to plaintext for a non-local hostname.

## Guarded HTTP fallback (cleartext)

The generated Android manifest sets `usesCleartextTraffic: true` (via the `expo-build-properties` plugin in `client/app.json`) so the client's HTTP fallback is not blocked at the OS level. This only takes effect in a rebuilt APK — reinstalling after `app.json` changes with a plain Metro reload is not enough.

**The fallback is unencrypted and only ever attempted against loopback/private-LAN hosts with `skipFingerprintVerification: true`.** It exists so a direct LAN/Tailscale daemon with an untrusted self-signed cert still works when the OS-level TLS handshake itself fails; it never applies to a public hostname.

## Pairing without a terminal: the `/pairing` browser page

Set `pairingPageUsername`/`pairingPagePassword` in the daemon config to serve the same rotating pairing payload as a Basic Auth-protected browser page at `/pairing` (QR image plus raw JSON), for pairing from a phone that can't see the daemon's terminal output.

1. Open `https://<daemon-host>:8765/pairing` (or `http://` for a plaintext local config) in a browser reachable from the phone.
2. Authenticate with `pairingPageUsername`/`pairingPagePassword` when prompted.
3. Scan the QR shown on that page with the Android app's camera, or copy the raw JSON and paste it — this is the daemon pairing payload, distinct from the Expo Metro QR used to launch the app itself.

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
  "expoPushEndpoint": "https://exp.host/--/api/v2/push/send",
  "pairingPageUsername": "pair",
  "pairingPagePassword": "change-me"
}
JSON
```

The daemon's QR JSON must include:

```json
"skipFingerprintVerification": true
```

### 3. Start the daemon

```sh
builds/daemon/linux-amd64/agenticRemote serve --config examples/config.android.public.json
```

Leave this terminal running. It prints a daemon pairing QR and raw JSON payload; the QR rotates every 45 seconds.

### 4. Point the proxy or tunnel at the daemon

Configure the public endpoint to forward to:

```text
https://127.0.0.1:8765
```

If the proxy requires a trusted origin, configure it to allow the daemon's self-signed origin certificate or give the daemon an origin certificate trusted by the proxy.

### 5. Rebuild and open the app

```sh
make client-build-android
```

Install the resulting APK (`builds/client-android.apk`) on the phone.

### 6. Connect

1. Open the app and enter a device name.
2. Scan the daemon pairing QR — from the terminal output, or from `/pairing` in a browser if `pairingPageUsername`/`pairingPagePassword` are configured — or paste its raw JSON payload.
3. Connect. The pairing payload's `skipFingerprintVerification` setting is used automatically.

## Direct LAN or Tailscale connection

Use this when the phone reaches the daemon directly. The client cannot dynamically pin the daemon's self-signed certificate, so `skipFingerprintVerification` must be `true`.

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
  "expoPushEndpoint": "https://exp.host/--/api/v2/push/send",
  "pairingPageUsername": "pair",
  "pairingPagePassword": "change-me"
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
builds/daemon/linux-amd64/agenticRemote serve --config examples/config.android.direct.json
```

### 4. Rebuild and open the app

```sh
make client-build-android
```

Install the resulting APK on the phone.

1. Open the app and enter a device name.
2. Scan the daemon pairing QR — from the terminal output, or from `/pairing` in a browser — or paste its raw JSON payload.
3. Connect; the pairing payload skips fingerprint verification. If the `wss:` handshake to this host fails outright, the client automatically retries once over unencrypted `ws:`/`http:` (see "Guarded HTTP fallback" above) — this only works in a rebuilt APK, not Expo Go or a stale install.

## Quick failure checks

- Public endpoint: the URL must serve a browser-trusted TLS certificate, and the daemon config and pairing payload must set `skipFingerprintVerification` to `true` when TLS terminates at a proxy or tunnel.
- Direct daemon endpoint: `publicEndpoint` must be the exact host or IP the phone uses, the saved daemon certificate must match that endpoint, and `skipFingerprintVerification` must be `true`.
- Stale pairing payload: scan the newest daemon QR; it rotates every 45 seconds and tokens expire after 2 minutes.
- Cleartext fallback not working: `usesCleartextTraffic` only takes effect in a rebuilt/reinstalled APK — a Metro reload of an old install won't pick it up.
