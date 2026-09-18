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

function runCmd(cmd: string, env?: Record<string, string>): string | null {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function runSystemDoctor(): DoctorReport {
  const checks: DoctorCheck[] = [];
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '/home/momodding/android-sdk';
  const extendedPath = `${path.join(sdkRoot, 'platform-tools')}:${path.join(sdkRoot, 'emulator')}:${path.join(sdkRoot, 'cmdline-tools/latest/bin')}:${process.env.PATH}`;
  const androidEnv = { ANDROID_HOME: sdkRoot, PATH: extendedPath };

  // 1. Go Toolchain
  const goVer = runCmd('go version');
  if (goVer) {
    checks.push({
      id: 'DOC-01',
      name: 'Go Compiler Toolchain',
      status: 'READY',
      versionOrPath: goVer,
      details: 'Go compiler available for building and testing daemon.',
    });
  } else {
    checks.push({
      id: 'DOC-01',
      name: 'Go Compiler Toolchain',
      status: 'BLOCKED_ENVIRONMENT',
      versionOrPath: 'not found',
      details: 'Go compiler is required.',
      remediation: 'Install Go 1.22+ and add to PATH.',
    });
  }

  // 2. Bun & Node
  const bunVer = runCmd('bun --version');
  const nodeVer = runCmd('node --version');
  if (bunVer && nodeVer) {
    checks.push({
      id: 'DOC-02',
      name: 'JavaScript / TypeScript Runtime (Bun + Node)',
      status: 'READY',
      versionOrPath: `Bun v${bunVer} / Node ${nodeVer}`,
      details: 'Runtimes available for client testing.',
    });
  } else {
    checks.push({
      id: 'DOC-02',
      name: 'JavaScript / TypeScript Runtime (Bun + Node)',
      status: 'BLOCKED_ENVIRONMENT',
      versionOrPath: 'missing',
      details: 'Bun and Node are required.',
      remediation: 'Install Bun and Node.js.',
    });
  }

  // 3. Tmux
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
  const ompVer = runCmd('omp --version') || runCmd('omp -v');
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
      remediation: 'Install omp binary into PATH.',
    });
  }

  // 5. Android SDK & ADB
  const adbVer = runCmd('adb version', androidEnv);
  if (fs.existsSync(sdkRoot) && adbVer) {
    checks.push({
      id: 'DOC-05',
      name: 'Android SDK & ADB',
      status: 'READY',
      versionOrPath: `${sdkRoot} (${adbVer.split('\n')[0]})`,
      details: 'Android SDK directory and adb executable accessible.',
    });
  } else {
    checks.push({
      id: 'DOC-05',
      name: 'Android SDK & ADB',
      status: 'BLOCKED_ENVIRONMENT',
      versionOrPath: 'missing/incomplete',
      details: 'Android SDK or adb not found.',
      remediation: 'Set ANDROID_HOME and install platform-tools.',
    });
  }

  // 6. KVM Acceleration (/dev/kvm)
  if (fs.existsSync('/dev/kvm')) {
    try {
      fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
      checks.push({
        id: 'DOC-06',
        name: 'Hardware Virtualization (/dev/kvm)',
        status: 'READY',
        versionOrPath: '/dev/kvm',
        details: 'Read/write access to /dev/kvm granted.',
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

  // 7. Maestro UI Test Runner
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

  const blocked = checks.some((c) => c.status === 'BLOCKED_ENVIRONMENT');

  return {
    timestamp: new Date().toISOString(),
    checks,
    overallEnvironmentStatus: blocked ? 'BLOCKED_ENVIRONMENT' : 'READY',
  };
}

if (import.meta.main) {
  const rep = runSystemDoctor();
  console.log(`System Doctor Status: ${rep.overallEnvironmentStatus}`);
  for (const c of rep.checks) {
    console.log(`[${c.status}] ${c.id}: ${c.name} -> ${c.versionOrPath}`);
    if (c.remediation) {
      console.log(`       Remedy: ${c.remediation}`);
    }
  }
}
