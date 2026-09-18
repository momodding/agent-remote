import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { inspectAndroidEnvironment, getAndroidEnvironment } from './env';

export interface AndroidRunnerReport {
  timestamp: string;
  suite: 'Android Mobile E2E & Device Automation';
  status: 'PASS' | 'BLOCKED_ENVIRONMENT' | 'FAIL';
  details: string;
  blockers: string[];
  remediationSteps: string[];
}

export function runAndroidVerification(): AndroidRunnerReport {
  const artifactsDir = path.join(__dirname, '../artifacts');
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }

  const inspection = inspectAndroidEnvironment();

  // If any prerequisite is missing, fail-closed as BLOCKED_ENVIRONMENT
  if (inspection.blockers.length > 0) {
    const report: AndroidRunnerReport = {
      timestamp: new Date().toISOString(),
      suite: 'Android Mobile E2E & Device Automation',
      status: 'BLOCKED_ENVIRONMENT',
      details: `Android E2E automation blocked by ${inspection.blockers.length} missing environment prerequisite(s).`,
      blockers: inspection.blockers,
      remediationSteps: inspection.remediationSteps,
    };

    fs.writeFileSync(
      path.join(artifactsDir, 'android-verification.json'),
      JSON.stringify(report, null, 2),
      'utf-8'
    );
    return report;
  }

  // All prerequisites exist and a device is booted: invoke Maestro flows!
  console.log('[Android Runner] All Android prerequisites verified. Invoking Maestro E2E test flows...');
  const env = getAndroidEnvironment();
  const labDir = path.join(__dirname, '..');
  const flowsDir = path.join(labDir, 'maestro/flows');

  let executionLog = '';
  try {
    const output = execSync(`maestro test "${flowsDir}"`, {
      cwd: labDir,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000,
    });
    executionLog = output;
    const report: AndroidRunnerReport = {
      timestamp: new Date().toISOString(),
      suite: 'Android Mobile E2E & Device Automation',
      status: 'PASS',
      details: 'Maestro mobile UI E2E test suite passed on live Android emulator/device.',
      blockers: [],
      remediationSteps: [],
    };
    fs.writeFileSync(
      path.join(artifactsDir, 'android-verification.json'),
      JSON.stringify(report, null, 2),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(artifactsDir, 'android-runner.log'),
      executionLog,
      'utf-8'
    );
    return report;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    executionLog = `${msg}\n${(error as { stdout?: string; stderr?: string })?.stdout || ''}\n${(error as { stderr?: string })?.stderr || ''}`;
    const report: AndroidRunnerReport = {
      timestamp: new Date().toISOString(),
      suite: 'Android Mobile E2E & Device Automation',
      status: 'FAIL',
      details: `Maestro execution failed on live device: ${msg}`,
      blockers: ['Maestro flow execution failed on target Android runtime.'],
      remediationSteps: ['Inspect artifacts/android-runner.log and Maestro screenshots for failure diagnosis.'],
    };
    fs.writeFileSync(
      path.join(artifactsDir, 'android-verification.json'),
      JSON.stringify(report, null, 2),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(artifactsDir, 'android-runner.log'),
      executionLog,
      'utf-8'
    );
    return report;
  }
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
