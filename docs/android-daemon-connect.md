# Run the daemon and connect an Android build

Use this when connecting the Android client to the daemon. Expo Managed apps use Android's platform TLS trust and cannot dynamically trust or pin a daemon's self-signed certificate.

## TLS requirements

Every pairing endpoint must use HTTPS, and every session socket uses WSS. The endpoint certificate must chain to an Android-trusted CA. Use a public TLS endpoint/tunnel, or install an organization CA on managed devices. `skipFingerprintVerification` skips only the app-level fingerprint comparison; it cannot bypass Android's TLS handshake and never enables plaintext HTTP/WS.

## Pairing without a terminal: the `/pairing` browser page

Set `pairingPageUsername`/`pairingPagePassword` in the daemon config to serve the same rotating pairing payload as a Basic Auth-protected browser page at `/pairing` (QR image plus raw JSON), for pairing from a phone that can't see the daemon's terminal output.

1. Open `https://<daemon-host>:8765/pairing` in a browser reachable from the phone.
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
3. Connect. Android still requires the endpoint certificate to chain to a trusted CA.

## Direct LAN or Tailscale connection

Direct connection works only when the daemon presents a certificate Android trusts. A daemon-generated self-signed certificate is insufficient even with `skipFingerprintVerification: true`.

Use one of these paths:

- Put the daemon behind a public HTTPS tunnel or reverse proxy and advertise that HTTPS URL.
- Issue the daemon certificate from an organization CA already installed on managed Android devices.
- Use a Tailscale HTTPS hostname with a certificate trusted by Android, rather than a raw Tailscale IP with a self-signed certificate.

Set `publicEndpoint` to the exact trusted HTTPS URL the phone uses. Keep `allowedCidrs` aligned with the phone or proxy source network. Plain `http://` and `ws://` endpoints are rejected by the client.

## Quick failure checks

- Endpoint must begin with `https://`; plaintext pairing is rejected.
- Certificate must chain to an Android-trusted CA. `skipFingerprintVerification` does not bypass OS TLS trust.
- `publicEndpoint` must be the exact host the phone uses and must match the certificate.
- Stale pairing payload: scan the newest daemon QR; it rotates every 45 seconds and tokens expire after 2 minutes.
