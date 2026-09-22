import { inspectAndroidEnvironment } from '../android/env';

export interface AndroidSetupStatus {
  status: 'READY' | 'BLOCKED_ENVIRONMENT';
  blockers: string[];
  remediations: string[];
}

/** Containerized Android E2E needs KVM, Podman, the pinned image, and Maestro; not a host SDK or AVD. */
export async function checkAndroidSetup(): Promise<AndroidSetupStatus> {
  const inspection = await inspectAndroidEnvironment();
  return {
    status: inspection.status === 'READY' ? 'READY' : 'BLOCKED_ENVIRONMENT',
    blockers: inspection.blockers,
    remediations: inspection.remediationSteps,
  };
}

if (import.meta.main) {
  checkAndroidSetup().then(status => {
    console.log(`Android Setup Status: ${status.status}`);
    for (const blocker of status.blockers) console.log(`  Blocker: ${blocker}`);
    for (const remediation of status.remediations) console.log(`  Remediation: ${remediation}`);
    process.exit(status.status === 'READY' ? 0 : 1);
  });
}
