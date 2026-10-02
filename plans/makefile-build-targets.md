<!-- omp-source-branch: main -->
<!-- omp-work-branch: omp/makefile-build-targets -->
# Fix Makefile client and daemon build targets

## Context

`make client-build-android` fails. The `android` arm of the `client-build` recipe
(`Makefile:173`) shells out to `bunx eas-cli build --platform android --profile preview
--local`. The eas-cli local-build path calls `isAtLeastNpm7Async`, which spawns `npm
--version`. On this host that spawn fails with `spawn npm ENOENT`.

Evidence collected:

- `~/.hermes/node/bin/` contains a real `node` binary plus dangling symlinks `npm ->
  ../lib/node_modules/npm/bin/npm-cli.js` and `npx -> ../lib/node_modules/npm/bin/npx-cli.js`.
  `~/.hermes/node/lib/` is empty, so both symlinks resolve to nothing.
- `PATH="$HOME/.hermes/node/bin:$PATH" npm --version` -> `error: command not found: npm`.
- `make -p | grep ^SHELL` -> `SHELL := /bin/sh`; `sh -c 'command -v npm'` prints nothing,
  so the failure reproduces under Make's own shell.
- No `yarn`, `pnpm`, or `corepack` is usable either; `client/` has only `bun.lock`.
- The one prior record of this failure in the repo is
  `e2e-lab/artifacts/runtime-verification/acceptance-ledger-20260929.md:123`:
  "**Android**: `make client-build-android` exited **2**. EAS reached project compression
  and failed with `spawn npm ENOENT`".
- `builds/android-npm-provision.log` records npm 10.9.7 being provisioned at
  20260930T051112Z; that install is gone now, which is why the target used to pass and
  no longer does.

The SDK guard at `Makefile:173` is not the cause. `client-build-android` (`Makefile:183`)
passes `ANDROID_HOME`/`ANDROID_SDK_ROOT` as command-line Make variables, and GNU Make
auto-exports those, so the guard passes before the eas-cli failure.

A second, independent defect: `ENABLE_NOVNC` / `EXPO_PUBLIC_ENABLE_NOVNC` is a dead knob.
It is defined at `Makefile:5` and threaded into `Makefile:172`, `:173`, `:174`, and
advertised at `Makefile:255` as "disables the Desktop/noVNC button in client builds".
Nothing consumes it:

- `grep -rn "EXPO_PUBLIC_ENABLE_NOVNC" client/src client/app client/scripts` -> no matches.
- `grep -rn "process.env" client/src client/app client/index.ts client/scripts` -> no matches.
- There is no `client/app.config.*`; `client/app.json` `.expo.extra` is only
  `{router:{}, eas:{projectId:"3ce75888-9686-4b11-bd78-6514de0391cf"}}`.
- `client/eas.json` `preview.env` contains only `GRADLE_OPTS`.
- `client/scripts/build-novnc.ts` (33 lines) unconditionally bundles `@novnc/novnc`'s
  `rfb.js` into `client/src/generated/novnc_script.ts`, and runs from the
  `postinstall` hook in `client/package.json`.

So `ENABLE_NOVNC=false` ships the Desktop button anyway, and the help text is false.

Replacement approach: drive the Android build through the already-prebuilt Gradle project
at `client/android/` instead of eas-cli, removing the npm dependency entirely.

Grounding for that approach:

- `cd client/android && ANDROID_HOME=$HOME/android-sdk ANDROID_SDK_ROOT=$HOME/android-sdk
  ./gradlew --version` succeeds: Gradle 9.3.1, Kotlin 2.2.21, Groovy 4.0.29, Launcher JVM
  17.0.2, daemon JVM `/home/momodding/.vfox/cache/java/v-17.0.2+8/java-17.0.2+8`.
- `~/android-sdk` contains `platforms/android-36`, `build-tools/35.0.0` and `36.0.0`,
  `ndk/27.1.12297006`, `cmake/3.22.1`, `platform-tools`, and `licenses`.
- `client/android/app/build.gradle:100-123` declares only a `debug` signingConfig
  (`storeFile file('debug.keystore')`, storePassword/keyPassword `android`, keyAlias
  `androiddebugkey`), and **both** the `debug` and `release` buildTypes use
  `signingConfig signingConfigs.debug`. A gradle-direct `assembleRelease` therefore
  produces an installable, signed APK with no EAS credentials.
- `client/android/` is untracked build output: `git ls-files client/android` is empty and
  the path is gitignored. The recipe must regenerate it when absent.
- `client/android/local.properties` does not exist, so the SDK location must be supplied
  through the environment rather than that file.
- `client/eas.json` `preview.env.GRADLE_OPTS` sets `-Xmx6144m
  -XX:MaxMetaspaceSize=1024m -XX:+UseG1GC`, `org.gradle.parallel=true`,
  `org.gradle.caching=true`, `org.gradle.workers.max=8`, whereas
  `client/android/gradle.properties` only sets `-Xmx2048m -XX:MaxMetaspaceSize=512m`.
  The gradle-direct recipe must re-supply the larger heap or the Hermes/bundle step can OOM.
- `client/android/gradle.properties` sets `reactNativeArchitectures=arm64-v8a,x86_64`,
  matching `client/app.json`'s `buildArchs`, so no extra arch flag is needed.
- `client/node_modules` is installed and `client/src/generated/novnc_script.ts` exists.

`scripts/verify-and-package.sh` is a consumer of these targets and must keep working:
line 43 runs `make daemon-release DAEMON_BUILD_DIR="$bundle/daemon"
DAEMON_RELEASE_DIR="$bundle/archives"`, and line 49 runs `make client-build-android
CLIENT_ANDROID_OUTPUT="$bundle/android/agenticRemote-android-${short_sha}.apk"`. The
variable names `DAEMON_BUILD_DIR`, `DAEMON_RELEASE_DIR`, and `CLIENT_ANDROID_OUTPUT` are
therefore a fixed contract and must not be renamed.

A verification run of `cd client/android && ANDROID_HOME=$HOME/android-sdk
ANDROID_SDK_ROOT=$HOME/android-sdk ./gradlew assembleRelease --console=plain` was started
during planning and had not finished when planning ended. Its outcome is the single
gating unknown — *unverified: confirm the gradle-direct release build produces
`client/android/app/build/outputs/apk/release/app-release.apk` before relying on step 3.*

Separately, both build loops are written without `set -e` and use bare `cd X && ... && cd ..`
to return to the repo root. When an inner command fails, the trailing `cd ..` never runs, so
the next loop iteration executes from the wrong directory and reports a misleading error
instead of the real one. Both loops get `set -eu` plus subshell isolation.

## Desired End State

- `make client-build-android` produces a signed release APK at `CLIENT_ANDROID_OUTPUT`
  without requiring `npm`, `npx`, or an EAS account.
- `make client-build-android CLIENT_ANDROID_OUTPUT=<path>` still honours the path, so
  `scripts/verify-and-package.sh` is unchanged and still works.
- `make client-build-web`, `make daemon-build`, `make daemon-release`, and
  `make backend-build` behave as before, with failures surfacing the real error.
- No dead `ENABLE_NOVNC` plumbing and no false help text remains.

## Approach

### 1. Variable block (`Makefile:3-28`)

- Delete `ENABLE_NOVNC ?= true` (`Makefile:5`).
- Add, next to the other client variables:
  - `CLIENT_ANDROID_SDK ?= $(HOME)/android-sdk`
  - `CLIENT_ANDROID_VARIANT ?= release`
  - `CLIENT_ANDROID_GRADLE_OPTS ?= -Dorg.gradle.jvmargs=-Xmx6144m -XX:MaxMetaspaceSize=1024m -XX:+UseG1GC -Dorg.gradle.parallel=true -Dorg.gradle.caching=true -Dorg.gradle.workers.max=8`
    (the value is copied from `client/eas.json` `preview.env.GRADLE_OPTS`; keep it as a
    single Make variable so callers can override the whole string).
- Add `CLIENT_ANDROID_SDK_PATH := $(abspath $(CLIENT_ANDROID_SDK))` beside the existing
  `*_OUTPUT_PATH` abspath variables at `Makefile:17-19`.

### 2. `client-build` web arm (`Makefile:172`)

Rewrite as a subshell with no dead env var:

```
web) ( cd client && bun install && bun run build:web ) ;; \
```

### 3. `client-build` android arm (`Makefile:173`)

Replace the entire eas-cli invocation. The new arm must, in order:

1. Verify the SDK: if `$(CLIENT_ANDROID_SDK_PATH)` is not a directory, print
   `android SDK not found at <path>; set CLIENT_ANDROID_SDK to an installed Android SDK`
   to stderr and `exit 1`.
2. `mkdir -p "$(dir $(CLIENT_ANDROID_OUTPUT_PATH))"`.
3. `cd client` and run `bun install` (this also regenerates
   `src/generated/novnc_script.ts` via the `postinstall` hook).
4. If `client/android/gradlew` is absent, regenerate the native project with
   `CI=1 bunx expo prebuild --platform android --no-install`. Use `--no-install` because
   `bun install` already ran and because `expo prebuild`'s default installer path would
   reintroduce the npm dependency this change exists to remove.
5. Write `client/android/local.properties` containing
   `sdk.dir=$(CLIENT_ANDROID_SDK_PATH)` if that file does not already exist. This keeps
   plain `./gradlew` runs outside Make working too.
6. Run the build from `client/android`:
   `ANDROID_HOME=$(CLIENT_ANDROID_SDK_PATH) ANDROID_SDK_ROOT=$(CLIENT_ANDROID_SDK_PATH) GRADLE_OPTS=$(call shq,$(CLIENT_ANDROID_GRADLE_OPTS)) ./gradlew assembleRelease --console=plain -x lintVitalRelease`
   Exclude exactly `lintVitalRelease`, the root lint-vitals task, and nothing else. This
   is a correctness requirement, not an optimisation, and the precise task name matters:
   AGP wires lint vitals into `assembleRelease`, it emits no build artifact, and a
   measured cold run spent the bulk of a 50-minute wall clock inside
   `:react-native-gesture-handler:lintVitalAnalyzeRelease`. Excluding the two leaf tasks
   `lintVitalAnalyzeRelease` and `lintVitalReportRelease` instead does **not** work: it
   leaves `:app:lintVitalRelease` scheduled, and that task then fails Gradle input
   validation because its `returnValueInputFile` and `textReportInputFile` inputs
   (`app/build/intermediates/lint_vital_return_value/release/...` and
   `.../lint_vital_intermediate_text_report/release/...`) are produced by the tasks that
   were just excluded. Excluding the root task prunes the whole subtree cleanly. Lint
   stays a separate concern; `make lint` remains the lint entry point.
   For `CLIENT_ANDROID_VARIANT=debug`, call `assembleDebug` instead and omit the
   exclusion entirely: derive both the assemble task name and the presence of the
   `-x lintVital<Variant>` flag from the variant rather than hardcoding two branches,
   and note that lint vitals only attach to the release variant.
7. Copy the produced APK to the requested output path:
   `cp client/android/app/build/outputs/apk/$(CLIENT_ANDROID_VARIANT)/app-$(CLIENT_ANDROID_VARIANT).apk "$(CLIENT_ANDROID_OUTPUT_PATH)"`.
   If the source APK is missing after a successful Gradle run, print
   `gradle reported success but no APK at <path>` to stderr and `exit 1`.
8. Echo the final output path.

Use a subshell for the directory changes and indent the arm with a **tab**, matching its
sibling arms. The current line 173 is indented with spaces, which is inconsistent with
lines 172 and 174.

### 4. `client-build` ios arm (`Makefile:174`)

This arm has the same latent `npm ENOENT` defect, and `eas-cli --local` for iOS cannot run
on this Linux host at all. Keep the eas-cli call (there is no gradle equivalent) but make
the failure legible instead of a deep stack trace:

- If `uname -s` is not `Darwin`, print `client-build ios requires macOS` to stderr and `exit 1`.
- Otherwise, if `command -v npm` fails, print
  `eas-cli local builds require npm on PATH; install Node.js with npm and retry` to stderr
  and `exit 1`.
- Then run the existing command minus `EXPO_PUBLIC_ENABLE_NOVNC`, inside a subshell.

### 5. `client-build` loop body (`Makefile:169-177`)

Start the recipe with `@set -eu; \` so a failing target aborts the loop immediately, and
wrap each arm's directory change in `( ... )` so no arm depends on a trailing `cd ..`.

### 6. `client-build-android` (`Makefile:182-183`)

Drop the `ANDROID_HOME`/`ANDROID_SDK_ROOT` overrides; SDK resolution now lives in
`CLIENT_ANDROID_SDK`. The target becomes:

```
client-build-android:
	$(MAKE) client-build CLIENT_TARGETS=android
```

`CLIENT_ANDROID_OUTPUT` continues to pass through from the command line unchanged, which
is what `scripts/verify-and-package.sh:49-50` relies on.

### 7. `daemon-build` loop (`Makefile:36-54`)

Add `@set -eu; \` as the first line and change line 53 to run in a subshell:

```
	( cd backend && GOOS=$$goos GOARCH=$$goarch CGO_ENABLED=0 go build $(GOFLAGS) -ldflags "-X main.version=$(VERSION) -X main.commit=$(COMMIT)" -o "$(DAEMON_BUILD_OUTPUT_DIR)/$$target/agenticRemote$$exe" ./cmd/agenticRemote ); \
```

This removes the `cd ..`-on-success-only hazard. No variable names change, so
`daemon-release` (`Makefile:60`) and `scripts/verify-and-package.sh:43-45` are unaffected.

### 8. Help text (`Makefile:243-260`)

- Delete the `ENABLE_NOVNC=false ...` line (`Makefile:255`); it documents a knob that
  never worked.
- Amend the `client-build-android` line to mention the Gradle path and the two new knobs,
  e.g. `client-build-android  build a signed release APK via Gradle (CLIENT_ANDROID_SDK/CLIENT_ANDROID_OUTPUT)`.

## Critical Files

|File|Lines|Change|
|---|---|---|
|`Makefile`|5|delete `ENABLE_NOVNC ?= true`|
|`Makefile`|17-19|add `CLIENT_ANDROID_SDK_PATH` abspath|
|`Makefile`|3-16|add `CLIENT_ANDROID_SDK`, `CLIENT_ANDROID_VARIANT`, `CLIENT_ANDROID_GRADLE_OPTS`|
|`Makefile`|36-54|`set -eu` + subshell in `daemon-build`|
|`Makefile`|169-177|`set -eu`, subshell arms, rewritten android arm, ios preflight|
|`Makefile`|182-183|simplify `client-build-android`|
|`Makefile`|243-260|help text corrections|

No file outside `Makefile` is modified. `client/android/local.properties` is generated at
build time and is already gitignored.

## Verification

1. `make client-build-android` — must exit 0 and leave an APK at `builds/client-android.apk`.
2. `unzip -l builds/client-android.apk | grep AndroidManifest.xml` — confirms a real APK,
   mirroring the check recorded in `builds/android-package-validation-20260930.log`.
3. `make client-build-android CLIENT_ANDROID_OUTPUT=/tmp/ar-test/out.apk` — must create
   `/tmp/ar-test/` and write the APK there, proving the
   `scripts/verify-and-package.sh:49-50` contract still holds.
4. `make client-build-android CLIENT_ANDROID_SDK=/nonexistent` — must fail fast with the
   SDK message and never invoke Gradle.
5. `make client-build-web` — must exit 0 and produce `client/dist`.
6. `make daemon-build` — must exit 0 and write `builds/daemon/linux-amd64/agenticRemote`.
7. `make daemon-build DAEMON_TARGETS="linux-amd64 windows-amd64"` — both binaries present,
   Windows one with the `.exe` suffix.
8. `make daemon-build DAEMON_TARGETS=bogus-target` — must exit non-zero with
   `unsupported daemon target: bogus-target`.
9. `make daemon-release DAEMON_BUILD_DIR=/tmp/ar-rel/daemon DAEMON_RELEASE_DIR=/tmp/ar-rel/archives`
   — archives plus `SHA256SUMS` present under `/tmp/ar-rel/archives`.
10. `grep -rn "ENABLE_NOVNC" Makefile` — must return nothing.
11. `make help` — must not advertise the removed knob.

## Assumptions and Contingencies

- **Gating assumption:** the gradle-direct `assembleRelease` run succeeds on this host.
  *unverified — confirm first* by running
  `cd client/android && ANDROID_HOME=$HOME/android-sdk ANDROID_SDK_ROOT=$HOME/android-sdk ./gradlew assembleRelease --console=plain`
  and checking for `client/android/app/build/outputs/apk/release/app-release.apk`.
  If that build fails for a reason specific to the stale prebuild output (not to the
  approach), delete `client/android/` and let step 3.4's `expo prebuild` regenerate it,
  then retry once before changing approach.
- If the build OOMs despite `CLIENT_ANDROID_GRADLE_OPTS`, raise `-Xmx` in that single
  variable rather than editing `client/android/gradle.properties`, which is regenerated by
  `expo prebuild`.
- `expo prebuild` regenerates `client/android/`, discarding any manual edits there. That is
  acceptable because the directory is untracked and gitignored; the signing config that
  makes this work comes from Expo's own template.
- The release APK is signed with the bundled debug keystore
  (`client/android/app/debug.keystore`). It installs and runs, but it is not a
  distribution-grade signature. This matches the pre-existing project configuration at
  `client/android/app/build.gradle:112-115` and is not changed here.
</content>
