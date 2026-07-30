# agenticRemote Expo client

This is a managed Expo app. Install Expo Go on the phone before connecting.

## Run

```sh
bun install
bun expo start
```

Open Expo Go and scan the Metro QR to open the app. In the app, enter a device name, then scan the daemon pairing QR or paste its raw JSON payload.

## Commands

```sh
bun run typecheck
bun run test
bun run build:web
bun start
```

## Android build

Expo Go can't embed this app's native Android config (`expo-build-properties`) or dynamically trust a self-signed certificate, so anything beyond the loopback emulator needs a real APK. From the repository root:

```sh
make client-build-android
```

Requires an installed Android SDK with `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) exported to its path. Each run performs a full local EAS/Gradle build in a fresh temp directory (no incremental cache) and compiles native modules for every ABI — expect 15-30+ minutes. The resulting APK lands at `builds/client-android.apk`.

For direct LAN or self-signed daemon endpoints, the pairing payload must set `skipFingerprintVerification: true`; Expo Go cannot dynamically trust or pin the daemon certificate. Public endpoints need a browser-trusted TLS certificate. See `../docs/android-daemon-connect.md` for setup details.
