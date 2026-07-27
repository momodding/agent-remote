<!-- source-branch: main -->
<!-- work-branch: omp/daemon-make-install -->

## Context

Update the root `Makefile` so a server operator can install and remove `agenticRemote`, discover available Make targets, and see exact next commands for configuration initialization and serving after installation. The system-wide default must install the executable under `/usr/local/bin`, manage configuration under `/etc/agenticremote`, and remove the Make-managed binary plus its entire configuration/state tree.

## Approach

1. Extend root `Makefile` variables and target registration for system-wide daemon management.
   - Add `daemon-install`, `daemon-remove`, and `help` to `.PHONY`; keep `backend-test` first so bare `make` retains current behavior.
   - Add overridable path variables exactly as `DAEMON_INSTALL_DIR ?= /usr/local/bin` and `DAEMON_CONFIG_DIR ?= /etc/agenticremote`.
   - Add `override DAEMON_HOST_TARGET := $(shell go env GOHOSTOS)-$(shell go env GOHOSTARCH)` so installation always builds for the current server; cross-compilation remains available only through `daemon-build`.
   - Add the Make shell-quoting helper `shq = '$(subst ','"'"',$(1))'` and pass every path/target expansion used by the new recipes through `$(call shq,...)`, preserving override values containing spaces or shell metacharacters.

2. Add `daemon-install` as one ordered recipe: validate, build, create managed paths, install, and print guidance.
   - Before any build or privileged write, validate `DAEMON_HOST_TARGET` against exactly `linux-amd64|linux-arm64|darwin-amd64|darwin-arm64`; print the unsupported value and exit nonzero otherwise.
   - Validate `DAEMON_INSTALL_DIR` and `DAEMON_CONFIG_DIR` from quoted shell variables. Each must be a non-empty absolute path, must not be `/`, end in `/`, contain `//`, or contain a segment exactly `.` or `..`; additionally require the config path to contain at least two non-empty components below root, such as `/etc/agenticremote`. Implement the shape checks with POSIX `case` and the segment checks by splitting on `/` in a subshell-local `IFS` loop. Print the rejected value and exit nonzero before any other command.
   - Use `<config dir>/.agenticremote-managed-by-make` as an ownership marker. If the config directory already exists without that regular-file marker, refuse installation without modifying it; if absent, create the directory and marker. This makes later recursive deletion explicit and bounded. An existing marked directory is a reinstall and preserves its current `config.json` and state.
   - Invoke `$(MAKE) daemon-build DAEMON_TARGET=<validated host target>` so installation reuses `daemon-build` rather than adding a second Go build path.
   - Use the Unix `install` utility to create the install/config directories with mode `0755`, copy `builds/daemon/<host target>/agenticRemote` to `<install dir>/agenticRemote` with mode `0755`, and create the ownership marker with mode `0644`. Do not initialize or overwrite `config.json` during installation.
   - Print the exact installed binary path and managed config path, followed by labeled copyable commands: `sudo <installed binary> config init --path <config dir>`, `sudo <installed binary> serve --config <config dir>/config.json`, and `<installed binary> version`. Shell-quote paths in displayed commands. Do not list `pair`, because `backend/cmd/agenticRemote/main.go` currently implements it only as an error directing users to `serve`.

3. Add `daemon-remove` as destructive cleanup of Make-managed daemon data; it depends on the marker created by `daemon-install`.
   - Run the identical quoted path validation before deletion.
   - If the config directory exists, require its `.agenticremote-managed-by-make` regular-file marker; otherwise print a refusal and remove neither config nor binary. If the config directory does not exist, continue so removal remains idempotent and can clean a leftover binary.
   - After validation/ownership succeeds, use `rm -f` on `<install dir>/agenticRemote` and `rm -rf` on the config directory, then print both removed paths. Keep the shared install directory itself.
   - Recursive removal intentionally clears `config.json`, the marker, and default relative `.agenticremote` state (TLS identity, pairings/auth, notification tokens, and sessions). Do not inspect `config.json` and follow a customized `stateDir` outside this directory; deleting arbitrary external paths is unsafe and outside Make-managed configuration.

4. Add deterministic `help` output with recipe `printf` calls; do not parse comments or add a script.
   - List every public target with a one-line purpose: `backend-test`, `backend-build`, `daemon-build`, `daemon-install`, `daemon-remove`, `client-test`, `client-build`, `client-build-web`, `client-build-android`, `client-build-ios`, `test`, `lint`, `run-daemon`, `run-client`, and `help`.
   - Include override examples for `DAEMON_TARGETS`, `DAEMON_TARGET`, `CLIENT_TARGETS`, `CLIENT_TARGET`, `GOFLAGS`, `DAEMON_INSTALL_DIR`, and `DAEMON_CONFIG_DIR`.
   - Show `sudo make daemon-install` and `sudo make daemon-remove` as standard system-wide invocations and describe install as host-native. Do not advertise `DAEMON_HOST_TARGET` as an override.

Only `Makefile` changes. Existing release archive scripts remain separate and unchanged; Unix `install` is an explicit server prerequisite.

## Critical files & anchors

- `Makefile` — `.PHONY` and variables at lines 1–10; `daemon-build` at lines 18–36 supplies the native install artifact; lines 60–72 are the insertion region for management/help targets.
- `backend/cmd/agenticRemote/main.go` — `run(args []string)` at lines 106–160 defines the exact installed CLI forms and explicit config-path requirements.
- `backend/internal/config/config.go` — `Default` at lines 34–51 and `CleanState` at lines 119–134 confirm `.agenticremote` is relative to the config directory and that full uninstall requires removing the managed root rather than calling reinitialization cleanup.

## Verification

Run all checks from the repository root on Linux or macOS amd64/arm64; on another host, verify the expected unsupported-host failure and run the positive install/remove proof on a supported host.

1. Run `make help`. Expect exit 0, all 15 public targets, the install/remove targets, standard `sudo` examples, and every documented override variable.
2. Exercise host-native install using paths with spaces without touching system locations:
   ```sh
   tmpdir=$(mktemp -d)
   make daemon-install \
     DAEMON_INSTALL_DIR="$tmpdir/bin with spaces" \
     DAEMON_CONFIG_DIR="$tmpdir/etc/agenticremote config" \
     >"$tmpdir/install.out"
   test -x "$tmpdir/bin with spaces/agenticRemote"
   test -d "$tmpdir/etc/agenticremote config"
   test -f "$tmpdir/etc/agenticremote config/.agenticremote-managed-by-make"
   "$tmpdir/bin with spaces/agenticRemote" version
   ```
   Expect exit 0. `install.out` must name both paths and show safely quoted, copyable `config init`, `serve`, and `version` commands.
3. Exercise the documented initialization, add representative state, and prove removal clears all Make-managed content while retaining the shared binary directory:
   ```sh
   "$tmpdir/bin with spaces/agenticRemote" config init \
     --path "$tmpdir/etc/agenticremote config"
   mkdir -p "$tmpdir/etc/agenticremote config/.agenticremote/auth"
   printf fixture >"$tmpdir/etc/agenticremote config/.agenticremote/auth/pairings.json"
   make daemon-remove \
     DAEMON_INSTALL_DIR="$tmpdir/bin with spaces" \
     DAEMON_CONFIG_DIR="$tmpdir/etc/agenticremote config" \
     >"$tmpdir/remove.out"
   test ! -e "$tmpdir/bin with spaces/agenticRemote"
   test ! -e "$tmpdir/etc/agenticremote config"
   test -d "$tmpdir/bin with spaces"
   ```
   Expect exit 0 and both removed paths in `remove.out`. Repeat the same `daemon-remove`; expect exit 0 to prove idempotence.
4. Prove safety guards run before mutation:
   - Invoke `daemon-remove` with config paths `/`, `/etc`, and `/tmp/../etc/agenticremote`; each must exit nonzero, name the unsafe value, and preserve a fixture binary.
   - Create a safe-shaped, nonempty temp config directory without the marker, point `daemon-remove` to it, and expect refusal plus preservation of both that directory and the fixture binary.
   - Invoke `daemon-install` with the same invalid paths and with an existing unmarked safe config directory; each must fail before build or install.
5. Run `make -n daemon-install` with safe temp-path overrides and inspect that Make expansion has no shell syntax error; then run `make backend-test`. The backend suite must remain green. No client dependency install/test is needed because only daemon Make targets change.

## Assumptions & contingencies

- Installation is system-wide by default, with overridable roots retained for package staging and unprivileged verification.
- Installed executables are always host-native. If `daemon-build` gains another canonical Unix host target before implementation, add it to install validation; never bypass validation or silently install a cross-target artifact.
- `sudo` is shown for config initialization and serving because the default config/state location is under `/etc`; operators using a writable override may omit it.
- Removal owns only the marked config root. A config file pointing `stateDir` elsewhere is removed, but its external state directory is deliberately preserved to avoid unsafe arbitrary deletion.
