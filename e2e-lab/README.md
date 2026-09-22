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
| **Podman** | rootless | Daemon/provider E2E topology |
| **Browser runner** | pinned ephemeral Playwright | Chromium is stored only under `.runtime/browser` |

### Linux Podman rootfs fallback

The topology scripts first run a no-pull `/bin/sh` probe against the locally cached `docker.io/oven/bun:latest`. On Linux, if that probe fails and `/usr/bin/podman` is available, they switch only the lab invocation to `/usr/bin/podman` with `e2e-lab/.runtime/podman-system-storage.conf`. That configuration stores layers under `.runtime/podman-system-{graphroot,runroot}`; it never changes or prunes global Podman storage.

Set `CONTAINERS_STORAGE_CONF` to use your own storage configuration; that direct override is preserved. `./scripts/cleanup.sh` removes the fallback configuration and its two storage roots after tearing down lab containers and network.

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

### 4. Run All Phases & Generate Report
```bash
./scripts/test-all.sh
```
*Outputs truthful summary and writes `e2e-lab/artifacts/final-report.md` at runtime.*

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
./scripts/cleanup.sh                 # E2E containers/network, generated Android runtime output, web export, and E2E reports
./scripts/cleanup.sh --deep          # also E2E-owned browser/Gradle/helper caches and the pinned Docker-Android image
./scripts/cleanup.sh --dependencies  # preview only; never deletes dependencies
```

## Storage Snapshots

```bash
./scripts/storage-report.sh baseline  # before a cleanup run
./scripts/storage-report.sh after     # after a cleanup run
```

Each snapshot records only lab/client paths plus the pinned Docker-Android image when present; it never reports global cache totals.
