<!-- source-branch: main -->
<!-- work-branch: omp/cross-platform-build-targets-plan -->
## Context

Update the root `Makefile` so backend daemon and Flutter client builds accept target parameters, can build more than one target in one command, and place artifacts under `./builds/daemon/{target}/` and `./builds/client/{target}/`. The current `Makefile` only has `backend-build` writing `backend/bin/agenticRemote` and `client-build-web` using Flutter's default `client/build/web` output. The backend command path is confirmed as `backend/cmd/agenticRemote`, the Go module is `backend/go.mod`, and the Flutter app has `android/`, `web/`, `windows/`, and `macos/` platform directories.
## Approach

1. Replace the Makefile's build section with parameterized target lists and small POSIX-shell loops, and add `builds/` to the root `.gitignore`; do not add scripts, dependencies, generated docs, or Makefile includes.
   - Keep existing `backend-test`, `client-test`, `test`, `lint`, `run-daemon`, and `run-client` behavior unchanged.
   - Keep `backend-build` and `client-build-web` as public targets so existing README usage does not break.
   - Add `daemon-build` and `client-build` as the new canonical targets; make `backend-build` delegate to `daemon-build` and make `client-build-web` delegate to `client-build CLIENT_TARGETS=web`.
   - Use overridable variables exactly named:
     - `DAEMON_TARGETS ?= linux-amd64`
     - `CLIENT_TARGETS ?= web`
     - `DAEMON_TARGET ?=` and `CLIENT_TARGET ?=` as optional single-target aliases.
     - `GOFLAGS ?=` and `FLUTTER_BUILD_FLAGS ?=` for user-passed extra flags.
   - Define effective lists so either plural or singular works: `DAEMON_BUILD_TARGETS := $(strip $(if $(DAEMON_TARGET),$(DAEMON_TARGET),$(DAEMON_TARGETS)))` and `CLIENT_BUILD_TARGETS := $(strip $(if $(CLIENT_TARGET),$(CLIENT_TARGET),$(CLIENT_TARGETS)))`.

2. Implement `daemon-build` using Go's native cross-compilation and write exactly one binary per daemon target.
   - Supported daemon target literals: `linux-amd64`, `linux-arm64`, `darwin-amd64`, `darwin-arm64`, `windows-amd64`.
   - Also accept user-friendly aliases by mapping them inside the loop before building:
     - `linux` -> `linux-amd64`
     - `macos` -> `darwin-arm64`
     - `macos-amd64` -> `darwin-amd64`
     - `macos-arm64` -> `darwin-arm64`
     - `windows` -> `windows-amd64`
     - `raspberrypi` -> `linux-arm64`
     - `androidbox` -> `linux-arm64`
   - For each normalized target, split the literal at the hyphen into `GOOS` and `GOARCH` using shell parameter expansion, create `builds/daemon/$$target`, and run from `backend/`: `GOOS=$$goos GOARCH=$$goarch CGO_ENABLED=0 go build $(GOFLAGS) -o ../builds/daemon/$$target/agenticRemote$$exe ./cmd/agenticRemote`.
   - Set `exe=.exe` only when `GOOS=windows`; otherwise `exe=`.
   - On an unsupported target, print `unsupported daemon target: <target>` to stderr and exit non-zero before attempting a build.
   - Do not keep writing `backend/bin/agenticRemote`; the requested output root is `./builds/daemon/{target}/`. Existing quickstart commands that run `backend/bin/agenticRemote` may need manual adjustment later, but docs are not part of this request.

3. Implement `client-build` using Flutter's native platform build commands and copy the produced artifact/tree into the requested `builds/client/{target}/` path.
   - Supported client target literals and commands:
     - `web`: run `cd client && flutter build web $(FLUTTER_BUILD_FLAGS) --output ../builds/client/web` because `flutter build web -h` confirms `--output` is supported for web.
     - `android`: run `cd client && flutter build apk $(FLUTTER_BUILD_FLAGS)`, then remove/recreate `builds/client/android` and copy every `client/build/app/outputs/flutter-apk/*.apk` into `builds/client/android/`.
     - `android-arm64`: run `cd client && flutter build apk --target-platform android-arm64 $(FLUTTER_BUILD_FLAGS)`, then remove/recreate `builds/client/android-arm64` and copy every `client/build/app/outputs/flutter-apk/*.apk` into `builds/client/android-arm64/`.
     - `windows`: run `cd client && flutter build windows $(FLUTTER_BUILD_FLAGS)`, then remove/recreate `builds/client/windows` and copy `client/build/windows/x64/runner/Release/` into `builds/client/windows/`.
     - `macos`: run `cd client && flutter build macos $(FLUTTER_BUILD_FLAGS)`, then remove/recreate `builds/client/macos` and copy `client/build/macos/Build/Products/Release/agentic_remote.app` into `builds/client/macos/agentic_remote.app`.
   - Copy APKs with their Flutter-produced filenames (`app-release.apk`, `app-debug.apk`, or split ABI filenames); do not rename them, because build mode and ABI flags change the correct filename.
   - On an unsupported client target, print `unsupported client target: <target>` to stderr and exit non-zero before attempting a build.
   - Use `rm -rf builds/client/<target>` only for the target output directory immediately before web `--output` or artifact copy, so stale files from previous builds do not remain. Do not delete all of `builds/`.

4. Add a `.PHONY` declaration covering all Make targets: `backend-test backend-build daemon-build client-test client-build client-build-web test lint run-daemon run-client`.
   - No helper targets are needed for individual OSes; multiple OSes are handled by `DAEMON_TARGETS="linux-amd64 linux-arm64 windows-amd64"` or `CLIENT_TARGETS="web android"`.

5. Preserve shell portability with only POSIX `sh` constructs already compatible with Make recipe lines: `for target in ...; do`, `case`, `mkdir -p`, `cp -R`, `rm -rf`, parameter expansion, and `exit 1`. Avoid Bash arrays and Make `eval`; they add complexity for no benefit.

6. Add `builds/` to root `.gitignore` next to the existing generated output ignores (`backend/bin/` and `client/build/`) so cross-platform artifacts are not tracked.
## Critical files & anchors

- `Makefile` lines 1-25 — replace existing build targets and add variables/`.PHONY`; keep test, lint, and run target command bodies unchanged.
- `.gitignore` lines 1-10 — add `builds/` next to generated output ignores.
- `backend/cmd/agenticRemote/main.go` package `main` — confirmed Go build entrypoint for daemon binary; no source edits needed.
- `client/pubspec.yaml` lines 1-28 — confirmed Flutter package name `agentic_remote`; no source edits needed.
- `client/macos/Runner/Configs/AppInfo.xcconfig` line 8 — confirmed macOS app bundle name `agentic_remote.app`.
- `client/windows/runner/CMakeLists.txt` lines 4-10 — confirmed Windows build uses the Flutter `BINARY_NAME`; output path remains Flutter default `client/build/windows/x64/runner/Release/`.
## Verification

Run from repository root after editing `Makefile`:

1. Makefile syntax and command expansion proof without requiring cross SDKs:
   - `make -n daemon-build DAEMON_TARGETS="linux-amd64 linux-arm64 windows-amd64"`
   - Expected: printed loop contains builds for `builds/daemon/linux-amd64/agenticRemote`, `builds/daemon/linux-arm64/agenticRemote`, and `builds/daemon/windows-amd64/agenticRemote.exe`.
   - `make -n client-build CLIENT_TARGETS="web android android-arm64 windows macos"`
   - Expected: printed loop contains Flutter commands for `web`, `apk`, `apk --target-platform android-arm64`, `windows`, and `macos`, and copy destinations under `builds/client/web`, `builds/client/android`, `builds/client/android-arm64`, `builds/client/windows`, and `builds/client/macos`.

2. New daemon behavior proof using targets that Go can cross-compile on Linux without extra SDKs:
   - `make daemon-build DAEMON_TARGETS="linux-amd64 linux-arm64 windows-amd64"`
   - Expected files: `builds/daemon/linux-amd64/agenticRemote`, `builds/daemon/linux-arm64/agenticRemote`, `builds/daemon/windows-amd64/agenticRemote.exe`.
   - Run `builds/daemon/linux-amd64/agenticRemote version`; expected output remains `agenticRemote dev` unless the existing version command changes independently.

3. Existing compatibility target proof:
   - `make -n backend-build`
   - Expected: delegates to `daemon-build`, defaulting to `linux-amd64`, not the old `backend/bin/agenticRemote` path.
   - `make -n client-build-web`
   - Expected: delegates to `client-build CLIENT_TARGETS=web`.

4. Client build proof for the platform available on any Flutter workstation:
   - `make client-build CLIENT_TARGETS=web`
   - Expected output directory: `builds/client/web/` contains the built web bundle, including `index.html`.

Do not require successful `client-build` for Android, Windows, or macOS on Linux CI/workstation unless the relevant Flutter native toolchain is installed; the dry-run proof above verifies routing and output paths, while Flutter itself enforces platform availability.
## Assumptions & contingencies

- Target naming is fixed as `os-arch` for daemon outputs and Flutter platform names for client outputs because those are unambiguous and fit the requested `architecture target` directory without adding a separate matrix language.
- `macos` daemon alias builds `darwin-arm64` by default because current macOS hardware is usually Apple Silicon; users needing Intel macOS pass `DAEMON_TARGET=darwin-amd64` or `DAEMON_TARGET=macos-amd64`.
- `android` client output is APK files, not an app bundle, because the request asks for build output and the existing repo plans already use `flutter build apk`; use `FLUTTER_BUILD_FLAGS="--debug"`, `--split-per-abi`, or other Flutter APK flags when a different APK variant is needed.
- If `flutter build windows` or `flutter build macos` reports that desktop support is unavailable on the host OS, leave the Makefile command as planned and treat that as an environment limitation, not a Makefile failure.
