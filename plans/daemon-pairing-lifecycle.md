<!-- omp-source-branch: main -->
<!-- omp-work-branch: omp/daemon-pairing-lifecycle -->
# Context

Four daemon/client defects are coupled around first-run behavior and daemon ownership:

- Android pairing currently starts with the advertised self-signed `https`/`wss` endpoint and only retries local endpoints over cleartext after a transport failure. Both QR scan and JSON paste enter the same client path, so their common failure is transport/configuration, not the input method. The implemented fallback is also invisible in saved connection state and loopback-only `allowedCidrs` can reject a real phone.
- The console and `/pairing` page read one rotating payload but serialize and render it independently. This can produce equivalent data with different JSON text/QR encoding; the hard-coded two-minute credential lifetime is also independent of `pairingRotationSeconds`.
- The web client deliberately sends `cwd: ''`; `session.Manager.Create` interprets that as configured `workspaceRoot`, which is normally relative to the config directory. The daemon host user's home is the correct implicit shell directory.
- The downloaded binary has only `serve`, `config init`, `pair`, and `version`. Existing shell/Make installers are system-scoped and use two unrelated ownership markers; there is no systemd or self-update implementation.

The implementation must keep explicit client-provided session CWD behavior and filesystem workspace confinement unchanged. It must also preserve `/v1/pairing` as an authenticated mint for an independent additional-device credential; that endpoint is intentionally not the rotating presentation shown by console and `/pairing`.

# Approach

## 1. Make the Android cleartext path explicit and diagnosable

1. Refactor endpoint selection in `client/src/lib/api.ts` into a small exported/testable resolver that returns the endpoint actually used for pairing.
   - On Android only, if `skipFingerprintVerification === true` and the advertised hostname passes `isLocalHostname`, resolve `https:` to `http:` before the first REST or WebSocket request. This is the selected “direct guarded HTTP” transport; do not attempt the known-untrusted self-signed TLS path first.
   - Leave `http:` unchanged. Leave non-Android clients, public hostnames, and payloads without the explicit skip flag on the advertised HTTPS endpoint.
   - Continue using the existing mixed TLS/plain daemon listener on the same host/port; do not add a port or protocol field.
   - Return/save the resolved endpoint from `authenticatePairing` so subsequent REST, bootstrap WebSocket, and session WebSocket calls all use the same protocol. The fingerprint remains payload metadata; this change must not claim it is certificate pinning.
2. Retain the current fallback only as a compatibility path for transports not selected up front (for example, a future platform-specific transport error), but make the direct resolver the sole Android/local/skip decision point so it cannot diverge between initial auth and saved connection state.
3. Add structured connection diagnostics in `client/src/lib/api.ts`. The bootstrap auth path is a raw `WebSocket` (`attemptAuth`); browser/RN `WebSocket` never exposes a rejected HTTP response body, so `onerror`/`onclose` alone cannot surface `ErrorEnvelope` JSON. Before dialing the bootstrap socket, issue one unauthenticated `fetch` to the resolved endpoint's `/healthz` (already registered outside `withAuth`, still behind `allowedCIDR`, so this is the correct probe):
   - 200 → proceed to `attemptAuth` unchanged.
   - non-2xx with a parsed `ErrorEnvelope` body → surface its `code`/`message` directly (in particular translate `forbidden_source` into guidance that the daemon `allowedCidrs` must include the phone/LAN subnet; do not automatically broaden daemon CIDRs) and skip the WS attempt entirely — a CIDR rejection will reject the socket identically with no readable body.
   - network-level failure (no response at all) → keep today's `TransportError`/fallback semantics unchanged; this is the existing unreachable-host case, not a new one.
   - Preserve the attempted advertised and resolved endpoint values in double-failure diagnostics.
4. Keep `client/src/components/PairingSheet.tsx` scan and paste handlers unchanged apart from any text needed to describe the explicit cleartext opt-in: both already call one `connect(raw)` path.
5. Extend `client/src/lib/api.test.ts` with table-driven resolver/auth tests: Android local HTTPS + skip resolves directly to HTTP on the first call; Android HTTP stays HTTP; skip false, public host, and non-Android stay HTTPS; successful auth returns the resolved HTTP endpoint; backend `forbidden_source` is surfaced with CIDR guidance; protocol/auth errors do not trigger a second transport attempt. Keep `client/app.json`’s `usesCleartextTraffic: true` and document/test that a rebuilt custom/EAS Android binary is required (Expo Go remains unsupported).

## 2. Publish one canonical rotating pairing presentation

1. Replace `security.PairingSnapshot`’s payload-only value with an immutable presentation value assembled once per rotation. It must contain:
   - a cloned `PairingPayload` for expiry/auth semantics;
   - exactly one compact JSON byte/string value (`json.Marshal` once);
   - exactly one QR representation derived from those exact compact bytes (prefer PNG bytes for the web page and a terminal rendering generated from the same QR object/content for console output).
   Clone byte slices on store/load as the current snapshot clones payloads.
2. Centralize construction in a helper (security or a presentation-focused package) that validates all derived artifacts come from the same compact JSON. `rotatePairing` must create the credential, build the presentation, atomically store it, and then print that stored presentation. `/pairing` must only load and render that presentation; it must not marshal the payload or call `qrcode.Encode` independently.
3. Use the canonical compact JSON verbatim for both console raw JSON and the page’s raw/copyable JSON text. If the page retains pretty formatting, derive it only for visual display and expose/copy the canonical compact value; the QR data must always be the compact value.
4. Keep the rotation publication point as the single refresh boundary. The console output and page change only after the new presentation has been fully built and stored. On construction failure, retain the prior snapshot and log the error; do not publish a partial value.
5. Align credential validity with configured rotation: add a `lifetime time.Duration` parameter to `PairingStore.Create` (replacing the hard-coded `2*time.Minute` at `pairing.go:98`) and thread it through `AuthService.NewPairing` (`auth.go:90-92`, a thin wrapper with the same 4-argument list — it must gain the identical new parameter and pass it straight through). Update every non-test caller: `main.go:248` (`rotatePairing`, using `time.Duration(cfg.PairingRotationSeconds)*time.Second + 5*time.Second` grace) and `server.go:339` (`handlePairingCreate`, same configured lifetime plus grace, even though its payload remains independent of the displayed snapshot). This is a mandatory-parameter signature change, so every direct call site must be updated or the build fails: all seven in `auth_test.go` (lines 18, 36, 59, 85, 98, 117, 148) and the one in `server_test.go:271` (`testBearerToken` helper). The two expiry-boundary tests (`auth_test.go` lines ~97-101 and the cleanup test at ~147-151) must keep using a lifetime shorter than their simulated time advance so the expiry/cleanup assertions still hold. Reject non-positive lifetimes at the API boundary; `config.Validate` already rejects non-positive rotation seconds.
6. Preserve consumption-triggered refresh: after a displayed pairing is consumed, the existing paired hook signals `qrRefresh`, and the next fully constructed presentation becomes both the console and page value.
7. Extend tests:
   - `backend/internal/security/pairing_test.go`: presentation clone behavior, QR/JSON source equality, explicit expiry duration, and invalid duration.
   - `backend/internal/security/auth_test.go`: update all seven `pairings.Create`/`store.Create` call sites (lines 18, 36, 59, 85, 98, 117, 148) for the new lifetime parameter; keep the existing expired-pairing and cleanup assertions meaningful by using a lifetime shorter than each test's simulated time advance.
   - `backend/internal/server/server_test.go:271`: update the `testBearerToken` helper's direct `pairings.Create` call for the new lifetime parameter (distinct from the `session.NewManager` call sites elsewhere in this file).
   - `backend/internal/server/server_test.go`: page HTML's raw JSON and decoded QR payload equal the exact published compact bytes; page stays 503 before first publish; one snapshot replacement atomically changes both values; authenticated `/v1/pairing` still mints a distinct device credential with the aligned lifetime.
   - `backend/cmd/agenticRemote/main_test.go`: console printer emits the canonical compact JSON/presentation rather than re-marshalling.

## 3. Default implicit sessions to the daemon user's home

1. Resolve the daemon host home once at `serve` startup with `os.UserHomeDir()`, normalize it to an absolute/clean path, and fail startup with a clear error if it cannot be resolved or is not a directory. This is deliberately the account running the daemon/service, never a browser- or client-supplied home.
2. Add `defaultCWD string` to `session.Manager` and its `NewManager` constructor. In `Manager.Create`, use `defaultCWD` only when `req.CWD == ""`; retain any explicit request CWD exactly as today and keep recording the selected directory in `Session.CWD`.
3. Pass daemon home from `cmd/agenticRemote/main.go` into `session.NewManager`. Update both server test helper call sites. Do not change `cfg.WorkspaceRoot`, `fs.Service`, upload resolution, or filesystem traversal confinement.
4. Add focused manager tests (create `backend/internal/session/manager_test.go` if it truly does not exist in the implementation checkout) using a harmless short-lived shell command: empty CWD starts in injected home; explicit CWD wins; invalid default home produces a deterministic create/start error. Also assert the web create call remains `cwd: ''` so the server owns the default.

## 4. Add self-managed lifecycle commands under `$HOME/.remote`

Introduce a new internal lifecycle package (for example `backend/internal/lifecycle`) and thin CLI dispatch in `backend/cmd/agenticRemote/main.go` for `install`, `uninstall`, and `update`. Keep old source/archive installer scripts compatible but independent.

### Managed layout and ownership

Use XDG-aware user-systemd paths while keeping all product-managed files under the selected home root:

- managed root: `$HOME/.remote`;
- binary: `$HOME/.remote/bin/agenticRemote`;
- config: `$HOME/.remote/config.json`;
- daemon state: `$HOME/.remote/state` (write `stateDir: "state"` in config);
- workspace root in config: `$HOME` (absolute), while implicit session CWD also uses the separately resolved home;
- ownership manifest/marker: `$HOME/.remote/.agenticremote-managed.json`, containing schema version, install path, service-unit path, installed app version, release URL/version metadata, and hashes of managed binary/unit/config-at-creation;
- user unit: `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/agenticremote.service`.

All path derivation must use `os.UserHomeDir`/`os.UserConfigDir`, clean/absolute validation, no symlink-following for ownership-sensitive targets, temp files in the destination directory, fsync where practical, and atomic rename. Refuse destructive replacement/removal when the marker is absent, malformed, names a different root, or a managed file hash has drifted; provide an explicit `--force` only for replacing/removing drifted files inside these exact managed paths, never arbitrary marker-provided paths.

### `install`

1. Linux-only for service management; return a clear unsupported-platform error elsewhere (the daemon may still run manually on other OSes).
2. Refuse root execution because this is a `systemctl --user` install. Create the managed root/directories with private permissions.
3. Copy the currently executing binary (`os.Executable`, resolving only the executable itself) to a staged file, set executable mode, verify it can run `version`, then atomically install it. This makes the downloaded binary self-installing without requiring a release URL on first install.
4. Create config only when absent. Start from `config.Default`, set state/workspace paths as above, and generate secure non-empty pairing-page Basic Auth credentials (print the generated username/password once). Configure a LAN-usable listen/public endpoint and CIDRs only from explicit flags such as `--listen`, `--public-endpoint`, and repeatable `--allowed-cidr`; otherwise retain loopback-safe defaults and print how to opt into phone/LAN access. Never silently allow all CIDRs.
5. Render a hardened user unit with absolute paths: `ExecStart=<managed binary> serve --config <managed config>`, `Restart=on-failure`, a small restart delay, `WorkingDirectory=$HOME`, and an `Environment=HOME=...` line. Quote/escape systemd arguments safely.
6. Write the marker last, then run `systemctl --user daemon-reload` and `systemctl --user enable --now agenticremote.service`. If service activation fails, keep files for diagnosis and report exact rollback/remediation commands.
7. Check user-manager availability before mutation. Explain that boot-without-login requires the administrator action `loginctl enable-linger <user>`; do not invoke it automatically or with sudo.

### `uninstall`

1. Validate the independent marker and all canonical paths before doing anything.
2. Run `systemctl --user disable --now agenticremote.service`, remove only the matching generated unit, and daemon-reload.
3. Default to preserving config/state and print their location. Add an explicit `--purge` to remove the entire `$HOME/.remote` tree only after marker/path/hash validation; never touch the old `/etc/agenticremote` or `/usr/local/bin` installations/markers.
4. If invoked from the installed binary being removed, allow unlinking it after the process has started; ensure all required data is loaded before removal.

### `update`

1. Require a valid managed installation marker. Support `--version <tag>` and default to a stable release metadata endpoint. Make repository/release base URL overrideable by flag/environment for tests and mirrors; permit HTTPS only outside tests.
2. Detect supported `GOOS/GOARCH`, fetch release metadata plus the matching archive/binary and `SHA256SUMS`, enforce response size/time limits and redirect policy, and verify the exact artifact SHA-256 before extraction. Never execute unverified content. Reuse the archive naming contract produced by release CI; if the repository does not yet publish one, add a release workflow/package target that emits `agenticRemote_<version>_<goos>_<goarch>.tar.gz` and `SHA256SUMS` and injects version/commit into build variables.
3. Change `version` from a compile-time constant to `var version = "dev"` (plus optional commit) so `-ldflags -X` can stamp release builds and update can compare semantic versions. Reject downgrade/same-version by default; allow an explicit `--force`.
4. Stage the verified replacement beside the managed binary, run its `version`, atomically rename it over the old binary, then `systemctl --user restart agenticremote.service`. Keep a `.previous` binary until the new service is healthy (`systemctl --user is-active` with bounded retries); automatically restore and restart the previous version on failure. Update the marker only after health succeeds, then remove the backup.
5. Unit-test downloader/checksum/archive/path logic with `httptest.Server` and injected command runner/filesystem roots; never call the real GitHub service or systemd in tests.

## 5. CLI and compatibility details

- Update usage to `agenticRemote <serve|pair|config|install|uninstall|update|version>` and give each lifecycle command its own `flag.FlagSet` and help.
- Wrap `os/exec.CommandContext` behind a small runner interface so systemctl behavior is deterministic in unit tests. Capture stderr in returned errors.
- Keep `scripts/install.sh`, `scripts/install-daemon.sh`, `scripts/uninstall*.sh`, and Make targets working as legacy system-level/source-checkout flows. Document that their markers and paths are not managed by the new commands; do not try to migrate or delete them.
- Add lifecycle tests for successful install, pre-existing unowned root, malformed/drifted marker, idempotent reinstall, activation failure, preserve-vs-purge uninstall, checksum mismatch, unsupported platform/architecture, rollback after failed health, and command/argument escaping.

# Critical files and anchors

- `client/src/lib/api.ts:76-95` — local-host classification used to gate cleartext.
- `client/src/lib/api.ts:97-220` — auth transport, current post-failure Android fallback, endpoint returned to persistence, and error handling.
- `client/src/lib/api.test.ts:80-280` — existing local-host/fallback matrix to refactor and extend.
- `client/src/components/PairingSheet.tsx:1-158` — scan/paste convergence and skip-verification warning.
- `client/app.json:1-52` — rebuilt Android app cleartext capability.
- `backend/internal/server/server.go:135-159` — `allowedCIDR` and `forbidden_source` response.
- `backend/internal/security/pairing.go:16-52` — payload and payload-only `PairingSnapshot` to replace with canonical presentation.
- `backend/internal/security/auth.go:90-92` — `AuthService.NewPairing` thin wrapper; must gain the same lifetime parameter as `PairingStore.Create`.
- `backend/internal/security/auth_test.go:18,36,59,85,98,117,148` — seven direct `Create` call sites requiring an explicit lifetime argument.
- `backend/internal/server/server_test.go:271` — eighth direct `pairings.Create` call site (`testBearerToken` helper), also requiring the new lifetime argument.
- `backend/internal/security/pairing.go:80-118` — `PairingStore.Create`, including hard-coded two-minute expiry.
- `backend/cmd/agenticRemote/main.go:99-160` — command dispatch/usage/version.
- `backend/cmd/agenticRemote/main.go:163-215` — config-relative paths, auth/session construction, and resolved daemon-home plumbing.
- `backend/cmd/agenticRemote/main.go:242-295` — rotation, publication, timer, and independently generated console QR/JSON.
- `backend/internal/server/server.go:334-345` — authenticated independent `/v1/pairing` mint; keep distinct from rotating presentation while passing explicit lifetime.
- `backend/internal/server/server.go:439-497` — `/pairing` page auth and independent JSON/QR generation to remove.
- `backend/internal/server/server_test.go:243-371` — independent-device pairing test and both `session.NewManager` helper call sites.
- `backend/internal/security/pairing_test.go:1-47` — current snapshot clone tests to migrate to presentation semantics.
- `backend/internal/session/manager.go:81-104` — constructor and empty-CWD fallback.
- `client/app/index.tsx:115-125` — web client intentionally sends `cwd: ''`; no client-home logic belongs here.
- `backend/internal/config/config.go:14-51,119-146` — config fields/defaults and reusable sample-writing behavior.
- `scripts/install-daemon.sh`, `scripts/uninstall-daemon.sh`, `Makefile:46-137` — legacy installers and divergent ownership markers; compatibility-only.
- New: `backend/internal/lifecycle/*_linux.go`, portable manifest/download/version helpers, and package tests; optionally a release workflow under `.github/workflows/` if no artifact contract exists at implementation time.

# Verification

1. Run backend unit/race coverage: `cd backend && go test -race ./...`, then `go vet ./...`.
2. Run client checks: `cd client && bun run typecheck && bun run test`.
3. Build release/lifecycle paths on supported targets: Linux amd64 and arm64 daemon builds with stamped versions; verify checksum manifests and archive names. Compile non-Linux targets to ensure Linux-only lifecycle files have usable unsupported stubs.
4. Pairing integration:
   - Start the daemon with an Android/LAN test config and a rebuilt custom/EAS APK.
   - Generate enough rotations and one consumption-triggered refresh to verify console compact JSON, `/pairing` raw JSON, and decoded QR are byte-for-byte the same within each generation and change together.
   - Scan QR and paste its JSON; both must use direct `http`/`ws` on Android only when local + skip is explicit, authenticate, persist the resolved endpoint, list sessions, and open a session socket.
   - Remove the phone subnet from `allowedCidrs` and verify the app shows `forbidden_source` with remediation rather than a generic TLS/network failure.
   - Verify a public hostname never downgrades and a local payload with skip false remains TLS-only.
5. Session integration: from `/pairing`/web client create a session without CWD and run `pwd`; it must equal the service account’s `$HOME`. Create another session with explicit CWD and verify it wins. Confirm filesystem browse/upload remains rooted at configured `workspaceRoot`.
6. Lifecycle integration in a disposable Linux user/container with an injected fake HOME and user systemd instance:
   - downloaded binary `install` creates only the declared layout, valid config/marker/unit, and enables/starts the user service;
   - login/logout or a boot simulation confirms lingering requirement/documentation;
   - update from a local signed/checksummed test release replaces and restarts successfully;
   - forced health failure rolls back binary and marker version;
   - uninstall preserves state by default; `uninstall --purge` removes only the managed root/unit;
   - legacy `/usr/local/bin` and `/etc/agenticremote` test fixtures remain untouched.

# Assumptions and contingencies

- The selected Android mechanism is explicit direct HTTP/WS for local endpoints only when the pairing payload opts out of fingerprint verification. It provides no confidentiality on the LAN; UI/docs must state this. Native certificate pinning and a second listener are out of scope.
- The daemon’s existing sniffing listener intentionally accepts TLS and plaintext on one port. If implementation testing shows intermediaries or Android networking reject this, stop and revisit the separately configured HTTP-listener alternative rather than silently widening downgrade rules.
- `allowedCidrs` stays deny-by-default/loopback-by-default. Install flags and diagnostics make LAN enablement explicit; no code should infer or auto-authorize an entire interface subnet.
- “Identical QR/JSON” means identical canonical compact JSON bytes are encoded in every QR and exposed as the raw JSON in both console and page for a rotating generation. QR artwork may differ between terminal and PNG because renderers differ.
- `/v1/pairing` remains intentionally independent because it mints another device credential for an already authenticated client; only its lifetime policy is aligned.
- Pairing grace is fixed at five seconds to tolerate clients reading immediately before rotation without retaining credentials for the old hard-coded two minutes.
- Self-management targets Linux user systemd. `loginctl enable-linger` is an external administrator prerequisite for boot-before-login and is never automated.
- The new `$HOME/.remote` marker is independent of existing script/Make markers. There is no automatic migration.
- Default uninstall preserves user data; destructive state removal always requires `--purge` and ownership validation.
- The release URL/repository owner and current archive publication contract are unverified — confirm first during implementation. If no stable GitHub release workflow exists, implement the stated archive/checksum workflow before enabling default-network update.
- The repository may already have acquired `backend/internal/session/manager_test.go`; confirm first and extend it rather than creating a duplicate.
