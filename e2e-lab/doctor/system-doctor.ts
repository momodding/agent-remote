import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface DoctorCheck {
  id: string;
  name: string;
  status: 'READY' | 'MISSING' | 'BLOCKED_ENVIRONMENT' | 'WARN';
  versionOrPath: string;
  details: string;
  remediation?: string;
}

export interface DoctorReport {
  timestamp: string;
  checks: DoctorCheck[];
  overallEnvironmentStatus: 'READY' | 'BLOCKED_ENVIRONMENT';
}

function runCmd(cmd: string, env?: Record<string, string>, timeoutMs = 15000): string | null {
  const home = process.env.HOME || '/root';
  const baseEnvPath = env?.PATH || process.env.PATH || '';
  const resolvedPath = `${home}/.bun/bin:${home}/go/bin:${home}/.local/bin:${home}/.maestro/bin:${baseEnvPath}`;
  try {
    const out = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...process.env,
        ...env,
        PATH: resolvedPath,
      },
      timeout: timeoutMs,
    });
    return out.trim();
  } catch {
    return null;
  }
}

function packageRemediation(formula: string, linuxInstruction: string): string {
  return process.platform === 'darwin' ? `Install with Homebrew: brew install ${formula}` : linuxInstruction;
}

export function runSystemDoctor(): DoctorReport {
  const checks: DoctorCheck[] = [];

  // 1. Go Toolchain
  const goVer = runCmd('go version');
  if (goVer) {
    checks.push({
      id: 'DOC-01',
      name: 'Go Compiler Toolchain',
      status: 'READY',
      versionOrPath: goVer,
      details: 'Go compiler available for backend build and tests.',
    });
  } else {
    checks.push({
      id: 'DOC-01',
      name: 'Go Compiler Toolchain',
      status: 'BLOCKED_ENVIRONMENT',
      versionOrPath: 'not found',
      details: 'Go compiler is missing from PATH.',
      remediation: 'Install Go 1.26.4: https://go.dev/dl/',
    });
  }

  // 2. Bun Runtime
  const bunVer = runCmd('bun --version');
  if (bunVer) {
    checks.push({
      id: 'DOC-02',
      name: 'Bun Runtime',
      status: 'READY',
      versionOrPath: `Bun v${bunVer}`,
      details: 'Bun builds the canonical Expo web export and runs the lab scripts.',
    });
  } else {
    checks.push({
      id: 'DOC-02',
      name: 'Bun Runtime',
      status: 'BLOCKED_ENVIRONMENT',
      versionOrPath: 'not found',
      details: 'Bun is required for the E2E lab.',
      remediation: 'Install Bun: https://bun.sh',
    });
  }

  // 3. Tmux Multiplexer
  const tmuxVer = runCmd('tmux -V');
  if (tmuxVer) {
    checks.push({
      id: 'DOC-03',
      name: 'Terminal Multiplexer (tmux)',
      status: 'READY',
      versionOrPath: tmuxVer,
      details: 'tmux binary available for PTY daemon sessions.',
    });
  } else {
    checks.push({
      id: 'DOC-03',
      name: 'Terminal Multiplexer (tmux)',
      status: 'BLOCKED_ENVIRONMENT',
      versionOrPath: 'not found',
      details: 'tmux is required by the backend daemon for terminal session management.',
      remediation: 'sudo apt install -y tmux',
    });
  }

  // 4. OMP Binary
  const ompVer = runCmd('omp --version');
  if (ompVer) {
    checks.push({
      id: 'DOC-04',
      name: 'Oh My Pi (OMP) Binary',
      status: 'READY',
      versionOrPath: ompVer,
      details: 'OMP binary installed and responsive for golden flow tests.',
    });
  } else {
    checks.push({
      id: 'DOC-04',
      name: 'Oh My Pi (OMP) Binary',
      status: 'BLOCKED_ENVIRONMENT',
      versionOrPath: 'not found',
      details: 'OMP CLI binary required for agent verification.',
      remediation: 'bun add -g @oh-my-pi/pi-coding-agent@18.1.22',
    });
  }

  // 5. Android Debug Bridge
  const adbVer = runCmd('adb version');
  if (adbVer) {
    checks.push({
      id: 'DOC-05',
      name: 'Android Debug Bridge (adb)',
      status: 'READY',
      versionOrPath: adbVer.split('\n')[0],
      details: 'ADB is available for the containerized Android runner.',
    });
  } else {
    checks.push({
      id: 'DOC-05',
      name: 'Android Debug Bridge (adb)',
      status: 'BLOCKED_ENVIRONMENT',
      versionOrPath: 'not found',
      details: 'adb is required; no native Android SDK, emulator, or system image is required.',
      remediation: packageRemediation('android-platform-tools', 'Install Android platform-tools so adb is on PATH.'),
    });
  }

  // 6. Hardware Virtualization / KVM
  if (fs.existsSync('/dev/kvm')) {
    try {
      fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
      checks.push({
        id: 'DOC-06',
        name: 'Hardware Virtualization (/dev/kvm)',
        status: 'READY',
        versionOrPath: '/dev/kvm (rw)',
        details: 'KVM hardware acceleration is accessible.',
      });
    } catch {
      checks.push({
        id: 'DOC-06',
        name: 'Hardware Virtualization (/dev/kvm)',
        status: 'BLOCKED_ENVIRONMENT',
        versionOrPath: '/dev/kvm (permission denied)',
        details: 'User does not have read/write access to /dev/kvm. Android emulator fails with accel 11.',
        remediation: 'sudo usermod -aG kvm $USER && newgrp kvm',
      });
    }
  } else {
    checks.push({
      id: 'DOC-06',
      name: 'Hardware Virtualization (/dev/kvm)',
      status: 'BLOCKED_ENVIRONMENT',
      versionOrPath: 'not found',
      details: '/dev/kvm character device missing. CPU virtualization disabled.',
      remediation: 'Enable AMD-V/VT-x in BIOS.',
    });
  }

  // 7. Maestro CLI
  const maestroVer = runCmd('maestro --version');
  if (maestroVer) {
    checks.push({
      id: 'DOC-07',
      name: 'Maestro Mobile UI Automation',
      status: 'READY',
      versionOrPath: maestroVer,
      details: 'Maestro CLI available for Android UI testing.',
    });
  } else {
    checks.push({
      id: 'DOC-07',
      name: 'Maestro Mobile UI Automation',
      status: 'BLOCKED_ENVIRONMENT',
      versionOrPath: 'not found',
      details: 'Maestro CLI binary not installed in PATH.',
      remediation: 'curl -fsSL "https://get.maestro.mobile.dev" | bash',
    });
  }

  // 8. Podman Container Runtime
  const podmanVer = runCmd('podman --version');
  if (podmanVer) {
    checks.push({
      id: 'DOC-08',
      name: 'Rootless Podman Container Runtime',
      status: 'READY',
      versionOrPath: podmanVer,
      details: 'Podman is available for running hermetic multi-container E2E topology.',
    });
  } else {
    checks.push({
      id: 'DOC-08',
      name: 'Rootless Podman Container Runtime',
      status: 'BLOCKED_ENVIRONMENT',
      versionOrPath: 'not found',
      details: 'Podman is required for the daemon/provider E2E topology.',
      remediation: packageRemediation('podman', 'Install Podman 4.0+ with your Linux distribution package manager.'),
    });
  }

  // 9. Pinned ephemeral browser runner
  const playwrightVer = runCmd('.runtime/node_modules/.bin/playwright --version', undefined, 30000);
  if (playwrightVer) {
    checks.push({
      id: 'DOC-09',
      name: 'Browser E2E Capability',
      status: 'READY',
      versionOrPath: playwrightVer,
      details: 'Playwright @1.63.0 installed locally in .runtime/node_modules; Chromium cached at .runtime/browser.',
    });
  } else {
    checks.push({
      id: 'DOC-09',
      name: 'Browser E2E Capability',
      status: 'BLOCKED_ENVIRONMENT',
      versionOrPath: 'not available',
      details: 'The pinned ephemeral Playwright runner could not start.',
      remediation: 'Ensure Bun can download @playwright/test@1.63.0 and Chromium.',
    });
  }

  // Treat any MISSING or BLOCKED_ENVIRONMENT check as blocking the environment
  const isBlocked = checks.some((c) => c.status === 'BLOCKED_ENVIRONMENT' || c.status === 'MISSING');

  const report: DoctorReport = {
    timestamp: new Date().toISOString(),
    checks,
    overallEnvironmentStatus: isBlocked ? 'BLOCKED_ENVIRONMENT' : 'READY',
  };

  const artifactsDir = path.join(__dirname, '../artifacts');
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(artifactsDir, 'doctor-report.json'),
    JSON.stringify(report, null, 2),
    'utf-8'
  );

  return report;
}

if (import.meta.main) {
  const report = runSystemDoctor();
  console.log(`System Doctor Status: ${report.overallEnvironmentStatus}`);
  for (const c of report.checks) {
    console.log(`[${c.status}] ${c.id}: ${c.name} -> ${c.versionOrPath}`);
    if (c.remediation && c.status !== 'READY') {
      console.log(`       Remedy: ${c.remediation}`);
    }
  }
}
