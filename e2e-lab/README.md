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
│   ├── setup-android-sdk.sh  # Android SDK & AVD configuration check
│   ├── build-images.sh       # Container image validator / topology probe
│   ├── up.sh                 # Test topology bringup
│   ├── down.sh               # Test topology teardown
│   ├── test-backend.sh       # Strict Golden Flow backend verification (make verify-phase1-4)
│   ├── test-web.sh           # Web client Expo server & Playwright runner
│   ├── test-android.sh       # Android mobile KVM/emulator/Maestro runner
│   ├── test-security.sh      # Repository, runtime, and artifact secret leak scanner
│   └── test-all.sh           # Unified orchestrator emitting final-report.md
├── doctor/                   # TypeScript system doctor implementation
├── bootstrap/                # Bootstrap TypeScript module
├── android-setup/            # Android setup TypeScript module
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
| **Bun** | 1.3+ (`1.3.14` installed) | Fast TypeScript test runner |
| **Node.js** | 20+ (`v22.22.2` installed) | JavaScript client runtime |
| **tmux** | 3.2+ (`3.4` installed) | Backend PTY session management |
| **Oh My Pi (OMP)** | 18.1+ (`omp/18.1.22` installed) | Real agent integration and golden flows |
| **Android SDK** | API 35 (`/home/momodding/android-sdk`) | Android mobile testing |
| **KVM Virtualization** | `/dev/kvm` (read/write access) | Hardware acceleration for Android emulator |
| **Maestro CLI** | 1.38+ | Mobile UI end-to-end automation |

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
3. **Build Android Debug APK**:
   ```bash
   cd client && bun run prebuild && cd android && ./gradlew assembleDebug
   ```
4. **Start Web Client Server**:
   ```bash
   cd client && bun install && npx expo start --web --port 8081
   ```
