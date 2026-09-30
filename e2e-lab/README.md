# agenticRemote E2E Test Lab & Diagnostic Harness

Comprehensive, truthful end-to-end verification and diagnostic testing harness for **agenticRemote**.

## Architecture Overview

```
e2e-lab/
├── env/
│   ├── versions.env          # Pinned toolchain and dependency versions
│   └── e2e.env.example       # Example environment variables
├── scripts/
│   ├── bootstrap-host.sh     # Prepare environment without touching production files
│   ├── doctor.sh             # System prerequisite diagnostics
│   ├── build-images.sh       # Builds provider and daemon topology images
│   ├── cleanup.sh            # Bounded normal/deep E2E cleanup
│   ├── up.sh                 # Test topology bringup
│   ├── down.sh               # Test topology teardown
│   ├── test-backend.sh       # Strict Golden Flow backend verification (make verify-phase1-4)
│   ├── test-web.sh           # Canonical Expo export and pinned browser runner
│   ├── test-android.sh       # Android mobile KVM/Maestro runner
│   ├── test-security.sh      # Repository, runtime, and artifact secret leak scanner
│   └── test-all.sh           # Unified orchestrator emitting final-report.md
├── doctor/                   # TypeScript system doctor implementation
├── bootstrap/                # Bootstrap TypeScript module
├── backend/                  # Backend runner module
├── web/                      # Web runner module
├── android/                  # Android runner module
├── security/                 # Security leak scanner module
├── artifacts/                # Ephemeral test logs & reports (gitignored, .gitkeep preserved)
├── test-all.ts               # Unified TypeScript runner
├── package.json
└── tsconfig.json
```

## System Requirements & Prerequisites

| Component | Required Version / Spec | Purpose |
|---|---|---|
| **Go** | 1.22+ (`go1.26.4` installed) | Daemon compilation and Go test suite |
| **Bun** | 1.3+ | Builds the canonical Expo web export and runs the lab |
| **tmux** | 3.2+ | Backend PTY session management |
| **Oh My Pi (OMP)** | 18.1+ | Real agent integration and golden flows |
| **adb** | platform-tools | Android runner connectivity; no native SDK/emulator required |
| **KVM Virtualization** | `/dev/kvm` (read/write access) | Containerized Android emulator acceleration |
| **Maestro CLI** | 1.38+ | Mobile UI end-to-end automation |
| **Podman Compose** | rootful via `sudo -n /home/linuxbrew/.linuxbrew/bin/podman` | Provider, daemon, and Android topology |
| **Browser runner** | pinned ephemeral Playwright | Chromium is stored only under `.runtime/browser` |

### Rootful Compose access

The E2E topology is rootful and is invoked only through `./scripts/compose.sh`; it does not fall back to rootless Podman. Every non-root operation uses `sudo -n "$E2E_PODMAN_BIN"`, defaulting to `/home/linuxbrew/.linuxbrew/bin/podman`. Legacy rootless storage, when present, remains separate and is reported as read-only contamination by cleanup checks.

## Usage Guide

### 1. Run Diagnostic Doctor
```bash
./scripts/doctor.sh
```

### 2. Run Strict Backend Verification (Real OMP + tmux)
```bash
./scripts/test-backend.sh
```
*Executes `make verify-phase1-4` with `AGENTICREMOTE_STRICT_INTEGRATION=1`. Detects and rejects any skips in mandatory `TestGoldenFlowHermeticPhase1to4`.*

### 3. Run Security & Secret Leak Scanner
```bash
./scripts/test-security.sh
```
*Scans repository, `e2e-lab/.runtime`, `e2e-lab/artifacts`, and test-owned `/tmp/runtime*` logs. Reports offending file paths only and redacts secret values.*

### 5. Doctor Statuses and Failure Categories

`./scripts/doctor.sh` reports each prerequisite as **READY**, **WARN**, **MISSING**, or **BLOCKED_ENVIRONMENT**. READY permits the relevant work; WARN indicates reduced capability; MISSING and BLOCKED_ENVIRONMENT require host remediation before that work can proceed.

The orchestrator reports a failed mandatory phase as **FAIL** and an unavailable host prerequisite as **BLOCKED_ENVIRONMENT**. Fix the reported prerequisite, then resume with the smallest relevant command:

```bash
./scripts/doctor.sh
./scripts/up.sh
./scripts/test-all.sh
```

### 6. Rootful Compose Workflow

The rootful topology is managed only through `./scripts/compose.sh`, which supplies the lab's `compose.yaml` and project name to Podman Compose. Check the rendered configuration and current containers, start the topology, inspect logs, and tear it down with:

```bash
./scripts/compose.sh config
./scripts/compose.sh ps
./scripts/compose.sh up
./scripts/compose.sh logs
./scripts/compose.sh logs provider
./scripts/compose.sh logs daemon
./scripts/compose.sh logs android-emulator
./scripts/compose.sh down
```

The service names are lowercase: `provider`, `daemon`, and `android-emulator`. `compose.sh` reports an external blocker and exits with status 69 when its rootful prerequisites are unavailable; rely on its output for the specific cause.

For privileged debugging only, run the equivalent command from `e2e-lab` explicitly; normal lifecycle commands must continue to use `compose.sh`:

```bash
sudo -n /home/linuxbrew/.linuxbrew/bin/podman compose --file ./compose.yaml --project-directory . --project-name agenticremote-e2e ps
```

Rootful Compose requires noninteractive authorization for the configured Podman binary and its Compose subcommand. `compose.sh` and the doctor verify `sudo -n "$E2E_PODMAN_BIN" --version` and `sudo -n "$E2E_PODMAN_BIN" compose version`; they do not use `sudo -n true`. If local security policy permits it, an administrator may grant a narrowly constrained authorization for that command. Treat that as a security-sensitive decision: this repository never creates, changes, or installs sudoers entries automatically.

`compose.yaml` defines these labeled, project-owned named volumes:

- `daemon-state` — daemon state.
- `daemon-workspace` — daemon workspace.
- `android-runtime` — Android emulator runtime data.
- `android-build` — Android build output.

It also defines the labeled `agenticremote-e2e-rootful-net` network. The provider, daemon, and Android emulator are attached to that network; their published ports are bound to loopback.

Rootless storage under `.runtime/podman-system-graphroot` and `.runtime/podman-system-runroot` is a legacy, separate host-side fallback. It is not storage used by the current rootful Compose project.

Warning: rootful Compose and rootless Podman use different storage and resource namespaces. Do not inspect, clean, or troubleshoot the rootful project with rootless Podman commands; use `compose.sh` (or the explicit privileged form above). Legacy rootless resources are reported read-only as contamination and are never adopted by the rootful project.

### 7. Running and Cleaning Up

```bash
./scripts/up.sh
./scripts/down.sh
./scripts/reset.sh
./scripts/cleanup.sh
./scripts/doctor.sh
./scripts/test-all.sh
```

Use `up.sh` to bring up the test topology, `down.sh` to stop it, `reset.sh` to reset the lab, `cleanup.sh` to remove lab-owned generated resources, `doctor.sh` to diagnose prerequisites, and `test-all.sh` to run the ordered E2E flow. After a failure, correct the reported category, rerun `doctor.sh` for prerequisite issues or `up.sh` for topology startup, then continue with `test-all.sh`.
## Environment Blockers & Remediation

When host environment prerequisites (such as KVM hardware acceleration or Maestro CLI) are not available, the harness fails closed and reports:
`BLOCKED_ENVIRONMENT, Phase1-4 NOT YET VERIFIED`

### Remediation Steps:
1. **Grant user KVM access**:
   ```bash
   sudo usermod -aG kvm $USER && newgrp kvm
   ```
2. **Install Maestro CLI**:
   ```bash
   curl -fsSL "https://get.maestro.mobile.dev" | bash
   ```
3. **Build Android Debug APK in Docker-Android**:
   ```bash
   ./scripts/test-android.sh
   ```
   The Android runner builds with Gradle in the pinned Docker-Android image; it does not use host-native Gradle.
4. **Start the canonical web topology and export**:
   ```bash
   ./scripts/up.sh
   ```
   This builds missing local provider/daemon images, builds `client/dist` using `client/node_modules`, and serves it on port 8081. To build the topology images explicitly, run `./scripts/build-images.sh` first.

## Bounded Cleanup

```bash
./scripts/cleanup.sh                 # Removes only Compose-scoped resources and generated lab output
./scripts/cleanup.sh --deep          # Also removes E2E-owned browser/Gradle/helper caches; never removes the pinned Android image
./scripts/cleanup.sh --dependencies  # Preview only; never deletes dependencies
```

## Storage Snapshots

```bash
./scripts/storage-report.sh baseline  # before a cleanup run
./scripts/storage-report.sh after     # after a cleanup run
```

Each snapshot records only lab/client paths plus the pinned Docker-Android image when present; it never reports global cache totals.
