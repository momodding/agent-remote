import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface AndroidEnvironment {
  sdkRoot: string;
  env: Record<string, string>;
  sdkPresent: boolean;
  kvmAccessible: boolean;
  avdAvailable: boolean;
  maestroInstalled: boolean;
  clientApkFound: boolean;
  clientApkPath: string | null;
  runningDevice: boolean;
  blockers: string[];
  remediationSteps: string[];
}

export function resolveAndroidSdkRoot(): string {
  if (process.env.ANDROID_HOME && fs.existsSync(process.env.ANDROID_HOME)) {
    return process.env.ANDROID_HOME;
  }
  if (process.env.ANDROID_SDK_ROOT && fs.existsSync(process.env.ANDROID_SDK_ROOT)) {
    return process.env.ANDROID_SDK_ROOT;
  }

  const home = process.env.HOME || '/root';
  const candidates = [
    path.join(home, 'android-sdk'),
    path.join(home, 'Android/Sdk'),
    '/opt/android-sdk',
    '/usr/lib/android-sdk',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(home, 'android-sdk');
}

export function getAndroidEnvironment(extraEnv?: Record<string, string>): Record<string, string> {
  const sdkRoot = resolveAndroidSdkRoot();
  const home = process.env.HOME || '/root';
  const sdkBinPaths = [
    path.join(sdkRoot, 'platform-tools'),
    path.join(sdkRoot, 'emulator'),
    path.join(sdkRoot, 'cmdline-tools/latest/bin'),
    path.join(sdkRoot, 'cmdline-tools/bin'),
    path.join(home, '.maestro/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, 'go/bin'),
    path.join(home, '.local/bin'),
  ];

  const currentPath = extraEnv?.PATH || process.env.PATH || '';
  const extendedPath = `${sdkBinPaths.join(':')}:${currentPath}`;

  return {
    ...process.env,
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
    PATH: extendedPath,
    ...(extraEnv || {}),
  };
}

export function inspectAndroidEnvironment(): AndroidEnvironment {
  const sdkRoot = resolveAndroidSdkRoot();
  const env = getAndroidEnvironment();
  const sdkPresent = fs.existsSync(sdkRoot);

  const blockers: string[] = [];
  const remediationSteps: string[] = [];

  // 1. Check KVM
  let kvmAccessible = false;
  if (fs.existsSync('/dev/kvm')) {
    try {
      fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
      kvmAccessible = true;
    } catch {
      blockers.push('Hardware Virtualization (/dev/kvm): User lacks read/write access. Android emulator fails with accel 11.');
      remediationSteps.push('Grant KVM access: sudo usermod -aG kvm $USER && newgrp kvm');
    }
  } else {
    blockers.push('Hardware Virtualization (/dev/kvm): /dev/kvm not found.');
    remediationSteps.push('Enable AMD-V/VT-x CPU virtualization in BIOS and verify /dev/kvm.');
  }

  // 2. Check SDK
  if (!sdkPresent) {
    blockers.push('Android SDK: ANDROID_HOME directory missing or unpopulated.');
    remediationSteps.push('Run ./e2e-lab/scripts/setup-android-sdk.sh to install Android commandline tools and platform packages.');
  }

  // 3. Check AVD
  let avdAvailable = false;
  if (sdkPresent) {
    try {
      const out = execSync('emulator -list-avds', {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15000,
      });
      avdAvailable = out.trim().split('\n').filter(Boolean).length > 0;
      if (!avdAvailable) {
        blockers.push('Android Virtual Device (AVD): No AVD configured for testing.');
        remediationSteps.push('Create AVD: avdmanager create avd -n omp_verify -k "system-images;android-35;google_apis;x86_64"');
      }
    } catch {
      // Emulator query failed
      blockers.push('Android Emulator: Unable to query emulator -list-avds.');
      remediationSteps.push('Verify emulator binary is executable in ANDROID_HOME/emulator.');
    }
  }

  // 4. Check Maestro
  let maestroInstalled = false;
  try {
    execSync('maestro --version', {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30000,
    });
    maestroInstalled = true;
  } catch {
    blockers.push('Maestro CLI: Maestro mobile UI automation binary missing from PATH.');
    remediationSteps.push('Install Maestro: curl -fsSL "https://get.maestro.mobile.dev" | bash');
  }

  // 5. Check Client APK
  const clientDir = path.join(__dirname, '../../client');
  const possibleApkPaths = [
    path.join(clientDir, 'android/app/build/outputs/apk/debug/app-debug.apk'),
    path.join(clientDir, 'app-debug.apk'),
  ];
  let clientApkFound = false;
  let clientApkPath: string | null = null;
  for (const p of possibleApkPaths) {
    if (fs.existsSync(p)) {
      clientApkFound = true;
      clientApkPath = p;
      break;
    }
  }
  if (!clientApkFound) {
    blockers.push('Client Debug APK: Android debug APK artifact not found.');
    remediationSteps.push('Build client APK: cd client && bun run prebuild && cd android && ./gradlew assembleDebug');
  }

  // 6. Check running device / emulator
  let runningDevice = false;
  try {
    const adbOut = execSync('adb devices', {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const lines = adbOut.trim().split('\n').slice(1);
    runningDevice = lines.some((l) => l.includes('\tdevice'));
    if (!runningDevice) {
      blockers.push('Android Device: No active booted emulator or connected device found via adb.');
      remediationSteps.push('Start Android emulator: emulator -avd omp_verify -no-audio -no-window');
    }
  } catch {
    blockers.push('Android Debug Bridge (adb): adb failed to query connected devices.');
    remediationSteps.push('Ensure adb server is running: adb start-server');
  }

  return {
    sdkRoot,
    env,
    sdkPresent,
    kvmAccessible,
    avdAvailable,
    maestroInstalled,
    clientApkFound,
    clientApkPath,
    runningDevice,
    blockers,
    remediationSteps,
  };
}
