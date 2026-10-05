# Android E2E Execution Contract & Todo Backlog

## Iteration Log
## Iteration 30 — Podman-Only Storage Preflight (Sudoers-Scope Fix)
- GOAL: Fix the sudoers/harness mismatch from Iteration 29: the host sudoers NOPASSWD rule authorizes only the Podman binary (`sudo -n -l` → `(root) NOPASSWD: /home/linuxbrew/.linuxbrew/bin/podman`), not `/usr/bin/id` or `/usr/bin/df`, so the prior separate `sudo -n -- id -u` / `sudo -n -- df` calls always failed closed regardless of actual rootful storage health.
- RESULT: PASS. `checkAndroidStorage()` now returns `PASS` through the canonical rootful runner context alone.
- PROBES_PERFORMED: `sudo -n -- podman unshare id -u` → `Error: please use unshare with rootless` (exit 125; unshare is rootless-only, not usable here). Direct unprivileged `df -B1 ... /var/lib/containers/storage` → `Permission denied` (confirms the invoking user cannot traverse the 0700 root-owned GraphRoot without Podman's own root-privileged access). Containerized `df` via `podman run --volume ...:ro` was also attempted and found blocked by an unrelated OCI runtime (`crun`) version mismatch in this environment (`Error: OCI runtime error: crun: unknown version specified`), which further motivated avoiding any `podman run`-based workaround.
- IMPLEMENTATION: `android/android-runner.ts` `selectAndroidStorageContext(info, executable)` now derives rootful identity from `host.security.rootless` (Podman's own effective-UID-derived rootless/rootful determination; `rootless === false` is accepted as proof of root execution) and derives GraphRoot capacity from `store.graphRootAllocated - store.graphRootUsed` (Podman's own root-privileged statfs of the GraphRoot, taken while already running as root under the single authorized `sudo -n -- podman` invocation). `checkAndroidStorage()` now issues exactly one command: `sudo -n -- "$E2E_PODMAN_BIN" info --format '{{json .}}'`. No `id` or `df` subprocess is spawned anywhere in the preflight.
- REGRESSION_COVERAGE: `bun run android/storage-preflight.test.ts` passes, including a new test proving the injected executor receives exactly one call (the authorized Podman executable) and a new test proving missing `graphRootAllocated`/`graphRootUsed` fields block with `BLOCKED_STORAGE_CONTEXT` rather than crashing or fabricating a capacity figure.
- STATIC_CHECK: `bun build android/android-runner.ts android/storage-preflight.test.ts --target=bun --outdir /tmp/android-storage-preflight-build2` passed.
- MINIMAL_INVOCATION_RESULT: `PASS`, `rootless=false`, `graphRoot=/var/lib/containers/storage`, `runRoot=/run/containers/storage`, `availableBytes=120557006848`, `requiredBytes=8372800000`. No Compose command, Android emulator, or Golden Flow was run.
- ARTIFACT: `artifacts/runtime-verification/android-storage-preflight-podman-only-20261002T065917Z.json`. The prior `android-storage-preflight-20261002T063123Z.json` (Iteration 29, `BLOCKED_STORAGE_CONTEXT`) is retained unmodified as historical evidence of the authorization-scope bug this fix corrects.
- PROVENANCE: HEAD before this fix `b31bce74a03e6c20a4f22c3d4de99e0164123fd5`; retained APK `artifacts/android-b04-x86-app-debug.apk` SHA-256 `737c630ee279f6445b111e58984e05085a1f354444da5710d0041f2da780b8d0`; pinned Android image `budtmo/docker-android:emulator_14.0_v3.7.0-p0@sha256:7826cd345543736c9502293926f383af4ca9caf96bd47d12d15bce8d31fd9894`.
- NON_ACTIONS: No Compose command, Android emulator, Golden Flow, or Podman resource create/start/stop/restart/prune/delete was run.
- DATE: 2026-10-02T06:59:17Z

## Iteration 29 — Canonical Storage Preflight Execution
- GOAL: Execute only `checkAndroidStorage()` through the current canonical rootful runner context and capture verification provenance without starting Android.
- RESULT: BLOCKED_STORAGE_CONTEXT (not PASS).
- CURRENT_FAILURE: `sudo -n -- id -u` returned `sudo: a password is required`; the harness therefore correctly failed closed before it could record a measured effective UID or execute rootful `df`.
- RECONCILIATION: This is a sudo authorization/context blocker, not a capacity blocker. The retained authoritative rootful capacity observation is `106,796,941,312` bytes available against `8,372,800,000` required.
- ARTIFACT: `artifacts/runtime-verification/android-storage-preflight-20261002T063123Z.json`.
- PROVENANCE: HEAD `17d8f78709f1feb6a84c0a146dc8bff6e383cd08`; worktree clean; retained APK `artifacts/android-b04-x86-app-debug.apk` SHA-256 `737c630ee279f6445b111e58984e05085a1f354444da5710d0041f2da780b8d0`; pinned Android image `budtmo/docker-android:emulator_14.0_v3.7.0-p0@sha256:7826cd345543736c9502293926f383af4ca9caf96bd47d12d15bce8d31fd9894`.
- NON_ACTIONS: No Compose command, Android emulator, Golden Flow, or Podman resource operation was run.
- DATE: 2026-10-02T06:31:23Z

## Iteration 28 — Rootful GraphRoot Capacity Query
- GOAL: Measure the reported rootful Podman `GraphRoot` without relying on invoking-user filesystem traversal permissions.
- RESULT: PASS (focused deterministic harness coverage; Android emulator and Golden Flow were not started).
- IMPLEMENTATION: `android/android-runner.ts` now executes `/usr/bin/df -B1 --output=source,target,avail <reported-GraphRoot>` through the same injected rootful `sudo -n --` executor as Podman info and UID measurement. It retains the exact machine-reported `GraphRoot` and existing byte parsing/threshold semantics.
- REGRESSION_COVERAGE: `bun run android/storage-preflight.test.ts` passes, including a fake rootful executor that supplies a root-only graph root and asserts `/usr/bin/df` is dispatched to that executor rather than invoking bare host `df`.
- STATIC_CHECK: `bun build android/android-runner.ts android/storage-preflight.test.ts --target=bun --outdir /tmp/android-storage-preflight-build` passed.
- EVIDENCE: `artifacts/runtime-verification/android-golden-flow-storage-reconciliation-20261002T060512Z.md`.
- DATE: 2026-10-02T06:26:01Z

## Iteration 27 — Measured Rootful Storage UID
- GOAL: Prove the Android storage preflight is running as the effective rootful UID rather than assuming UID zero.
- RESULT: PASS (focused deterministic harness coverage; Android emulator and Golden Flow were not started).
- IMPLEMENTATION: `android/android-runner.ts` runs `sudo -n -- id -u` in the same sudo rootful invocation form used for the canonical Podman query, parses the measured UID, and returns `BLOCKED_STORAGE_CONTEXT` when measurement fails, is malformed, or is nonzero.
- REGRESSION_COVERAGE: `bun run android/storage-preflight.test.ts` passes including nonzero measured UID rejection.
- STATIC_CHECK: `bun build android/android-runner.ts android/storage-preflight.test.ts --target=bun --outdir /tmp/android-storage-preflight-build` passed.
- EVIDENCE: `artifacts/runtime-verification/android-golden-flow-storage-reconciliation-20261002T060512Z.md`.
- DATE: 2026-10-02T06:23:24Z

## Iteration 26 — Canonical Rootful Storage Preflight
- GOAL: Gate Android emulator/build startup on available capacity for the rootful Podman `GraphRoot` selected by `scripts/compose.sh`.
- RESULT: PASS (focused deterministic harness coverage; Android emulator and Golden Flow were not started).
- ROOT_CAUSE: The former rootful-capacity blocker was a `TEST_HARNESS_BUG`: it promoted an in-emulator filesystem observation into a rootful Podman graph-root prerequisite without resolving the canonical rootful `GraphRoot`.
- IMPLEMENTATION: `android/android-runner.ts` queries `sudo -n -- "$E2E_PODMAN_BIN" info --format '{{json .}}'`, records rootful context (`uid=0`, executable, effective storage config, `GraphRoot`, `RunRoot`, filesystem/mount, available/required bytes), and blocks before KVM/emulator work when context is invalid or `available < 8,372,800,000`.
- CONTEXT_RULE: The check uses the same `E2E_PODMAN_BIN` default and rootful `sudo -n --` invocation as `scripts/compose.sh`; it derives storage paths from machine-readable rootful Podman info and does not hard-code `/var/lib` or use legacy `.runtime` storage state.
- EVIDENCE: Authoritative manual observations retained in `artifacts/runtime-verification/android-golden-flow-storage-reconciliation-20261002T060512Z.md`: rootless `GraphRoot` available `106,917,838,848` bytes; rootful `GraphRoot` available `106,796,941,312` bytes; Android prerequisite `8,372,800,000` bytes. The rootful value exceeds the prerequisite by `98,424,141,312` bytes.
- REGRESSION_COVERAGE: `bun run android/storage-preflight.test.ts` passes rootful/exact-threshold, rootless rejection, project-local reported-`GraphRoot` preservation, and one-byte-insufficient cases.
- STATIC_CHECK: `bun build android/android-runner.ts android/storage-preflight.test.ts --target=bun --outdir /tmp/android-storage-preflight-build` passed. No repository lint configuration is present; standalone `tsc` could not run because the project does not install `node`/`bun-types` type definitions.
- FILES_CHANGED: `android/android-runner.ts`, `android/storage-preflight.test.ts`, `ANDROID_E2E_TODO.md`, `artifacts/runtime-verification/android-golden-flow-storage-reconciliation-20261002T060512Z.md`.
- DATE: 2026-10-02T06:17:56Z

## Iteration 25 — Rootful Podman Authorization Repair
- GOAL: Canonicalize the rootful Podman command and make authorization probes exercise Podman and Podman Compose.
- RESULT: PASS (static audit and doctor validation; no Compose or product test run).
- FILES_CHANGED: `scripts/compose.sh`, `doctor/system-doctor.ts`, `env/e2e.env.example`, `README.md`, `ANDROID_E2E_TODO.md`.
- CANONICAL_COMMAND: `sudo -n "$E2E_PODMAN_BIN"`, where `E2E_PODMAN_BIN` defaults to `/home/linuxbrew/.linuxbrew/bin/podman`.
- DOC-05_REPAIR: Doctor PATH now includes the existing lab-local `.runtime/platform-tools` path, matching the Android runner's deterministic fallback; no host installation is required.
- VALIDATION: `bash -n scripts/compose.sh`; doctor TypeScript transpiles; static scan confirms no live `sudo -n true`, bare `podman`, or alternate rootful Podman path remains in the E2E control path. `./scripts/doctor.sh` reports DOC-05 READY (`Android Debug Bridge version 1.0.41`) and performs no Compose operation.

- ITERATION: 23
- ACTIVE_TODO: Preflight Authorization Verification
- GOAL: Verify root authorization layer required for rootful Compose/backend/web/Android/security phases
- CURRENT_FAILURE: sudo -n true exited 1; passwordless sudoers authorization unavailable
- RESULT: BLOCKED_EXTERNAL
- ROOT_CAUSE: Host administrator must grant NOPASSWD sudoers entry for resolved Podman binary before E2E integration phases can execute.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/runtime-verification/commit.txt
- ARTIFACT: e2e-lab/artifacts/runtime-verification/commit.txt, e2e-lab/doctor-report.json
- DATE: 2026-09-28T02:45:05Z
- HEAD: a320a9d9ff82a09b8517e558b548063f723d5977
- EVIDENCE:
  ```text
  Date: 2026-09-28T02:45:05.620Z
  Command: sudo -n true
  Exit: 1 (sudo password required)
  
  Doctor report output:
  [READY] DOC-06: Hardware Virtualization (/dev/kvm) → /dev/kvm (rw)
  [READY] DOC-08: Podman Container Runtime → podman version 5.8.1
  [BLOCKED_ENVIRONMENT] DOC-09: Rootful Compose via sudo -n → not configured
  [BLOCKED_ENVIRONMENT] DOC-05: Android Debug Bridge (adb) → not found
  
  Operator action (REQUIRED):
  1. Grant passwordless sudo for resolved Podman binary:
     visudo → add line: momodding ALL=(ALL) NOPASSWD: /home/linuxbrew/.linuxbrew/bin/podman
  2. Rerun: sudo -n true (exit 0 expected)
  3. Rerun: ./scripts/test-all.sh
  
  Rootful Compose phases (blocked until sudoers configured): backend, web, android, security
  ADB blocker (independent; install Android platform-tools separately if needed).
  ```
- ITERATION: 24
- ACTIVE_TODO: Rootful Podman Authorization & Android Platform-Tools
- GOAL: Execute `sudo -n true`, then `sudo -n /home/linuxbrew/.linuxbrew/bin/podman info`, then `cd e2e-lab && ./scripts/test-all.sh`
- CURRENT_FAILURE: sudo: a password is required (both sudo commands rejected)
- TEST_DOCTOR: DOC-05 adb missing, DOC-09 rootful compose blocked
- RESULT: BLOCKED_EXTERNAL
- ROOT_CAUSE: Sudoers policy not configured for passwordless rootful Podman execution; Android platform-tools (adb) not installed.
- EXIT_CODE: 200
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md
- ARTIFACT: none (test-all never reached up; no container state captured)
- DATE: 2026-09-28T00:00:00Z
- EVIDENCE:
  ```text
  Command sequence:
    sudo -n true
    Exit: 1 (sudo: a password is required)
    
    sudo -n /home/linuxbrew/.linuxbrew/bin/podman info
    Exit: 1 (sudo: a password is required)
    
    cd e2e-lab && ./scripts/test-all.sh
    Doctor report:
      [BLOCKED_ENVIRONMENT] DOC-05: Android Debug Bridge (adb) → not found
      [BLOCKED_ENVIRONMENT] DOC-09: Rootful Compose via sudo -n → not configured
    Process exited 200; up did not execute.
  ```
- REMEDIATION (REQUIRED):
  1. Configure sudoers for the actual user:
     visudo → add line: momodding ALL=(ALL) NOPASSWD: /home/linuxbrew/.linuxbrew/bin/podman
  2. Install Android platform-tools (adb):
     Host system package manager (apt, brew, etc.)
  3. Rerun exact sequence:
     sudo -n true (exit 0 expected)
     sudo -n /home/linuxbrew/.linuxbrew/bin/podman info (exit 0 expected)
     cd e2e-lab && ./scripts/test-all.sh (full execution expected)
- ITERATION: 1
- ACTIVE_TODO: A01
- GOAL: Preserve and understand current worktree
- CURRENT_FAILURE: none
- RESULT: PASS
- ROOT_CAUSE: none
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md
- ARTIFACT: e2e-lab/artifacts/git-state.txt
- EVIDENCE:
  ```bash
  git rev-parse HEAD && git status --short && git diff --stat
  ```

- ITERATION: 2
- ACTIVE_TODO: A02
- GOAL: Host KVM must work
- CURRENT_FAILURE: none
- RESULT: PASS
- ROOT_CAUSE: none
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md
- ARTIFACT: e2e-lab/artifacts/android-root-cause-report.md
- EVIDENCE:
  ```bash
  id && id -G && ls -ln /dev/kvm && test -r /dev/kvm && test -w /dev/kvm
  # Output: uid=1000(momodding) ... /dev/kvm crw-rw----+ 1 0 994 10, 232 ... READ: yes, WRITE: yes
  ```

- ITERATION: 3
- ACTIVE_TODO: A03
- GOAL: Rootless Podman KVM must work
- CURRENT_FAILURE: none
- RESULT: PASS
- ROOT_CAUSE: none
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-kvm-probe-local-store.txt
- ARTIFACT: e2e-lab/artifacts/android-kvm-probe-local-store.txt
- EVIDENCE:
  ```bash
  podman run --rm --pull=never --device /dev/kvm --group-add keep-groups --userns=keep-id:uid=1300,gid=1301 ...
  # Output: uid=1300(1300) gid=1301(1301) groups=1301(1301), /dev/kvm read_rc=0, write_rc=0, KVM_OPEN_RDWR=OK 7
  ```

- ITERATION: 4
- ACTIVE_TODO: A04
- GOAL: docker-android runtime identity must access KVM
- CURRENT_FAILURE: Error: budtmo/docker-android:emulator_14.0_v3.7.0-p0@sha256:7826cd345543736c9502293926f383af4ca9caf96bd47d12d15bce8d31fd9894: image not known
- RESULT: BLOCKED
- ROOT_CAUSE: Pinned Docker-Android image is absent from local isolated store; pull prohibited by isolation constraint.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-docker-identity-kvm-probe.txt
- ARTIFACT: e2e-lab/artifacts/android-docker-identity-kvm-probe.txt
- EVIDENCE:
  ```text
  e2e-lab/artifacts/android-docker-identity-kvm-probe.txt
  EXIT_CODE=125
  Error: budtmo/docker-android:emulator_14.0_v3.7.0-p0@sha256:7826cd345543736c9502293926f383af4ca9caf96bd47d12d15bce8d31fd9894: image not known
  ```

- ITERATION: 5
- ACTIVE_TODO: A04

- GOAL: Locate safe nonduplicating source
- CURRENT_FAILURE: Error: budtmo/docker-android:emulator_14.0_v3.7.0-p0@sha256:7826cd345543736c9502293926f383af4ca9caf96bd47d12d15bce8d31fd9894: image not known
- RESULT: BLOCKED
- ROOT_CAUSE: Exact digest absent from both project-local and shared metadata.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/pinned-image-source-inventory.md, e2e-lab/artifacts/podman-safe-unblock-options.md
- ARTIFACT: e2e-lab/artifacts/pinned-image-source-inventory.md, e2e-lab/artifacts/podman-safe-unblock-options.md
- EVIDENCE:

  ```text
  e2e-lab/artifacts/android-docker-identity-kvm-probe.txt
  EXIT_CODE=125
  Error: budtmo/docker-android:emulator_14.0_v3.7.0-p0@sha256:7826cd345543736c9502293926f383af4ca9caf96bd47d12d15bce8d31fd9894: image not known

  e2e-lab/artifacts/pinned-image-source-inventory.md
  Shared metadata: overlay-images/images.json exact digest search NOT FOUND; Budtmo reference search NOT FOUND.

  e2e-lab/artifacts/podman-safe-unblock-options.md
  ```

- ITERATION: 6
- ACTIVE_TODO: A04
- GOAL: Assess remote manifest-only execution without local layer storage
- CURRENT_FAILURE: Podman execution requires local image layers; remote manifest resolution does not supply a runnable root filesystem.
- RESULT: BLOCKED
- ROOT_CAUSE: The pinned digest has no local image metadata, and a supported remote execution path would pull and store image layers. An unauthorized `podman run --pull=always` was attempted in shared user storage and interrupted; read-only audit confirms no active pull or run, no image metadata for the digest, and potentially related recent unlabelled layers cannot be safely removed.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md
- ARTIFACT: e2e-lab/artifacts/podman-safe-unblock-options.md, e2e-lab/artifacts/pinned-image-source-inventory.md
- EVIDENCE:
  ```text
  e2e-lab/artifacts/podman-safe-unblock-options.md
  Remote digest manifest resolves, but `podman run --pull=never` exits 125 with image not known; `podman pull` stores images locally.

  e2e-lab/artifacts/pinned-image-source-inventory.md
  Shared overlay-images metadata has no exact digest or Budtmo reference.
  ```

- ITERATION: 7
- ACTIVE_TODO: A04
- GOAL: Verify the exact Docker-Android runtime identity can access KVM
- CURRENT_FAILURE: none
- RESULT: PASS
- ROOT_CAUSE: none
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-a04-live-runtime-proof.txt
- ARTIFACT: e2e-lab/artifacts/android-a04-live-runtime-proof.txt
- EVIDENCE:
  ```text
  Running exact image: budtmo/docker-android:emulator_14.0_v3.7.0-p0@sha256:7826cd345543736c9502293926f383af4ca9caf96bd47d12d15bce8d31fd9894
  Runtime identity: uid=1300(androidusr) gid=1301(androidusr)
  KVM_READ=0; KVM_WRITE=0; KVM_OPEN_RDWR=OK 3
  ```

- ITERATION: 8
- ACTIVE_TODO: A05
- GOAL: Verify the preserved emulator process remains alive
- CURRENT_FAILURE: none
- RESULT: PASS
- ROOT_CAUSE: none
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-emulator-only-command.log
- ARTIFACT: e2e-lab/artifacts/android-emulator-only-command.log
- EVIDENCE:
  ```text
  container State.Running=true; qemu-system-x86_64 is present with -accel on.
  ```

- ITERATION: 9
- ACTIVE_TODO: A06
- GOAL: Verify staged emulator readiness through ADB boot and package manager
- CURRENT_FAILURE: none
- RESULT: PASS
- ROOT_CAUSE: none
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-emulator-only-command.log
- ARTIFACT: e2e-lab/artifacts/android-emulator-only-command.log
- EVIDENCE:
  ```text
  adb get-state=device; sys.boot_completed=1; pm list packages succeeded on 127.0.0.1:38891.
  ```

- ITERATION: 10
- ACTIVE_TODO: B01
- GOAL: Build the Android APK reliably
- CURRENT_FAILURE: client/node_modules/.bin/expo is absent
- RESULT: BLOCKED
- ROOT_CAUSE: The canonical client dependency tree is absent, so Expo prebuild cannot run with the harness-required --no-install contract.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-b01-build-prerequisite-proof.txt
- ARTIFACT: e2e-lab/artifacts/android-b01-build-prerequisite-proof.txt
- EVIDENCE:
  ```text
  stat client/node_modules/.bin/expo exited 1: No such file or directory; client/node_modules does not exist.
  ```

- ITERATION: 11
- ACTIVE_TODO: B01
- GOAL: Build the Android APK reliably with the canonical locked client dependencies
- CURRENT_FAILURE: none
- RESULT: IN_PROGRESS
- ROOT_CAUSE: none
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-b01-dependency-install.log, e2e-lab/artifacts/android-b01-prebuild.log, e2e-lab/artifacts/android-b01-source-transfer.log, e2e-lab/artifacts/android-b01-gradle-build.log
- ARTIFACT: e2e-lab/artifacts/android-b01-gradle-build.log
- EVIDENCE:
  ```text
  bun install --frozen-lockfile exited 0; Expo prebuild --no-install exited 0; Gradle assembleDebug is running in the preserved emulator container.
  ```

- ITERATION: 12
- ACTIVE_TODO: B01
- GOAL: Rerun B01 with a writable rootless Android SDK
- CURRENT_FAILURE: Android Gradle native prefab/CMake tasks fail under the image's only Java runtime (25)
- RESULT: BLOCKED
- ROOT_CAUSE: The rootless SDK overlay fixed the read-only /opt/android defect and installed the required NDK, SDK Platform, Build-Tools, and CMake. The build then reached native CMake configuration, where AGP surfaced Java 25's restricted System method warning as a failure. The image has no compatible alternate JDK.
- FILES_CHANGED: e2e-lab/android/android-runner.ts, e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-b01-rootless-sdk-diagnosis.md
- ARTIFACT: e2e-lab/artifacts/android-b01-rootless-sdk-diagnosis.md
- EVIDENCE:
  ```text
  Rootless SDK installs succeeded; :react-native-screens:configureCMakeDebug[arm64-v8a] and :react-native-worklets:configureCMakeDebug[arm64-v8a] failed. Focused --stacktrace reported AGP GeneratePrefabPackages converting `WARNING: A restricted method in java.lang.System has been called` to IllegalStateException.
  ```

- ITERATION: 13
- ACTIVE_TODO: B01
- GOAL: Build the Android APK using the compatible host JDK in rootless E2E storage
- CURRENT_FAILURE: none
- RESULT: PASS
- ROOT_CAUSE: none
- FILES_CHANGED: e2e-lab/android/android-runner.ts, e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-b01-jdk17-transfer.log, e2e-lab/artifacts/android-b01-jdk17-complete.log, e2e-lab/artifacts/android-b01-app-debug.apk
- ARTIFACT: e2e-lab/artifacts/android-b01-jdk17-complete.log, e2e-lab/artifacts/android-b01-app-debug.apk
- EVIDENCE:
  ```text
  Focused :react-native-screens:configureCMakeDebug[arm64-v8a] passed under JDK 17. Full rootless ./gradlew assembleDebug -x test exited 0; app-debug.apk is 88,764,711 bytes with SHA-256 d1be59189a0a4a1f2a7622e5332734cedae12cfa00f73feba3d90ce22106ecfc.
  ```

- ITERATION: 14
- ACTIVE_TODO: B02
- GOAL: Reduce Android build storage pressure without removing the APK required by B03
- CURRENT_FAILURE: none
- RESULT: PASS
- ROOT_CAUSE: none
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-b02-build-cleanup.log
- ARTIFACT: e2e-lab/artifacts/android-b02-build-cleanup.log
- EVIDENCE:
  ```text
  After copying app-debug.apk to E2E artifacts, the B01-only source, JDK, SDK, and Gradle paths were removed from the preserved container. Available filesystem capacity increased from 5.7G to 17G; only a 20K Gradle daemon directory required a second rootless removal.
  ```

- ITERATION: 15
- ACTIVE_TODO: B03
- GOAL: Install the built Android APK on the running emulator
- CURRENT_FAILURE: none
- RESULT: PASS
- ROOT_CAUSE: none
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-b03-install.log
- ARTIFACT: e2e-lab/artifacts/android-b03-install.log
- EVIDENCE:
  ```text
  adb install -r e2e-lab/artifacts/android-b01-app-debug.apk returned Success; pm list packages returned package:com.paperplain.agenticremote.
  ```

- ITERATION: 16
- ACTIVE_TODO: B04
- GOAL: Launch the installed Android app without native crash
- CURRENT_FAILURE: SoLoaderDSONotFoundError for libreactnative.so on the x86_64 emulator
- RESULT: BLOCKED
- ROOT_CAUSE: The product's Expo build configuration restricted native output to arm64-v8a, while the live emulator is x86_64. The app launch succeeded initially but crashed before a process persisted because the APK had x86_64 extraction metadata and no x86_64 React Native native library.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-b04-launch.log
- ARTIFACT: e2e-lab/artifacts/android-b04-launch.log
- EVIDENCE:
  ```text
  am start returned Status: ok, then AndroidRuntime recorded FATAL EXCEPTION / SoLoaderDSONotFoundError: couldn't find DSO to load: libreactnative.so; pidof returned no process.
  ```

- ITERATION: 17
- ACTIVE_TODO: B04
- GOAL: Launch the installed Android app without native crash
- CURRENT_FAILURE: none
- RESULT: PASS
- ROOT_CAUSE: The prior blocker was corrected by including x86_64 alongside arm64-v8a in Expo buildArchs.
- FILES_CHANGED: client/app.json, e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-b04-x86-app-debug.apk, e2e-lab/artifacts/android-b04-abi-proof.log, e2e-lab/artifacts/android-b04-x86-launch.log, e2e-lab/artifacts/android-b04-cleanup.log
- ARTIFACT: e2e-lab/artifacts/android-b04-x86-launch.log
- EVIDENCE:
  ```text
  The rebuilt dual-ABI assembleDebug completed successfully. The runtime emulator ABI is x86_64 and the APK contains arm64-v8a and x86_64 native libraries. adb install returned Success; am start launched MainActivity; pidof returned 9789 after five seconds; the cleared logcat contained no FATAL EXCEPTION for com.paperplain.agenticremote. APK SHA-256: 737c630ee279f6445b111e58984e05085a1f354444da5710d0041f2da780b8d0. After retaining the host APK artifact and installed app, rootless staged build state was removed, leaving 16G available.
  ```

- ITERATION: 18
- ACTIVE_TODO: C01
- GOAL: Reach the live E2E daemon from the preserved emulator
- CURRENT_FAILURE: none
- RESULT: PASS
- ROOT_CAUSE: The E2E daemon image tag could refer to the Bun base image because bringup checked only tag existence. The harness now verifies the daemon entrypoint and rebuilds owned local images when it is not the daemon.
- FILES_CHANGED: e2e-lab/scripts/up.sh, e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-c01-daemon-connectivity.log
- ARTIFACT: e2e-lab/artifacts/android-c01-daemon-connectivity.log
- EVIDENCE:
  ```text
  The rebuilt daemon returned {"ok":true,"version":"dev"} from /healthz. adb reverse tcp:18765 tcp:18765 succeeded, and device netcat connected to 127.0.0.1:18765 with exit 0. This keeps the exact emulator while supplying its local endpoint through the native ADB reverse transport.
  ```

- ITERATION: 19
- ACTIVE_TODO: C02
- GOAL: Complete pairing through the installed product UI
- CURRENT_FAILURE: The preserved emulator's Android system repeatedly presents “Process system isn't responding,” preventing the pairing screen from receiving the required product-UI tap.
- RESULT: BLOCKED
- ROOT_CAUSE: The system ANR occurred after the long dual-ABI native build; Maestro launched the app but its inspected UI hierarchy contained only the Android system ANR dialog, not product controls. Selecting the dialog's Wait control did not clear the repeated ANR.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-c02-ui-pairing.log
- ARTIFACT: e2e-lab/artifacts/android-c02-ui-pairing.log
- EVIDENCE:
  ```text
  Maestro launchApp completed, then tapOn “Connect daemon” failed because the live hierarchy contained “Process system isn't responding”, with only “Close app” and “Wait” available. The app pairing UI was not bypassed or simulated.
  ```

- ITERATION: 20
- ACTIVE_TODO: C02
- GOAL: Prove deterministic input-field control (empty/clean states) via bounded Maestro eraseText/inputText chunking, then locate real submit contract, ahead of live pairing-payload injection
- CURRENT_FAILURE: none (Maestro inputText/eraseText transport limitation confirmed as harness constraint, not product ANR); payload-injection+submit step still pending
- RESULT: IN_PROGRESS
- ROOT_CAUSE: none — this iteration is diagnostic/preparatory, not a blocked outcome
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/containers/Containerfile.daemon
- ARTIFACT: /tmp/android-c02-clear-50.yaml, /tmp/android-c02-dismiss-ime.yaml, /tmp/android-c02-input-chunk.yaml
- EVIDENCE:
  ```text
  Deterministic empty-state proof (prior sub-session, pre-restart): repeated bounded `eraseText: 50` + hierarchy re-check per round drove the "Paste pairing JSON" field to length=0, sha256=e3b0c442... (empty-string hash). Deterministic 292-char proof (same sub-session): chunked `inputText` (100+100+92 chars, workaround for a confirmed Maestro inputText transport cap/stall around ~170 chars — a harness limitation, not a product ANR) produced field length=292, sha256=2dd0eb68dd611e516666673170430b419e657cc4e1e92e21c04c3aff25856d58, exact byte match to expected content.

  This session: extended pairingRotationSeconds 300->900 in Containerfile.daemon (more margin for multi-chunk injection before payload expiry), rebuilt localhost/agenticremote/daemon:latest, restarted topology via e2e-lab/scripts/up.sh, re-established the dropped `adb reverse tcp:18765 tcp:18765` tunnel, and confirmed device-to-daemon TCP reachability (nc exit=0). The pairing screen retained stale 292-char field content across the container restart (app/UI state is independent of the daemon container lifecycle), so the erase-50 proof cycle was re-run from scratch this session: length progression across repeated eraseText:50 + tapOn(90%,65%) + Back-press rounds was 292->259->226->193->160->127->94->61 (each step verified against a fresh `maestro hierarchy` read, never trusting eraseText's nonzero exit code alone); the loop was still short of 0 when this iteration closed for budget reasons.

  Read the real product submit contract directly from client/src/components/PairingSheet.tsx: the paste-JSON submit control is `Pressable accessibilityLabel="Connect"` (icon `log-in`), calling `onPaste` -> `connect(payloadText)` -> `parsePairingPayload(raw)` (client/src/lib/auth.ts) requiring `{v:2, endpoint:string, fingerprint:string, pairingId:string, token:string, expiresAt:string}` with a parseable expiresAt. Also discovered a "Skip fingerprint verification" Switch (state `skip`) that PairingSheet's own on-screen warning says MUST be enabled for this daemon's self-signed HTTPS cert under Expo Go/direct LAN pairing — required for the next injection+submit attempt to succeed. This confirms `pairing-flow.yaml`'s "Connect daemon" selector is stale (real label is "Connect") and its flow does not toggle the skip-fingerprint switch.
  ```

- ITERATION: 21
- ACTIVE_TODO: C02
- GOAL: Exhaust the final permitted harness-layer QR camera and Maestro accessibility-text alternatives without exposing pairing material
- CURRENT_FAILURE: No permitted Android UI transport can inject a verified full JSON payload into the real pairing field.
- RESULT: BLOCKED
- ROOT_CAUSE: `adb shell input text` silently rejects literal double quotes; shifted key events and mapped visible LatinIME taps do not commit the needed characters. Maestro 2.10.0 has no distinct accessibility/UI `setText` command (its installed model exposes only InputText, PasteText, SetClipboard, and EraseText), while its available input/clipboard routes are already documented as unreliable. The exact emulator does expose authenticated `virtualscene-image <wall|table> [path]` without host video devices or privileges, but two non-sensitive QR probes supplied through that command entered the real Scan QR code UI and returned unrelated short field values instead of either known probe. The QR route is therefore reachable but unvalidated and cannot carry pairing material.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-c02-final-harness-audit.md
- ARTIFACT: e2e-lab/artifacts/android-c02-final-harness-audit.md
- EVIDENCE:
  ```text
  Authenticated emulator-console `help virtualscene-image` reported `Usage: virtualscene-image <wall|table> [path-to-image].`; both harmless probe-image commands returned OK. Android reported one public back camera and vendor.qemu.sf.fake_camera=back. Real UI scanner runs returned to the pairing form but hierarchy did not contain either expected probe string. Direct inspection of the installed Maestro 2.10.0 command-model archive found InputTextCommand, PasteTextCommand, SetClipboardCommand, and EraseTextCommand, with no SetTextCommand. No actual pairing JSON, token, credential, submission, or downstream task was attempted.
  ```

- ITERATION: 22
- ACTIVE_TODO: C02
- GOAL: Establish controlled virtual-scene camera texture framing before non-sensitive QR decode validation
- CURRENT_FAILURE: The product Scanner UI is unavailable after the virtual-scene mode reload because the installed debug APK cannot reload its JavaScript bundle.
- RESULT: IN_PROGRESS
- ROOT_CAUSE: The prior QR probes were inconclusive: the active emulator configuration was `hw.camera.back = emulated`, so console `virtualscene-image` acknowledged paths without proving they reached the fake camera. Both active emulator configuration files were changed to `hw.camera.back = virtualscene`, and the emulator container was restarted to apply that supported mode. After boot, the installed app showed its React Native redbox: `Make sure you're running Metro or that your bundle 'index.android.bundle' is packaged correctly for release.` Existing Metro was live and ADB reverse mappings for 8081, 8090, and 18765 were restored, but the product reload control remained on the same error. No CameraView is available to perform the required controlled solid-texture/framing and known-QR checks yet.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-c02-final-harness-audit.md
- ARTIFACT: e2e-lab/artifacts/android-c02-final-harness-audit.md
- EVIDENCE:
  ```text
  Before restart, config.ini and hardware-qemu.ini both reported hw.camera.back = emulated; the red virtualscene texture had zero red pixels in a captured Scanner screenshot. Both files now report hw.camera.back = virtualscene. The emulator completed boot after the container restart, but app reload kept `rn_redbox_reload_button` visible after restoring all known ADB reverse mappings. The previously observed scanner-field values were exactly `"G ; be ` and `z ` (not the expected harmless probes); their origin is not attributed to the virtual scene.
  ```

- ITERATION: 23
- ACTIVE_TODO: C02
- GOAL: Recover the product UI after the virtual-scene emulator restart and distinguish bundle transport from app rendering
- CURRENT_FAILURE: Metro transport is recovered, but the focused product MainActivity now exposes a blank `#FAFAFA` native surface rather than the pairing UI.
- RESULT: IN_PROGRESS
- ROOT_CAUSE: The Dev Menu custom address was stale (`10.0.2.2:8081`). Resetting it through the real Dev Menu to `localhost:8081` with `adb reverse tcp:8081 tcp:8081` made the app confirm Metro availability and load its JS bundle. The current independent blocker is an unidentified app/render identity or runtime-mount failure: post-load UIAutomator finds only six native container nodes, no React controls or pairing scanner. It is not the source `TabDeckScreen` loading branch (which is dark) and logcat has no post-load JS exception.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-c02-final-harness-audit.md, e2e-lab/artifacts/android-c02-postload-blank.png, e2e-lab/artifacts/android-c02-postload-blank-hierarchy.xml
- ARTIFACT: e2e-lab/artifacts/android-c02-final-harness-audit.md, e2e-lab/artifacts/android-c02-postload-blank.png, e2e-lab/artifacts/android-c02-postload-blank-hierarchy.xml
- EVIDENCE:
  ```text
  Metro direct bundle endpoint (8081) returned HTTP 200 application/javascript and contains current `expo-router/entry`, `Scan QR code`, and `Your terminal, at reach.` source strings. Android logcat reports isMetroRunning=true, loadJSBundleFromMetro, bundle loader creation, context/instance creation, Loading JS Bundle, and surface restart. The MainActivity is focused. The screenshot is nearly #FAFAFA and its full hierarchy has only FrameLayout/LinearLayout roots. A temporary console.warn boundary marker at entry, RootLayout, and TabDeckScreen produced no ReactNativeJS output and was removed.
  ```

- ITERATION: 24
- ACTIVE_TODO: C02
- GOAL: Root-cause and fix the blank #FAFAFA render, restoring the real product Scanner/pairing UI
- CURRENT_FAILURE: none — the real dashboard and PairingSheet (Scan QR code, Paste pairing JSON, cancel-pairing) now render correctly
- RESULT: IN_PROGRESS
- ROOT_CAUSE: React Native's `PackagerConnectionSettings.debugServerHost` (confirmed from the installed `react-native` package's `PackagerConnectionSettings.kt`/`DevInternalSettings.kt` sources) reads the app's own default `SharedPreferences` key `debug_http_host`; the on-device Dev Menu UI only mutates an in-process static field and never persists to `shared_prefs/<package>_preferences.xml`. Every cold start therefore reverted to the compiled-in `10.0.2.2:8081`, which cannot reach this Metro topology, causing an early `ReactHost` destroy that threw an unhandled `FabricUIManager IllegalStateException: Trying to stop surface that hasn't started yet` before any surface started. A same-session Dev Menu fix could reload the bundle, but `startSurface` was never observed again for that process, leaving a permanent bare-Activity `#FAFAFA` window (Android's default `Theme.AppCompat.DayNight` background) with a 6-node native hierarchy, confirmed by pixel sampling (2,064,705/2,073,600 pixels exactly `rgb(250,250,250)`) and a temporary since-removed `console.warn` boundary marker that never printed.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-c02-final-harness-audit.md, e2e-lab/artifacts/android-c02-recovered-dashboard.png
- ARTIFACT: e2e-lab/artifacts/android-c02-final-harness-audit.md, e2e-lab/artifacts/android-c02-recovered-dashboard.png
- EVIDENCE:
  ```text
  Wrote shared_prefs/com.paperplain.agenticremote_preferences.xml with <string name="debug_http_host">localhost:8081</string> via `adb shell run-as ... sh -c "cat > ..."` (harness-only, no product-code change), then `am force-stop` + normal launcher cold start. Logcat showed isMetroRunning(): Async result = true, a single startSurface(surfaceId = 0) immediately followed by Loading JS Bundle and Executing ReactInstanceEventListeners with no intervening destroy/exception. UIAutomator hierarchy now shows agenticRemote, Daemons, Your terminal, at reach., and Connect daemon; tapping it opens the real PairingSheet with cancel-pairing, Skip fingerprint verification, Scan QR code (bounds [60,990][1020,1134]), and Paste pairing JSON.
  ```

- ITERATION: 25
- ACTIVE_TODO: C02
- GOAL: Prove virtualscene red-texture propagation through the recovered real CameraView before harmless QR decode
- CURRENT_FAILURE: The system-wide Android UI became ANR-looped during the controlled camera run; the product Scanner cannot currently be exercised further.
- RESULT: IN_PROGRESS
- ROOT_CAUSE: Unknown emulator/system load failure, not a conclusion about QR support. With real PairingSheet recovery confirmed, authenticated `virtualscene-image wall/table /tmp/scene-red.png` both returned OK. The real Scan QR code UI was opened and camera permission granted. Its first camera screenshot contained nontrivial preview content but zero controlled-red pixels; a later frame was black. Before QR injection, Android began a cascading `Process system isn't responding`/Pixel Launcher ANR loop, killed the app, and retained an invisible system-ANR focus window. `adb reboot` cleanly recovered boot and all reverse routes; the persisted localhost Metro preference survived, but the next product launch immediately hit a launcher ANR.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-c02-final-harness-audit.md
- ARTIFACT: e2e-lab/artifacts/android-c02-final-harness-audit.md
- EVIDENCE:
  ```text
  Console transcript: authentication OK; virtualscene-image wall /tmp/scene-red.png -> OK; virtualscene-image table /tmp/scene-red.png -> OK. First post-grant Scanner screenshot pixel analysis: 1,165,791 rgb(237,237,237), 822,274 rgb(0,0,0), and zero pixels satisfying red R>120/G<80/B<80. No non-sensitive QR decode or secret material attempt followed. System ANR was recorded in the visible hierarchy and logcat, then cleanly rebooted via adb.
  ```

- ITERATION: 26
- ACTIVE_TODO: C02
- GOAL: Restore emulated camera mode, canonically replace the E2E-owned emulator, and reprove A04–A06 before app interaction
- CURRENT_FAILURE: The fresh emulated replacement failed the canonical A06 system-quiescence gate before any app interaction.
- RESULT: BLOCKED
- ROOT_CAUSE: Both AVD files were restored to `hw.camera.back = emulated`, and the failed virtual-scene container/device diagnostics were retained. Canonical replacement recreated the exact labeled E2E emulator; fresh configuration again reported `emulated`, container inspection confirmed the rootless `/dev/kvm` identity setup, and `podman top` showed QEMU. The canonical verifier reached loopback ADB but timed out at 300 seconds with a live `Application Not Responding: com.android.systemui` window and a final `99% TOTAL: 43% user + 55% kernel` sample. Thus A04/A05 are observed but A06 is not reproven. Virtualscene remains unavailable to C02 because the system-level ANR occurs before product interaction; the fresh emulated failure means it cannot be assigned as virtualscene's sole cause. This is not a product failure.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-c02-virtualscene-anr-assessment.md, e2e-lab/artifacts/android-c02-emulated-recovery-assessment.md, e2e-lab/artifacts/android-c02-rollback-camera-config.txt, e2e-lab/artifacts/android-c02-final-harness-audit.md
- ARTIFACT: e2e-lab/artifacts/android-c02-emulated-recovery-assessment.md, e2e-lab/artifacts/android-emulator-only-command.log
- EVIDENCE:
  ```text
  Both fresh AVD files: hw.camera.back = emulated. The canonical verifier inspected the labeled rootless KVM container and live qemu-system-x86_64 process, reached loopback ADB, then failed its three-sample quiescence requirement after 300 seconds. Final sample: live Application Not Responding: com.android.systemui; 99% TOTAL: 43% user + 55% kernel. No app interaction followed.
  ```

- ITERATION: 27
- ACTIVE_TODO: C02
- GOAL: Test whether disabling the nonessential Web VNC sidecar restores emulator A04–A06 readiness
- CURRENT_FAILURE: The one-off `WEB_VNC=false` rootless exact-image diagnostic did not pass canonical A06; no repository launcher change was made.
- RESULT: BLOCKED
- ROOT_CAUSE: The labeled E2E-only emulator was replaced by an external one-off launcher copy that changed only `WEB_VNC=true` to `WEB_VNC=false`; the exact pinned image, `/dev/kvm`, `--group-add keep-groups`, and `--userns=keep-id:uid=1300,gid=1301` were retained. The unchanged canonical verifier reached ADB and boot completion, but timed out at its 300-second system-quiescence gate with a final `57% TOTAL: 17% user + 36% kernel + 2.7% iowait + 0.5% softirq` sample; `system_server` was 93% and `surfaceflinger` 72%. Therefore disabling Web VNC is not a permitted remediation. No product UI, pairing material, QR decode, submission, fingerprint change, or D01+ action was attempted.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-c02-final-harness-audit.md
- ARTIFACT: e2e-lab/artifacts/android-emulator-only-command.log
- EVIDENCE:
  ```text
  The diagnostic launch command recorded `WEB_VNC=false` with the exact pinned image at android-emulator-only-command.log:43549 and container environment at :43693. ADB reached `device` at :44445. The unchanged verifier ultimately reported `FAIL: emulator system UI did not become quiescent within 300s`; its captured final CPU sample was 57% total, system_server 93%, and surfaceflinger 72%. No canonical launcher source was changed.
  ```

- ITERATION: 28
- ACTIVE_TODO: C02
- GOAL: Test the documented exact-image emulator `-memory 4096` adjustment without changing rootless/KVM/image/labels/Web VNC configuration
- CURRENT_FAILURE: The external one-off launcher was blocked before container replacement because `/dev/kvm` was not readable and writable by the current user.
- RESULT: BLOCKED
- ROOT_CAUSE: The external copy retained the exact pinned image, rootless Podman, `/dev/kvm`, `--group-add keep-groups`, `--userns=keep-id:uid=1300,gid=1301`, canonical labels, and `WEB_VNC=true`; its only intended configuration delta was appending `-memory 4096` to `EMULATOR_ADDITIONAL_ARGS`. It exited at the canonical preflight guard with `ERROR: /dev/kvm is not readable and writable by this user.` No container was launched or replaced, so the canonical verifier and A06 were not run and this result does not evaluate the memory adjustment. Repository launcher source remains unchanged; C02 remains blocked. No product/UI/pairing/D01+ action was attempted.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-c02-final-harness-audit.md
- ARTIFACT: e2e-lab/artifacts/android-emulator-only-command.log
- EVIDENCE:
  ```text
  One-off external diagnostic: preserving canonical exact-image/rootless/KVM/labels/WEB_VNC=true launch; only appending -memory 4096 to EMULATOR_ADDITIONAL_ARGS.
  ERROR: /dev/kvm is not readable and writable by this user.
  ```

- ITERATION: 29
- ACTIVE_TODO: C02
- GOAL: Recover a normal active-user `/dev/kvm` ACL context and rerun the exact-image `-memory 4096` diagnostic
- CURRENT_FAILURE: No active `momodding` session can open `/dev/kvm`; the node is `crw-rw---- root:kvm`, `momodding` has no `kvm` supplementary group, and Python `os.open("/dev/kvm", O_RDWR)` returns `PermissionError: [Errno 13] Permission denied`.
- RESULT: BLOCKED
- ROOT_CAUSE: Active logind sessions 104, 106, and 98 are all UID 1000 and none supplies effective KVM access. No normal active-user ACL context was available to reuse, so no ACL, group, ownership, or host-policy change was made. The bounded external one-off retained the pinned digest, rootless Podman, `/dev/kvm`, `--group-add keep-groups`, `--userns=keep-id:uid=1300,gid=1301`, canonical labels, and `WEB_VNC=true`; its only runtime delta was appending `-memory 4096` to `EMULATOR_ADDITIONAL_ARGS`. It failed at the preflight guard before any container action. The unchanged canonical verifier then failed at the same guard; A04–A06 cannot run and A06 did not pass. The canonical launcher remains unchanged; no product/UI/pairing/D01+ work occurred.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-c02-final-harness-audit.md
- ARTIFACT: e2e-lab/artifacts/android-emulator-only-command.log
- EVIDENCE:
  ```text
  node=crw-rw---- root:kvm /dev/kvm
  groups=momodding adm cdrom sudo dip video plugdev lxd render
  kvm-group=kvm:x:994:
  active sessions: 104, 106, 98 (UID 1000/momodding)
  os.open("/dev/kvm", O_RDWR) -> PermissionError: [Errno 13] Permission denied
  external `-memory 4096` diagnostic -> ERROR: /dev/kvm is not readable and writable by this user.
  unchanged canonical verifier -> FAIL: /dev/kvm is not readable and writable by this user.
  ```

- ITERATION: 30
- ACTIVE_TODO: C02
- GOAL: Record the explicit rootless KVM device pass-through change
- CURRENT_FAILURE: Host `/dev/kvm` preflight remains `EACCES` for the active user.
- RESULT: BLOCKED
- ROOT_CAUSE: Both launcher paths now explicitly use `--device /dev/kvm:/dev/kvm:rwm`. This is valid rootless KVM pass-through, but it cannot bypass host preflight access control; no container, product UI, or pairing execution occurred.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-c02-final-harness-audit.md
- ARTIFACT: e2e-lab/artifacts/android-c02-final-harness-audit.md

- ITERATION: 31
- ACTIVE_TODO: A06
- GOAL: Retry canonical rootless emulator launch and verification after host KVM access returned
- CURRENT_FAILURE: The canonical verifier reached ADB/window/CPU checks but did not satisfy the 300-second A06 system-quiescence gate.
- RESULT: BLOCKED
- ROOT_CAUSE: `/dev/kvm` is now `crw-rw-rw- root:kvm` (0666), so host read/write preflight passed without any permission change. The unchanged canonical launcher ran the exact pinned rootless image with `--device /dev/kvm:/dev/kvm:rwm`, `--group-add keep-groups`, and `--userns=keep-id:uid=1300,gid=1301`. The verifier reached loopback ADB, live window, and CPU checks, then timed out with a live `Application Not Responding: com.android.systemui` window and `99% TOTAL` CPU.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-c02-final-harness-audit.md
- ARTIFACT: e2e-lab/artifacts/android-emulator-only-command.log
- EVIDENCE:
  ```text
  /dev/kvm owner=root group=kvm mode=666; readable=yes; writable=yes
  canonical run-android-emulator-only.sh: PASS, explicit rootless /dev/kvm mapping
  canonical verify-android-emulator-only.sh: ADB/window/CPU checks reached; FAIL: emulator system UI did not become quiescent within 300s.
  live focus: Application Not Responding: com.android.systemui; final CPU: 99% TOTAL.
  No UI, pairing, or D01+ work occurred.
  ```

- ITERATION: 32
- ACTIVE_TODO: A06
- GOAL: User-authorized bounded rootful-Podman exact-image emulator-only A06 diagnostic
- CURRENT_FAILURE: `sudo -n` rejected rootful Podman before it could inspect, preserve, remove, or launch an E2E container.
- RESULT: BLOCKED
- ROOT_CAUSE: Rootful Podman requires sudo authentication in this session (`sudo: a password is required`). The direct one-shot rootful command was bounded at 360 seconds and retained the exact pinned image digest, explicit `/dev/kvm:/dev/kvm:rwm` mapping, canonical E2E labels, `WEB_VNC=true`, and the read-only emulator.py patch bind mount. It deliberately omitted rootless-only `--group-add keep-groups` and `--userns=keep-id:uid=1300,gid=1301`; no `--privileged` option was used. Before the attempt, rootless positively labelled E2E container count was zero, so no logs existed to preserve and no container was replaced. Because sudo denied execution before Podman started, no rootful container exists and equivalent ADB/window/CPU/package checks, including the 300-second A06 quiescence gate, could not run. A06 did not pass; C02 remains blocked. No product/UI/pairing/D01+ work occurred.
- FILES_CHANGED: e2e-lab/ANDROID_E2E_TODO.md, e2e-lab/artifacts/android-rootful-podman-a06.log

- ARTIFACT: e2e-lab/artifacts/android-rootful-podman-a06.log
- EVIDENCE:
  ```text
  exact attempted launch: timeout --kill-after=10s 360s sudo -n /usr/bin/podman run -d --device /dev/kvm:/dev/kvm:rwm --name agent-remote-android-emulator --publish=127.0.0.1::5555/tcp --env EMULATOR_NO_SKIN=true --env WEB_VNC=true --env EMULATOR_ADDITIONAL_ARGS=-no-audio -no-boot-anim -gpu swiftshader_indirect --label io.agent-remote.e2e=true --label io.agent-remote.role=android-emulator-only --label io.agent-remote.image-digest=sha256:7826cd345543736c9502293926f383af4ca9caf96bd47d12d15bce8d31fd9894 --label version=emulator_14.0_v3.7.0-p0 --volume /home/momodding/Documents/agentic-remote/e2e-lab/android/patches/emulator-kvm-fix.py:/home/androidusr/docker-android/cli/src/device/emulator.py:ro budtmo/docker-android:emulator_14.0_v3.7.0-p0@sha256:7826cd345543736c9502293926f383af4ca9caf96bd47d12d15bce8d31fd9894
  output: sudo: a password is required
  rootless labelled E2E containers before launch: 0
  ```

## Backlog
- [PASS] A01: Preserve and understand current worktree
- [PASS] A02: Host KVM must work
- [PASS] A03: Rootless Podman KVM must work
- [PASS] A04: docker-android runtime identity must access KVM
- [PASS] A05: Emulator process must remain alive
- [PASS] A06: Emulator readiness must be staged
- [PASS] B01: Android APK must build reliably
- [PASS] B02: Reduce Android build storage pressure
- [PASS] B03: APK installation must work
- [PASS] B04: App must launch without native crash
- [PASS] C01: Emulator must reach the E2E daemon
- [BLOCKED] C02: Pairing journey must work through UI — virtualscene is unavailable because a system-level ANR occurs before app interaction; canonical emulated replacement did not pass A06. Existing permitted direct/IME/Maestro routes cannot safely enter the required JSON, QR was never validated, and no pairing material or D01+ work was attempted. See iteration 26 and `artifacts/android-c02-emulated-recovery-assessment.md`.
- [TODO] D01: Create Terminal from Android
- [TODO] D02: Terminal input/output must work
- [TODO] E01: Agent launcher must be accessible
- [TODO] E02: OMP discovery must work
- [TODO] E03: Real OMP Agent creation must work
- [TODO] E04: Agent Chat live response must work
- [TODO] E05: Tool/semantic events must remain correct
- [TODO] F01: Chat ↔ Terminal switch must work
- [TODO] F02: Close presentation must not terminate Agent
- [TODO] F03: Reopen history must be correct
- [TODO] G01: File Manager must open on Android
- [TODO] G02: File fixture must be visible/readable
- [TODO] H01: Desktop session ticket must work
- [TODO] H02: Android WebView noVNC must initialize
- [TODO] H03: Android RFB framebuffer must render
- [TODO] I01: Explicit Agent termination must work
- [TODO] I02: Android E2E resources must clean up
- [TODO] J01: Measure persistent Podman usage
- [TODO] J02: Run Android E2E twice
- [TODO] K01: Run complete test-all

## Iteration 31 — 2026-10-02T07:11:30Z: Android golden-flow acceptance attempt — FAILED at Compose health (KVM permission), not storage

Executed canonical `./scripts/test-android.sh` exactly once from a clean prepared state (HEAD `784997d904a028c6b4ddefcabd1cc298bdb5991a`, clean worktree), after independently confirmed rootful storage preflight PASS (`availableBytes=120557006848`, `requiredBytes=8372800000`).

Result: `FAILED`, `Compose health check timeout`, wall time 394.85s. Storage preflight stage itself PASSED within this same run (`120553009152` bytes available) — the storage work landed this session is not implicated.

Root cause (confirmed via read-only container inspection): the `android-emulator` container's `/home/androidusr/logs/device.stdout.log` shows `PermissionError: [Errno 13] Permission denied: '/dev/kvm'` raised by `emulator.py:change_permission`. `/dev/kvm` inside the container is group-owned by gid 994 (`kvm`); the container's `androidusr` (uid 1300, gid 1301) is not a member of gid 994. `e2e-lab/compose.yaml`'s `android-emulator` service passes the `/dev/kvm` device but does not grant `androidusr` supplementary membership in its owning group (no `group_add`). Host user `momodding` is also not in the host `kvm` group, independently confirmed via `fs.accessSync`/`os.access` probes.

Also found (pre-existing, not introduced this session): `e2e-lab/android/android-runner.ts:636` checks `if (!kvmCheck)` instead of `if (!kvmCheck.ok)` — `checkKVMAccess()` always returns a non-null object, so this guard can never trip, silently masking the host-side KVM detection that had already correctly flagged the problem, and letting the run proceed into a much longer, less specific 394s Compose-health timeout instead of an immediate, actionable `KVM_UNAVAILABLE` block.

Additional non-blocking findings recorded for future acceptance attempts: `runMaestroFlows()` only invokes `pairing-flow.yaml` (not `terminal-session.yaml`/`agent-chat.yaml`); `PAIRING_PAYLOAD_CHUNK_1`/`_2` consumed by `pairing-flow.yaml` are never set anywhere in the Android runner path; Plan Mode/Vibe Mode confirmed absent by design (matches `plans/android-runtime-ux-remediation.md`) and must not be fabricated in any future report.

No container/volume/network was pruned/stopped/restarted/deleted. No source or Compose file was modified. Full evidence: `e2e-lab/artifacts/runtime-verification/android-golden-flow-acceptance-attempt-20261002T071130Z.md`, full run log `e2e-lab/artifacts/runtime-verification/android-golden-flow-run-20261002T071130Z.log`, runner-written `e2e-lab/artifacts/android-verification.json`.

## Iteration 32 — 2026-10-02: Remediate KVM harness bugs found in Iteration 31 (INFRA/HARNESS_BUG, not storage)

User authorized two fixes plus one investigation into the Iteration 31 findings. Classification: `INFRA/HARNESS_BUG` — a host/container group-permission gap and an inverted guard condition, explicitly not a storage defect (storage preflight continues to PASS unmodified).

FIX 1 — `e2e-lab/compose.yaml`: added `group_add: ["994"]` to the `android-emulator` service. `994` is the host `kvm` group gid, re-verified via `getent group kvm` → `kvm:x:994:`; the same numeric gid owns `/dev/kvm` inside the running container (confirmed via `podman exec ... ls -la /dev/kvm` → `crw-rw---- 1 root 994 10, 232`). `androidusr` (uid 1300, gid 1301) previously had no supplementary membership in gid 994; `group_add` grants it. Validated with `podman compose ... config`, which echoes `group_add: - "994"` under the service. Commit `97ec8e3`.

FIX 2 — `e2e-lab/android/android-runner.ts`: corrected the inverted guard at the former line 636, `if (!kvmCheck)` → equivalent-but-extracted `evaluateKvmPreflight(checkKVMAccess())`/`if (kvmPreflight.blocked)`. `checkKVMAccess()` always returns a truthy `{ok, error?}` object, so the old guard could never trip; host/container KVM inaccessibility silently fell through into a 360s Compose health-check timeout instead of an immediate `BLOCKED`/`KVM_UNAVAILABLE`. Added regression test `e2e-lab/android/kvm-preflight.test.ts` (3 assertions: accessible KVM does not block; inaccessible KVM blocks and surfaces the underlying error; inaccessible KVM without an error string still blocks) proving the short-circuit fires before Compose is ever started — run via `bun run android/kvm-preflight.test.ts` → `PASS: Android KVM preflight short-circuit checks`. Separately confirmed by direct simulation that the *old* guard expression (`!kvmCheck` on a `{ok:false}` object) evaluates `false` (never blocks) while the new helper evaluates `blocked:true` for the same input. Commit `5cbe91b`.

INVESTIGATION (defect-#3, resolved, no additional fix) — does host user `momodding` need `kvm` group membership, and how does this reconcile with Iteration-prior doctor output `[READY] DOC-06: Hardware Virtualization (/dev/kvm) → /dev/kvm (rw)`?
- `momodding`'s current shell identity is NOT a member of host group `kvm` (gid 994): `id` → `groups=1000(momodding),4(adm),24(cdrom),27(sudo),30(dip),44(video),46(plugdev),101(lxd),993(render)`. Host `/dev/kvm` is `crw-rw---- root:kvm` with no trailing `+` in `ls -la` (no POSIX ACL applied), so `fs.accessSync('/dev/kvm', R_OK|W_OK)` correctly fails for this user/session today.
- `/dev/kvm` carries udev tags `uaccess:seat` (`udevadm info -q property -n /dev/kvm`), meaning systemd-logind *would* grant a per-session ACL automatically to a user on an active local seat. `loginctl list-sessions` shows every current `momodding` session has `Seat=` (empty) and `Remote=yes` (`Type=tty`, `Class=user`, arriving via `Service: sshd`) — i.e. remote SSH sessions, never attached to `seat0`. logind's uaccess mechanism only fires for seat-attached (physically logged-in) sessions, so no ACL was ever granted to any of this user's current sessions, independent of static group membership.
- Reconciliation with the earlier `[READY]` DOC-06 result: that check (`doctor/system-doctor.ts` lines 175–202) performs the identical `fs.accessSync` probe this investigation used, so it is testing the same condition, not a different one. The most consistent explanation given the evidence collected is that the doctor run which produced `[READY]` executed in a session state where a logind uaccess ACL was present (e.g. a seat-attached session, or a session that still held a not-yet-expired ACL), whereas the sessions available during this investigation and during the Iteration-31 Golden Flow run did not have one. This is a host session-state fact, not a bug in the doctor check or in `checkKVMAccess()` — both correctly report the real, current access state each time they run.
- Conclusion for the rootful container path specifically: the container runs as root via `sudo -n -- podman`, so the *container's* ability to open `/dev/kvm` is governed by the container's own `androidusr` group membership (fixed by FIX 1 above), not by the host `momodding` user's groups. The host-side `checkKVMAccess()` check in `android-runner.ts`, however, runs as `momodding` directly (not through the container), so it independently requires the host user to have host-level `/dev/kvm` access (via `kvm` group membership or a seat-granted ACL) for the fail-fast guard itself to pass. Making `momodding` a member of host group `kvm` (e.g. `sudo usermod -aG kvm momodding` followed by a new login) would make this fail-fast check pass without relying on seat/ACL state, but that action requires host-admin privileges outside this session's sudoers scope (NOPASSWD is scoped only to the Podman binary; confirmed via `sudo -n -l`) and is therefore left as an explicit follow-up for a host administrator, not applied here.

No container/volume/network was pruned/stopped/restarted/deleted during this iteration. No host group/user modification was made (out of authorized scope). Next step: rerun `./scripts/test-android.sh` once from a clean state and record the true next outcome without reclassifying as storage.

## Iteration 33 — 2026-10-02T08:10:41Z: Golden Flow rerun after Iteration-32 fixes — BLOCKED at storage preflight (subprocess ETIMEDOUT, NOT a capacity shortage)

Executed `./scripts/test-android.sh` exactly once from a clean worktree (HEAD `aab2797`, `git status --porcelain` empty), per the standing requirement to rerun once after landing the Iteration-32 fixes.

Result: `BLOCKED`, `BLOCKED_STORAGE_CONTEXT: Podman info failed: 1`, wall time 10.27s, exit 1. Full log: `e2e-lab/artifacts/runtime-verification/android-golden-flow-run-20261002T081041Z.log`; artifact `e2e-lab/artifacts/android-verification.json`.

This is explicitly NOT a capacity shortage: `checkAndroidStorage()` called directly three times immediately after the run returned `PASS` every time with `availableBytes` ≈ `118.56 GB` against the `8.37 GB` requirement.

True root cause: the storage preflight's `rootfulCommand` executor runs `sudo -n -- podman info --format '{{json .}}'` through Bun's `spawnSync` with a hardcoded `timeout: 5_000`. Reproduced directly: this exact command averages ~4.0–4.3s with no contention (max observed 4.76s across 5 runs) — already marginal against the 5s budget — and under the load present during this run (`uptime` load average `13.98` on 8 cores) it did not finish in time and was killed, which Bun's `spawnSync` reports as `status: 1`, `signal: null`, empty `stdout`/`stderr`, with the real `ETIMEDOUT` only visible on `proc.error` (which `checkAndroidStorage()`'s message construction does not read). A genuine Podman exit-code-1 failure and a 5-second subprocess timeout are therefore indistinguishable in the current artifact text — a pre-existing diagnostic-quality gap, not introduced this iteration, and out of this cycle's authorized scope to fix.

Contributing factor identified and left untouched per the no-prune/no-stop/no-restart constraint: `agenticremote-e2e-android-emulator-1`, the container launched by the Iteration-31 (pre-fix) run, was still `Up About an hour (starting)` at the time of this run and consuming `59.50%` CPU (`podman stats --no-stream`), with its `supervisord` logs showing `log_web_shared` crash-looping roughly every 1–3 seconds — consistent with that container still being stuck on its original (pre-Iteration-32) KVM-permission failure. This is the most direct explanation for the host load spike that pushed the normally-~4s `podman info` call past the 5s timeout.

Full write-up: `e2e-lab/artifacts/runtime-verification/android-golden-flow-acceptance-attempt-20261002T081041Z.md`.

Neither Iteration-32 fix (`group_add: ["994"]`, the `evaluateKvmPreflight` guard correction) was exercised end-to-end by this run, since the flow never progressed past stage 2 (storage preflight) to reach the KVM check at stage 3. Both fixes remain independently verified correct via their dedicated regression tests and are unaffected by this result. No container/volume/network was pruned/stopped/restarted/deleted, and no source file was modified while producing this evidence.

Classification: `TEST_HARNESS_BUG` (hardcoded 5000ms subprocess timeout too tight under host contention, compounded by an ambiguous ETIMEDOUT-vs-real-failure error message) plus `HOST_RESOURCE_CONTENTION` (stale pre-fix container left running from Iteration 31). Explicitly not a reclassification of the storage preflight itself, which is functioning correctly and reports real capacity accurately when its subprocess completes.

## Iteration 34 — 2026-10-02: Remove stale Android emulator before next Golden Flow (INFRA_BUG, not storage)

Removed only `agenticremote-e2e-android-emulator-1`, the positively identified leftover from Iteration 31's failed `test-android.sh` run. It belonged to this Compose project (`com.docker.compose.project=agenticremote-e2e`, `com.docker.compose.service=android-emulator`), was `Up` but perpetually `starting`, and was previously measured crash-looping at 59.50% CPU. It was the host-contention contributor to Iteration 33's misleading storage-preflight timeout, not a storage or fix defect.

Used the prescribed rootful Compose entrypoint rather than raw Podman removal: `./scripts/compose.sh rm --stop --force android-emulator`. The command stopped and removed that sole service container. `./scripts/compose.sh ps` immediately afterward confirmed `agenticremote-e2e-provider-1` and `agenticremote-e2e-daemon-1` remain up; neither was stopped, restarted, or removed. No volumes, networks, images, or unrelated containers were pruned or deleted.

Classification: `INFRA_BUG` — the failed Android invocation left its own crash-looping service running. This cleanup restores an uncontended lab state for the required next Golden Flow rerun; it does not reclassify the Iteration 33 capacity preflight, which independently passed when its `podman info` subprocess completed.

## Iteration 35 — 2026-10-02T08:41:02Z: Golden Flow after portable KVM gid fix and stale-container cleanup — BLOCKED at host KVM preflight (not storage)

Executed canonical `./scripts/test-android.sh` exactly once from a clean tracked state (HEAD `68e03a9`) after committing the portable KVM gid fix and the scoped stale-container cleanup. Full stdout/stderr and exit record: `e2e-lab/artifacts/runtime-verification/android-golden-flow-run-20261002T084102Z.log`.

Result: `BLOCKED`, `KVM_UNAVAILABLE`, exit 1, wall time 6.25s. The runner reached and passed the rootful storage preflight in this same invocation: `117830033408` available bytes at `/var/lib/containers/storage` against `8372800000` required. The runner artifact records the same `storagePreflight.status=PASS`, rootful GraphRoot `/var/lib/containers/storage`, and then blocks at the corrected host-side `/dev/kvm` access guard because the invoking `momodding` session has neither host `kvm` group membership nor a logind seat ACL.

This is the intended fast-fail behavior from Iteration 32's guard correction and confirms the prior `BLOCKED_STORAGE_CONTEXT` timeout did not recur after removing the crash-looping leftover. The portable Compose substitution was separately verified immediately before this run: `./scripts/compose.sh config` rendered `android-emulator.group_add` as the live `/dev/kvm` gid (`994` on this host), sourced at invocation time rather than checked into `compose.yaml`.

Post-run `./scripts/compose.sh ps` confirmed only the healthy provider and daemon remain; no Android emulator container was created because preflight stopped before Compose startup. Classification: `BLOCKED_EXTERNAL` host KVM authorization — not storage, timeout, or a regression in the portable container gid fix. Host-admin follow-up remains: add `momodding` to `kvm` and begin a new login, or run from a seat-attached session with a logind-granted `/dev/kvm` ACL.

## Iteration 36 — 2026-10-02: Harden rootful Podman-info storage preflight timeout and diagnostics (TEST_HARNESS_BUG, not storage)

Fixed the pre-existing false `BLOCKED_STORAGE_CONTEXT` source identified in Iteration 33. `rootfulCommand` now receives the named, documented `PODMAN_INFO_PREFLIGHT_TIMEOUT_MS = 30_000` budget for the authorized `sudo -n -- podman info --format '{{json .}}'` call. This changes only the Podman-info storage preflight; Compose, emulator, build, ADB, and Maestro timeouts remain unchanged.

The preflight result now retains `proc.error` in `AndroidStorageCommandResult` and reports its code/message ahead of empty stdout/stderr/status. Thus Bun's timeout result is actionable (for example, `Podman info failed: ETIMEDOUT: spawnSync sudo ETIMEDOUT`) rather than indistinguishable from a genuine exit-status-1 Podman failure. Genuine nonzero command failures remain `BLOCKED_STORAGE_CONTEXT` and continue to surface stderr/stdout/status when no process error exists.

Focused regression coverage in `android/storage-preflight.test.ts` verifies the named 30-second budget crosses the executor boundary and an `ETIMEDOUT` process error reaches the diagnostic. `bun run android/storage-preflight.test.ts && bun run android/kvm-preflight.test.ts` passed; `bun build android/android-runner.ts --outdir <temporary-dir>` passed. Per the active host-KVM blocker, no Android Golden Flow rerun was performed and no container/environment state was changed.

Classification: `TEST_HARNESS_BUG` fixed. The remaining acceptance prerequisite is external host authorization: add `momodding` to host group `kvm` and start a new login session, or execute from a seat-attached session with a logind-granted `/dev/kvm` ACL. Until one is true, the runner must remain correctly `BLOCKED` at KVM preflight.

## Iteration 37 — 2026-10-02T08:49:13Z: Final provenance and independent Web PASS evidence index (Android externally blocked)

Captured `e2e-lab/artifacts/runtime-verification/android-final-provenance-20261002T084913Z.json` at current HEAD `60dc945d527adf8d19be429ee851b83a90d3cdda` with a clean `git status --short`. It records the retained authoritative APK `e2e-lab/artifacts/android-b04-x86-app-debug.apk` (SHA-256 `737c630ee279f6445b111e58984e05085a1f354444da5710d0041f2da780b8d0`), pinned image `budtmo/docker-android:emulator_14.0_v3.7.0-p0@sha256:7826cd345543736c9502293926f383af4ca9caf96bd47d12d15bce8d31fd9894`, and the last confirmed canonical rootful Podman context: GraphRoot `/var/lib/containers/storage`, `117830033408` bytes available, `8372800000` required, storage preflight `PASS` (observed 2026-10-02T08:41:02Z).

The same artifact truthfully records the last Android result as `BLOCKED`/`KVM_UNAVAILABLE` (exit 1, wall 6.25s), not PASS. External prerequisite remains exact: a host administrator must add `momodding` to host group `kvm` and begin a new login session, or execute the runner from a seat-attached session with a logind-granted `/dev/kvm` ACL. No Android Golden Flow, Podman/storage check, or container operation was attempted for this bookkeeping pass.

Independently inspected existing Web Playwright evidence `web-acceptance-20261002T043534Z.{stdout.log,stderr.log,exit}`: runner exit 0; authenticated live Auth-v2 browser suite `PASS`, 9/9 passed and 0 failed, from 2026-10-02T04:35:34.590242Z to 04:43:41.377387Z. Its actual tested commit is `afa2bda3a64ee09e6a08386138f5aac639c3d3dc`, which differs from current HEAD `60dc945d527adf8d19be429ee851b83a90d3cdda`. This is independent historical Web evidence only and does not imply Android runtime PASS or Web validation at current HEAD.

## Iteration 38 — 2026-10-05T03:00:24Z: Rootful Android KVM mapping preflight

Reclassified the prior host-user `/dev/kvm` gate as a harness bug for the rootful path. Rootful Podman, not the invoking `momodding` account, maps the host device; host-user group/ACL access is no longer a runner gate and no host permission, group, ACL, udev, sudoers, root runtime, or privileged-container change was made.

`android-runner.ts` now verifies `/dev/kvm` exists and is a character device, confirms canonical unattended rootful Podman authorization through `sudo -n -- /home/linuxbrew/.linuxbrew/bin/podman info`, then runs a bounded `compose.sh run --rm --no-deps` probe against the real `android-emulator` service as `androidusr`. This is the single authoritative Compose service configuration for both the probe and the real emulator, including `/dev/kvm:/dev/kvm:rwm` and the runtime-resolved numeric `group_add` gid generated by `compose.sh`; no gid is hard-coded. The probe verifies actual read/write access and an `O_RDWR` open.

The distinct outcomes are `KVM_DEVICE_MISSING`, `ROOTFUL_PODMAN_AUTH_UNAVAILABLE`, `ROOTFUL_KVM_MAPPING_FAILED`, and `ROOTFUL_KVM_PERMISSION_FAILED`. Regression cases A–F cover missing device, non-character device, rootful authorization failure, mapping failure, androidusr permission failure, and successful exact Compose-service probing. `bun run android/kvm-preflight.test.ts`, `bun run android/storage-preflight.test.ts`, and `bun build android/android-runner.ts --outdir /tmp/android-rootful-kvm-build` passed.

Audited `android/patches/emulator-kvm-fix.py`: it has always been an `O_RDWR` capability check only; it neither invokes nor skips an upstream `chown`. Retained it as compatible with `group_add`, renamed its method/log to describe the actual emulator-identity KVM access check, and made no unsupported host-chown claim.

## Iteration 39 — 2026-10-05T03:07:03Z: Rootful KVM runtime succeeded; blocked at Android Debug Bridge discovery

The real `android-emulator` service was launched through the canonical `./scripts/run-android-emulator-only.sh` → `compose.sh` rootful Compose path after `checkRootfulKvmMapping()` returned `PASS` with dynamic gid `994`. The resulting container was `e9a5cdb3d96712aa8181d761b1949a179fede981453c24691007978f375b7486`, using the pinned `docker.io/budtmo/docker-android@sha256:7826cd345543736c9502293926f383af4ca9caf96bd47d12d15bce8d31fd9894` image. Runtime inspection confirmed `androidusr` (`uid=1300`, gid `1301`) has supplementary gid `994`; `/dev/kvm` is a mode `660`, root:994 character device; and `qemu-system-x86_64` is running with `-accel on`.

The next prescribed emulator verification boundary, `./scripts/verify-android-emulator-only.sh`, stopped before connecting ADB or polling boot because it reported `FAIL: adb is required on PATH.` The canonical SDK binary exists at `/home/momodding/android-sdk/platform-tools/adb`, but that verification script does not resolve or add the configured SDK platform-tools directory. This is an Android harness PATH-resolution failure, not KVM mapping, Android boot, a system ANR, pairing, or a Golden Flow result. No ADB command, build, installation, Android UI flow, or Golden Flow ran after the failure, so no Android acceptance PASS is claimed.

Detailed immutable runtime evidence is retained in `e2e-lab/artifacts/runtime-verification/android-rootful-kvm-boot-boundary-20261005T030703Z.txt`. No host permissions, group/ACL/udev/sudoers setting, container privilege, or runtime identity was changed; no healthy provider or daemon container was modified.

## Iteration 40 — 2026-10-05T03:35:27Z: Existing-SDK ADB resolution and rootful boot boundary passed

Fixed the harness-only ADB discovery boundary without installing or downloading another SDK. `resolveAndroidAdbExecutable()` now selects an executable existing SDK candidate before Android launch work (configured `ANDROID_HOME`, `ANDROID_SDK_ROOT`, home SDK, then the historical runtime fallback), logs the selected absolute path, and reports every searched path when unavailable. The standalone verifier independently follows the same existing-SDK policy and rejects non-executable candidates. Focused checks passed: `bun e2e-lab/android/env.test.ts` and `bun e2e-lab/maestro/flows/pairing-flow.test.ts`.

The already-running canonical rootful `android-emulator` service passed the prescribed post-fix boundary twice. The retained transcript `e2e-lab/artifacts/runtime-verification/android-rootful-kvm-adb-boot-boundary-20261005T033527Z.txt` records selection of `/home/momodding/android-sdk/platform-tools/adb`, successful `adb connect 127.0.0.1:5555`, `get-state: device`, `sys.boot_completed: 1`, and `pm list packages`, ending `PASS: android-emulator booted and ADB package listing succeeded on 127.0.0.1:5555.` This proves only the rootful KVM-to-ADB boot boundary; it does not prove installation, pairing, Android UI behavior, or Golden Flow acceptance.

Pairing automation now operates the visible control rather than relying on a caller-side/pre-seeded preference: the React Native switch exposes stable automation id `skip-fingerprint-verification`, accessibility label `Skip fingerprint verification`, and its `checked` state; `pairing-flow.yaml` asserts unchecked, taps the id, then asserts checked before Connect. Payload provisioning and UI execution remain separate acceptance prerequisites.

## Iteration 41 — 2026-10-05T03:59:53Z: Maestro host-ADB discovery repaired; system ANR blocked UI flows

`maestro --version` was not hung: the installed `/home/momodding/.maestro/bin/maestro` is version `2.10.0` with Java 17, but cold startup took about 16 seconds and exceeded the earlier 15-second probe. Its documented `--device` selection uses the exact ADB serial. Before repair, the resolved host SDK ADB (`/home/momodding/android-sdk/platform-tools/adb`) listed target `127.0.0.1:5555` as `device` while Maestro selected no device and reported `Device with id 127.0.0.1:5555 is not connected`; the host had duplicate `momodding` ADB-server processes and an unrelated offline transport. This was a `TOOLING_CONFIG_BUG`, not an emulator-networking, KVM, storage, or device-serial mismatch.

Restarted only the host ADB server through `/home/momodding/android-sdk/platform-tools/adb kill-server`, `start-server`, and `connect 127.0.0.1:5555`. The post-restart exact `adb devices -l` result was `127.0.0.1:5555 device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:2` (plus a separate `emulator-5554` device). The successful live command was `env PATH=/home/momodding/android-sdk/platform-tools:/home/momodding/.maestro/bin:$PATH ANDROID_HOME=/home/momodding/android-sdk ANDROID_SDK_ROOT=/home/momodding/android-sdk /home/momodding/.maestro/bin/maestro --verbose --platform android --device 127.0.0.1:5555 hierarchy`. No rootful Compose networking or emulator configuration changed.

This was the existing operator-pinned `agenticremote-e2e-android-emulator-1` container (`e9a5cdb3d96712aa8181d761b1949a179fede981453c24691007978f375b7486`) on `docker.io/budtmo/docker-android@sha256:7826cd345543736c9502293926f383af4ca9caf96bd47d12d15bce8d31fd9894`; prior live inspection recorded `qemu-system-x86_64 ... -accel on`, `androidusr` uid 1300 with supplementary KVM gid 994, and mapped mode-660 `/dev/kvm`. Those are context only, not a remediation or cause for the ANR.

The successful live Maestro hierarchy exposed a blocking system dialog: `Pixel Launcher isn't responding`, with only `Close app` and `Wait` actions. Full stdout/stderr/hierarchy is force-retained at `e2e-lab/artifacts/runtime-verification/android-maestro-system-anr-20261005T035953Z.txt`. Android acceptance is `BLOCKED_EXTERNAL: system-level emulator/Pixel Launcher ANR` after Maestro connected; it is not KVM, storage, or network, and is not a Golden Flow failure. UI pairing, terminal, and agent flows were not run; no image, Gradle, JDK, or alternative-emulator change was made.
