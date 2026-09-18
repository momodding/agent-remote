import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface DoctorCheck {
  id: string;
  name: string;
  status: 'READY' | 'MISSING' | 'BLOCKED_ENVIRONMENT' | 'WARN';
  versionOrPath?: string;
  details: string;
  remediation?: string;
}

export interface DoctorReport {
  timestamp: string;
  checks: DoctorCheck[];
  overallEnvironmentStatus: 'READY' | 'BLOCKED_ENVIRONMENT';
}

function runCmd(cmd: string, env?: Record<string, string>): string | null {
  try {
    const out = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: env ? { ...process.env, ...env } : process.env,
      timeout: 5000,
    });
    return out.trim();
  } catch {
    return null;
  }
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

  // 2. Bun & Node Runtime
  const bunVer = runCmd('bun --version');
  const nodeVer = runCmd('node --version');
  if (bunVer && nodeVer) {
    checks.push({
      id: 'DOC-02',
      name: 'JavaScript / TypeScript Runtime (Bun + Node)',
      status: 'READY',
      versionOrPath: `Bun v${bunVer} / Node ${nodeVer}`,
      details: 'Bun and Node are available for Expo, Playwright, and provider scripts.',
    });
  } else {
    checks.push({
      id: 'DOC-02',
      name: 'JavaScript / TypeScript Runtime (Bun + Node)',
      status: 'BLOCKED_ENVIRONMENT',
      versionOrPath: 'missing',
      details: 'Bun and Node are required.',
      remediation: 'Install Bun (https://bun.sh) and Node.js.',
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

  // 5. Android SDK & ADB
  const home = process.env.HOME || '/root';
  const sdkRoot = process.env.ANDROID_HOME || path.join(home, 'android-sdk');
  const androidEnv = {
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
    PATH: `${sdkRoot}/platform-tools:${sdkRoot}/cmdline-tools/latest/bin:${sdkRoot}/emulator:${process.env.PATH || ''}`,
  };

  const adbVer = runCmd('adb version', androidEnv);
  if (fs.existsSync(sdkRoot) && adbVer) {
    checks.push({
      id: 'DOC-05',
      name: 'Android SDK & ADB',
      status: 'READY',
      versionOrPath: `${sdkRoot} (${adbVer.split('\n')[0]})`,
      details: 'Android SDK and ADB platform-tools located.',
    });
  } else {
    checks.push({
      id: 'DOC-05',
      name: 'Android SDK & ADB',
      status: 'BLOCKED_ENVIRONMENT',
      versionOrPath: 'not found',
      details: 'Android SDK commandline-tools or ADB missing.',
      remediation: './scripts/setup-android-sdk.sh',
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
  const maestroVer = runCmd('maestro --version', androidEnv);
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

  // 8. Rootless Podman Container Runtime
  const podmanVer = runCmd('podman --version');
  if (podmanVer) {
    checks.push({
      id: 'DOC-08',
      name: 'Rootless Podman Container Runtime',
      status: 'READY',
      versionOrPath: podmanVer,
      details: 'Podman container engine available for lab container topology.',
    });
  } else {
    checks.push({
      id: 'DOC-08',
      name: 'Rootless Podman Container Runtime',
      status: 'BLOCKED_ENVIRONMENT',
      versionOrPath: 'not found',
      details: 'Podman binary is required for rootless daemon and provider container topology.',
      remediation: 'sudo apt install -y podman',
    });
  }

  const blocked = checks.some((c) => c.status === 'BLOCKED_ENVIRONMENT');
  const report: DoctorReport = {
    timestamp: new Date().toISOString(),
    checks,
    overallEnvironmentStatus: blocked ? 'BLOCKED_ENVIRONMENT' : 'READY',
  };

  // Write environment report to artifacts
  const artifactsDir = path.join(__dirname, '../artifacts');
  try {
    if (!fs.existsSync(artifactsDir)) {
      fs.mkdirSync(artifactsDir, { recursive: true });
    }
    fs.writeFileSync(path.join(artifactsDir, 'doctor-report.json'), JSON.stringify(report, null, 2), 'utf8');

    let txt = `===============================================================\n`;
    txt += `          agenticRemote E2E System Doctor Report\n`;
    txt += `===============================================================\n`;
    txt += `Timestamp: ${report.timestamp}\n`;
    txt += `Overall Status: ${report.overallEnvironmentStatus}\n\n`;
    for (const c of report.checks) {
      txt += `[${c.status}] ${c.id}: ${c.name}\n`;
      txt += `       Version/Path: ${c.versionOrPath || 'N/A'}\n`;
      txt += `       Details:      ${c.details}\n`;
      if (c.remediation) {
        txt += `       Remedy:       ${c.remediation}\n`;
      }
      txt += `\n`;
    }
    fs.writeFileSync(path.join(artifactsDir, 'environment-report.txt'), txt, 'utf8');
  } catch (err) {
    console.error('Failed to write doctor artifacts:', err);
  }

  return report;
}

if (import.meta.main) {
  const rep = runSystemDoctor();
  console.log(`System Doctor Status: ${rep.overallEnvironmentStatus}`);
  for (const c of rep.checks) {
    console.log(`[${c.status}] ${c.id}: ${c.name} -> ${c.versionOrPath}`);
    if (c.remediation && c.status !== 'READY') {
      console.log(`       Remedy: ${c.remediation}`);
    }
  }
}
