import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface AndroidCheckResult {
  checkId: string;
  name: string;
  status: 'PASS' | 'BLOCKED_ENVIRONMENT' | 'WARN';
  details: string;
  remediation?: string;
}

export interface Phase3SuiteReport {
  timestamp: string;
  suite: 'Phase 3 - Android E2E & Environment Diagnostics';
  status: 'BLOCKED_ENVIRONMENT' | 'READY';
  passed: number;
  blocked: number;
  warnings: number;
  total: number;
  checks: AndroidCheckResult[];
  remediationSteps: string[];
}

export function runAndroidDoctor(): Phase3SuiteReport {
  const checks: AndroidCheckResult[] = [];
  const remediationSteps: string[] = [];
  const artifactsDir = path.join(__dirname, '../artifacts');
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }

  // Check 3.1: Android SDK & Tools Path
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '/home/momodding/android-sdk';
  const extendedPath = `${path.join(sdkRoot, 'platform-tools')}:${path.join(sdkRoot, 'emulator')}:${path.join(sdkRoot, 'cmdline-tools/latest/bin')}:${process.env.PATH}`;
  const execEnv = { ...process.env, ANDROID_HOME: sdkRoot, PATH: extendedPath };

  if (fs.existsSync(sdkRoot)) {
    checks.push({
      checkId: 'RAR-E2E-301',
      name: 'Android SDK Directory Presence',
      status: 'PASS',
      details: `SDK found at ${sdkRoot}`,
    });
  } else {
    checks.push({
      checkId: 'RAR-E2E-301',
      name: 'Android SDK Directory Presence',
      status: 'BLOCKED_ENVIRONMENT',
      details: `Android SDK directory not found at ${sdkRoot}`,
      remediation: 'Export ANDROID_HOME pointing to valid Android SDK installation.',
    });
    remediationSteps.push('Set ANDROID_HOME=/home/momodding/android-sdk');
  }

  // Check 3.2: ADB Binary Check
  try {
    const adbOut = execSync('adb version', { env: execEnv, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    checks.push({
      checkId: 'RAR-E2E-302',
      name: 'Android Debug Bridge (adb) Binary',
      status: 'PASS',
      details: adbOut.split('\n')[0] ?? 'adb installed',
    });
  } catch (err: unknown) {
    checks.push({
      checkId: 'RAR-E2E-302',
      name: 'Android Debug Bridge (adb) Binary',
      status: 'BLOCKED_ENVIRONMENT',
      details: 'adb not found or executable',
      remediation: 'Install Android platform-tools or add platform-tools to PATH.',
    });
    remediationSteps.push('Add $ANDROID_HOME/platform-tools to PATH');
  }

  // Check 3.3: Emulator Binary & AVD List
  try {
    const avdOut = execSync('emulator -list-avds', { env: execEnv, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const avds = avdOut.trim().split('\n').filter(Boolean);
    if (avds.length > 0) {
      checks.push({
        checkId: 'RAR-E2E-303',
        name: 'Android Virtual Devices (AVD)',
        status: 'PASS',
        details: `Discovered ${avds.length} AVDs: ${avds.join(', ')}`,
      });
    } else {
      checks.push({
        checkId: 'RAR-E2E-303',
        name: 'Android Virtual Devices (AVD)',
        status: 'WARN',
        details: 'No AVDs found. Emulator cannot launch.',
        remediation: 'avdmanager create avd -n omp_verify -k "system-images;android-35;google_apis;x86_64"',
      });
      remediationSteps.push('Create AVD: avdmanager create avd -n omp_verify -k "system-images;android-35;google_apis;x86_64"');
    }
  } catch (err: unknown) {
    checks.push({
      checkId: 'RAR-E2E-303',
      name: 'Android Virtual Devices (AVD)',
      status: 'BLOCKED_ENVIRONMENT',
      details: 'emulator binary not accessible',
      remediation: 'Add $ANDROID_HOME/emulator to PATH.',
    });
  }

  // Check 3.4: Hardware Virtualization (/dev/kvm) Access
  if (fs.existsSync('/dev/kvm')) {
    try {
      fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
      checks.push({
        checkId: 'RAR-E2E-304',
        name: 'KVM Virtualization Acceleration (/dev/kvm)',
        status: 'PASS',
        details: 'Read/write access to /dev/kvm confirmed.',
      });
    } catch {
      checks.push({
        checkId: 'RAR-E2E-304',
        name: 'KVM Virtualization Acceleration (/dev/kvm)',
        status: 'BLOCKED_ENVIRONMENT',
        details: 'Permission denied on /dev/kvm (user momodding not in kvm group). Android emulator fails with accel 11.',
        remediation: 'sudo usermod -aG kvm $USER (or sudo chmod 666 /dev/kvm for testing)',
      });
      remediationSteps.push('Add current user to kvm group: sudo usermod -aG kvm $USER && newgrp kvm');
    }
  } else {
    checks.push({
      checkId: 'RAR-E2E-304',
      name: 'KVM Virtualization Acceleration (/dev/kvm)',
      status: 'BLOCKED_ENVIRONMENT',
      details: '/dev/kvm character device does not exist.',
      remediation: 'Enable AMD-V/VT-x in BIOS and load kvm_amd/kvm_intel module.',
    });
    remediationSteps.push('Enable CPU virtualization in BIOS and modprobe kvm_amd');
  }

  // Check 3.5: Maestro UI Automation Binary
  try {
    const maestroOut = execSync('maestro --version', { env: execEnv, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    checks.push({
      checkId: 'RAR-E2E-305',
      name: 'Maestro Mobile UI Test Framework',
      status: 'PASS',
      details: maestroOut.trim(),
    });
  } catch {
    checks.push({
      checkId: 'RAR-E2E-305',
      name: 'Maestro Mobile UI Test Framework',
      status: 'BLOCKED_ENVIRONMENT',
      details: 'Maestro CLI not installed in PATH.',
      remediation: 'curl -fsSL "https://get.maestro.mobile.dev" | bash',
    });
    remediationSteps.push('Install Maestro: curl -fsSL "https://get.maestro.mobile.dev" | bash');
  }

  // Check 3.6: React Native / Android App Config & Network Security
  const appJsonPath = path.join(__dirname, '../../client/app.json');
  if (fs.existsSync(appJsonPath)) {
    try {
      const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
      const scheme = appJson.expo?.scheme;
      checks.push({
        checkId: 'RAR-E2E-306',
        name: 'Client App Android Configuration & Deep Links',
        status: 'PASS',
        details: `Package: ${appJson.expo?.android?.package ?? 'com.paperplain.agenticremote'} | Scheme: ${scheme ?? 'agenticremote'}`,
      });
    } catch {
      checks.push({
        checkId: 'RAR-E2E-306',
        name: 'Client App Android Configuration & Deep Links',
        status: 'WARN',
        details: 'Failed to parse client/app.json',
      });
    }
  }

  const blockedCount = checks.filter((c) => c.status === 'BLOCKED_ENVIRONMENT').length;
  const passCount = checks.filter((c) => c.status === 'PASS').length;
  const warnCount = checks.filter((c) => c.status === 'WARN').length;

  const report: Phase3SuiteReport = {
    timestamp: new Date().toISOString(),
    suite: 'Phase 3 - Android E2E & Environment Diagnostics',
    status: blockedCount > 0 ? 'BLOCKED_ENVIRONMENT' : 'READY',
    passed: passCount,
    blocked: blockedCount,
    warnings: warnCount,
    total: checks.length,
    checks,
    remediationSteps,
  };

  fs.writeFileSync(path.join(artifactsDir, 'phase3-results.json'), JSON.stringify(report, null, 2));

  let log = `=================================================================\n`;
  log += `        PHASE 3: ANDROID E2E & ENVIRONMENT REPORT                \n`;
  log += `=================================================================\n`;
  log += `Timestamp: ${report.timestamp}\n`;
  log += `Overall Status: ${report.status}\n`;
  log += `Summary: ${report.passed} PASS, ${report.blocked} BLOCKED, ${report.warnings} WARN (Total: ${report.total})\n\n`;

  for (const c of checks) {
    log += `[${c.status}] ${c.checkId} - ${c.name}\n`;
    log += `       Details: ${c.details}\n`;
    if (c.remediation) {
      log += `       Remediation: ${c.remediation}\n`;
    }
  }

  if (remediationSteps.length > 0) {
    log += `\nActionable Remediation Commands to Unblock Android E2E:\n`;
    for (let i = 0; i < remediationSteps.length; i++) {
      log += `  ${i + 1}. ${remediationSteps[i]}\n`;
    }
  }

  fs.writeFileSync(path.join(artifactsDir, 'phase3-android.log'), log);

  return report;
}

if (import.meta.main) {
  const rep = runAndroidDoctor();
  console.log(`Phase 3 Status: ${rep.status} (${rep.passed} passed, ${rep.blocked} blocked)`);
}
