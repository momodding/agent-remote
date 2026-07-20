# Run the daemon and connect from Android

Use this when Android reports `certificate fingerprint mismatch` or `Bad state: client certificate mismatch`.

## Why this happens

The QR payload contains the daemon certificate fingerprint. If your public endpoint is a TLS proxy or tunnel, Android sees the proxy certificate instead of the daemon certificate. That mismatch is expected unless fingerprint verification is explicitly skipped.

## Public endpoint / tunnel setup

Use this for Cloudflare Tunnel, reverse proxy, public-CA HTTPS, or any endpoint where TLS is terminated before the daemon.

### 1. Build the daemon

From the repo root:

```sh
make backend-build
```

### 2. Create an Android public config

Replace `https://remote.example.com` with the exact HTTPS URL Android will scan or paste.

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

Keep `skipFingerprintVerification: true` for public proxy/tunnel endpoints. The QR JSON printed by the daemon must include:

```json
"skipFingerprintVerification": true
```

### 3. Start the daemon

```sh
backend/bin/agenticRemote serve --config examples/config.android.public.json
```

Leave this terminal running. It prints a QR code and a raw JSON payload. The QR rolls every 45 seconds.

### 4. Point your proxy/tunnel at the daemon

Configure your public endpoint to forward to the daemon at:

```text
https://127.0.0.1:8765
```

If your proxy refuses the daemon's self-signed origin certificate, either allow self-signed origin TLS in the proxy or run a local origin certificate that the proxy trusts.

### 5. Rebuild and install the Android app

Use a fresh build so the client has the current fingerprint-bypass logic.

```sh
cd client
flutter clean
flutter pub get
flutter devices
flutter run -d <android-device-id> --dart-define=AGENTICREMOTE_SKIP_FINGERPRINT_VERIFICATION=true
```

For an APK instead:

```sh
cd client
flutter clean
flutter pub get
flutter build apk --debug --dart-define=AGENTICREMOTE_SKIP_FINGERPRINT_VERIFICATION=true
adb install -r build/app/outputs/flutter-apk/app-debug.apk
```

### 6. Connect from Android

1. Open the app on Android.
2. Enter a device name.
3. Scan the daemon QR code, or paste the raw JSON payload.
4. Ensure `Skip fingerprint verification` is checked.
5. Tap `Connect`.
6. In diagnostics, expect `Fingerprint verification skipped` before `Session Established`.

If diagnostics still says `Validating Certificate Fingerprint...` and then fails with a mismatch, the app is not using the bypass path. Reinstall the APK built with `--dart-define=AGENTICREMOTE_SKIP_FINGERPRINT_VERIFICATION=true`, confirm the checkbox is checked, and confirm the QR JSON contains `"skipFingerprintVerification":true`.

## Direct LAN or Tailscale connection without a TLS proxy

Use this only when Android connects directly to the daemon certificate, not through a public TLS proxy.

### 1. Create a direct config

Replace `100.64.1.2` with the host/IP Android can reach.

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
  "skipFingerprintVerification": false,
  "expoPushEndpoint": "https://exp.host/--/api/v2/push/send"
}
JSON
```

### 2. Regenerate TLS if you changed the endpoint

The daemon reuses saved TLS files. If `publicEndpoint` changed for this state directory, remove only that config's TLS files before starting:

```sh
rm -f examples/.agenticremote-android-direct/tls/cert.pem examples/.agenticremote-android-direct/tls/key.pem
```

### 3. Start the daemon

```sh
backend/bin/agenticRemote serve --config examples/config.android.direct.json
```

### 4. Connect from Android

1. Build/run the app normally:

   ```sh
   cd client
   flutter run -d <android-device-id>
   ```

2. Enter a device name.
3. Scan the QR or paste the raw JSON payload.
4. Leave `Skip fingerprint verification` unchecked.
5. Tap `Connect`.

## Quick failure checks

- Public proxy/tunnel endpoint: `skipFingerprintVerification` must be `true` in daemon config, QR JSON, Android build define, or Android checkbox. Use all three while debugging.
- Direct daemon endpoint: `publicEndpoint` must be the exact host/IP Android uses, and the saved daemon TLS cert must have been generated for that endpoint.
- Stale Android app: uninstall/reinstall or run `flutter clean` before rebuilding.
- Stale QR: scan the newest QR; it rotates every 45 seconds and tokens expire after 2 minutes.
