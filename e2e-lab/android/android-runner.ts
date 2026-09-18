import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { checkAndroidSetup } from '../android-setup/android-setup';

export interface AndroidRunnerReport {
  timestamp: string;
  suite: 'Android Mobile E2E & Device Automation';
  status: 'PASS' | 'BLOCKED_ENVIRONMENT' | 'FAIL';
  details: string;
  blockers: string[];
  remediationSteps: string[];
}

export function runAndroidVerification(): AndroidRunnerReport {
  const setup = checkAndroidSetup();
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '/home/momodding/android-sdk';
  const extendedPath = `${path.join(sdkRoot, 'platform-tools')}:${path.join(sdkRoot, 'emulator')}:${path.join(sdkRoot, 'cmdline-tools/latest/bin')}:${process.env.PATH}`;
  const env = { ...process.env, ANDROID_HOME: sdkRoot, PATH: extendedPath };

  const blockers: string[] = [];
  const remediationSteps: string[] = [];

  if (!setup.kvmAccessible) {
    blockers.push('KVM hardware acceleration is unavailable (/dev/kvm unprivileged or missing). Emulator fails with accel 11.');
    remediationSteps.push('Add user to kvm group: sudo usermod -aG kvm $USER && newgrp kvm');
  }

  if (!setup.maestroInstalled) {
    blockers.push('Maestro UI automation CLI binary not found in PATH.');
    remediationSteps.push('Install Maestro: curl -fsSL "https://get.maestro.mobile.dev" | bash');
  }

  if (!setup.clientApkFound) {
    blockers.push('Client debug APK not built.');
    remediationSteps.push('Build client APK: cd client && bun run prebuild && cd android && ./gradlew assembleDebug');
  }

  // Check if live Android device or emulator is booted
  let runningDevice = false;
  try {
    const adbOut = execSync('adb devices', { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = adbOut.trim().split('\n').slice(1);
    runningDevice = lines.some((l) => l.includes('\tdevice'));
    if (!runningDevice) {
      blockers.push('No booted Android emulator or physical device detected via adb.');
      remediationSteps.push('Launch Android emulator: emulator -avd omp_verify -no-audio -no-window');
    }
  } catch {
    blockers.push('Failed to query adb devices.');
    remediationSteps.push('Ensure adb is running and accessible.');
  }

  if (blockers.length > 0) {
    return {
      timestamp: new Date().toISOString(),
      suite: 'Android Mobile E2E & Device Automation',
      status: 'BLOCKED_ENVIRONMENT',
      details: `Android E2E automation blocked by ${blockers.length} missing environment prerequisites.`,
      blockers,
      remediationSteps,
    };
  }

  return {
    timestamp: new Date().toISOString(),
    suite: 'Android Mobile E2E & Device Automation',
    status: 'PASS',
    details: 'All Android prerequisites satisfied and device automation ready.',
    blockers: [],
    remediationSteps: [],
  };
}

if (import.meta.main) {
  const res = runAndroidVerification();
  console.log(`Android Runner Status: ${res.status}`);
  console.log(`Details: ${res.details}`);
  if (res.blockers.length > 0) {
    console.log('Blockers:');
    res.blockers.forEach((b, i) => console.log(`  [${i + 1}] ${b}`));
  }
}
