import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Minimal runnable check verifying test-all.ts exits non-zero on BLOCKED_ENVIRONMENT while preserving reports
function verifyExitCodeAndReport(): void {
  const labDir = path.resolve(__dirname);
  const artifactsDir = path.join(labDir, 'artifacts');
  const reportMd = path.join(artifactsDir, 'final-report.md');
  const reportJson = path.join(artifactsDir, 'final-report.json');

  console.log('Testing test-all.ts exit code and artifact generation...');
  const res = spawnSync('bun', ['run', 'test-all.ts'], {
    cwd: labDir,
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 300000,
  });

  console.log(`Child process exited with status: ${res.status}`);
  if (res.status === 0) {
    throw new Error(`Expected non-zero exit code when Android is BLOCKED_ENVIRONMENT, got ${res.status}`);
  }

  if (!fs.existsSync(reportMd) || !fs.existsSync(reportJson)) {
    throw new Error('Final report artifacts missing after test-all.ts execution');
  }

  const jsonContent = JSON.parse(fs.readFileSync(reportJson, 'utf8'));
  console.log(`Overall status in report: ${jsonContent.overallStatus}`);
  console.log(`Android status in report: ${jsonContent.android.status}`);

  if (jsonContent.android.status !== 'BLOCKED_ENVIRONMENT' && jsonContent.android.status !== 'PASS') {
    throw new Error(`Unexpected android status: ${jsonContent.android.status}`);
  }

  console.log('PASS: test-all.ts properly exits non-zero on blocked environment while preserving artifacts.');
}

if (import.meta.main) {
  try {
    verifyExitCodeAndReport();
    process.exit(0);
  } catch (err) {
    console.error('Check failed:', err);
    process.exit(1);
  }
}
