import { inspectAndroidEnvironment } from '../android/env';

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
  const inspection = inspectAndroidEnvironment();
  const isBlocked = !inspection.kvmAccessible || !inspection.maestroInstalled || !inspection.avdAvailable || !inspection.sdkPresent || !inspection.clientApkFound;

  return {
    kvmAccessible: inspection.kvmAccessible,
    sdkPresent: inspection.sdkPresent,
    avdAvailable: inspection.avdAvailable,
    maestroInstalled: inspection.maestroInstalled,
    clientApkFound: inspection.clientApkFound,
    status: isBlocked ? 'BLOCKED_ENVIRONMENT' : 'READY',
    remediations: inspection.remediationSteps,
  };
}

if (import.meta.main) {
  const s = checkAndroidSetup();
  console.log(`Android Setup Status: ${s.status}`);
  console.log(`  KVM accessible: ${s.kvmAccessible}`);
  console.log(`  SDK present: ${s.sdkPresent}`);
  console.log(`  AVD available: ${s.avdAvailable}`);
  console.log(`  Maestro installed: ${s.maestroInstalled}`);
  console.log(`  Client APK found: ${s.clientApkFound}`);
  if (s.remediations.length > 0) {
    console.log('Remediation steps:');
    s.remediations.forEach((r, idx) => console.log(`  [${idx + 1}] ${r}`));
  }
}
