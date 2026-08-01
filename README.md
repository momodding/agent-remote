# agenticRemote

## Quickstart

```sh
make backend-build
./builds/daemon/linux-amd64/agenticRemote install
```

`agenticRemote install` creates a managed configuration under `~/.remote/config.json`, places the executable in `~/.remote/bin/agenticRemote`, and registers a Linux user systemd service.

You can also run directly from the compiled binary without installing:

```sh
./builds/daemon/linux-amd64/agenticRemote config init --path examples/config.local.json
./builds/daemon/linux-amd64/agenticRemote serve --config examples/config.local.json
```

`backend-build` (alias for `make daemon-build`) defaults to `DAEMON_TARGETS=linux-amd64`; override with `make backend-build DAEMON_TARGET=<os>-<arch>` (e.g. `darwin-arm64` on Apple Silicon macOS, `windows-amd64` on Windows) — binary always lands at `builds/daemon/<target>/agenticRemote` (`.exe` on Windows).

`serve` starts the HTTPS/WSS daemon, prints a terminal QR immediately, and rotates the pairing payload every 45 seconds. Start the Expo client, then scan that daemon QR in the app or paste the printed raw JSON payload if camera access is unavailable. The daemon also serves the same rotating payload as a browser page at `/pairing` (Basic Auth-protected) for phones that can't run a terminal. See [`docs/android-daemon-connect.md`](docs/android-daemon-connect.md).

Commands to manage an installed daemon:
- `agenticRemote install` – prepares managed layout under `~/.remote`, writes systemd user unit, enables/starts it. Supports flags: `--listen`, `--public-endpoint`, `--allowed-cidr`, `--workspace-root`, `--state-dir`.
- `agenticRemote update` – pulls latest release archive, verifies SHA256 checksums, updates, restarts systemd service with health-check rollback.
- `agenticRemote uninstall` – disables/removes systemd service and binary. Use `--purge` to delete the `~/.remote` tree.

## Session CWD Defaults
When the client requests a session with an empty workspace path `cwd: ''`, the daemon defaults the session shell directory to the daemon host account's `$HOME` folder. Explicit paths requested by clients are respected.

## Android Pairing & Guarded Fallback
Pairing uses a unified rotation mechanism generating synchronous terminal/page presentations:
1. Android clients scan/paste a pairing payload with `skipFingerprintVerification: true`.
2. Host resolver detects loopback/LAN hostnames and maps the connection protocol to unencrypted `http`/`ws` directly.
3. Client probes `/healthz` before dialing WebSocket to surface network/CIDR blocks directly (e.g. `forbidden_source`).

Expo client:

```sh
cd client
bun install
bun expo start
```

Open Expo Go and scan the Metro QR to launch the managed app. In the app, enter this device's name, then scan the daemon QR or paste its raw pairing payload.

Or from the repository root:

```sh
make run-client
```

## Android build

Expo Go cannot embed this app's native Android config, so connecting beyond the loopback emulator needs a real APK:

```sh
make client-build-android
```

Requires an installed Android SDK with `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) exported to its path. Each run performs a full local EAS/Gradle build in a fresh temp directory (no incremental cache) and compiles native modules for every ABI — expect 15-30+ minutes. The resulting APK lands at `builds/client-android.apk`. See [`docs/android-daemon-connect.md`](docs/android-daemon-connect.md) for pairing and TLS setup.
