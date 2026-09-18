import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface AndroidSetupStatus {
  kvmAccessible: boolean;
  sdkPresent: boolean;
  avdAvailable: boolean;
  maestroInstalled: boolean;
  clientApkFound: boolean;
  status: 'READY' | 'BLOCKED_ENVIRONMENT';
  remediations: string[];
}

export function checkAndroidSetup(): AndroidSetupStatus {
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '/home/momodding/android-sdk';
  const extendedPath = `${path.join(sdkRoot, 'platform-tools')}:${path.join(sdkRoot, 'emulator')}:${path.join(sdkRoot, 'cmdline-tools/latest/bin')}:${process.env.PATH}`;
  const env = { ...process.env, ANDROID_HOME: sdkRoot, PATH: extendedPath };

  const remediations: string[] = [];

  // Check KVM
  let kvmOk = false;
  if (fs.existsSync('/dev/kvm')) {
    try {
      fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
      kvmOk = true;
    } catch {
      remediations.push('Grant user KVM access: sudo usermod -aG kvm $USER && newgrp kvm');
    }
  } else {
    remediations.push('Enable CPU virtualization in BIOS and verify /dev/kvm');
  }

  // Check SDK
  const sdkPresent = fs.existsSync(sdkRoot);
  if (!sdkPresent) {
    remediations.push('Install Android SDK and set ANDROID_HOME');
  }

  // Check AVD
  let avdAvailable = false;
  try {
    const out = execSync('emulator -list-avds', { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    avdAvailable = out.trim().split('\n').filter(Boolean).length > 0;
    if (!avdAvailable) {
      remediations.push('Create AVD: avdmanager create avd -n omp_verify -k "system-images;android-35;google_apis;x86_64"');
    }
  } catch {
    remediations.push('Configure emulator in PATH to discover AVDs');
  }

  // Check Maestro
  let maestroInstalled = false;
  try {
    execSync('maestro --version', { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    maestroInstalled = true;
  } catch {
    remediations.push('Install Maestro UI runner: curl -fsSL "https://get.maestro.mobile.dev" | bash');
  }

  // Check APK
  const clientDir = path.join(__dirname, '../../client');
  const possibleApkPaths = [
    path.join(clientDir, 'android/app/build/outputs/apk/debug/app-debug.apk'),
    path.join(clientDir, 'app-debug.apk'),
  ];
  const clientApkFound = possibleApkPaths.some((p) => fs.existsSync(p));
  if (!clientApkFound) {
    remediations.push('Build debug APK: cd client && bun run prebuild && cd android && ./gradlew assembleDebug');
  }

  const isBlocked = !kvmOk || !maestroInstalled || !avdAvailable;

  return {
    kvmAccessible: kvmOk,
    sdkPresent,
    avdAvailable,
    maestroInstalled,
    clientApkFound,
    status: isBlocked ? 'BLOCKED_ENVIRONMENT' : 'READY',
    remediations,
  };
}

if (import.meta.main) {
  const status = checkAndroidSetup();
  console.log(`Android Setup Status: ${status.status}`);
  if (status.remediations.length > 0) {
    console.log('Remediations needed:');
    status.remediations.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
  }
}
