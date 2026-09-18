import * as path from 'node:path';
import { spawn } from 'node:child_process';

export interface BackendSuiteResult {
  timestamp: string;
  suite: 'Backend Golden Flow & Strict Daemon Verification';
  status: 'PASS' | 'FAIL';
  exitCode: number;
  durationMs: number;
  details: string;
  sanitizedLog: string;
}

function sanitizeSecrets(input: string): string {
  // Redact bearer tokens, session tokens, pairing tokens, secret keys, passwords
  return input
    .replace(/(bearer\s+token\s+obtained:\s*)([^\s\n]+)/gi, '$1[REDACTED]')
    .replace(/("token"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3')
    .replace(/("pairingId"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3')
    .replace(/("sessionToken"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3')
    .replace(/(token=[^\s&]+)/gi, 'token=[REDACTED]')
    .replace(/(pairingId=[^\s&]+)/gi, 'pairingId=[REDACTED]');
}

export async function runBackendVerification(): Promise<BackendSuiteResult> {
  const rootDir = path.join(__dirname, '../..');
  const startTime = Date.now();

  console.log('[Backend Runner] Executing `make verify-phase1-4` with real OMP, tmux, and strict integration...');

  return new Promise((resolve) => {
    const proc = spawn('make', ['verify-phase1-4'], {
      cwd: rootDir,
      env: {
        ...process.env,
        AGENTICREMOTE_STRICT_INTEGRATION: '1',
      },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });

    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    proc.on('close', (code: number | null) => {
      const exitCode = code ?? 1;
      const durationMs = Date.now() - startTime;
      const fullLog = `${stdout}\n${stderr}`;
      const sanitizedLog = sanitizeSecrets(fullLog);

      const hasSkips = /--- SKIP/i.test(fullLog) || /=== SKIP/i.test(fullLog);
      const hasPass = /verify-phase1-4 PASSED/i.test(fullLog) && exitCode === 0;

      let status: 'PASS' | 'FAIL' = 'FAIL';
      let details = '';

      if (hasSkips) {
        status = 'FAIL';
        details = 'Strict verification rejected: Golden flow tests contained skipped steps.';
      } else if (hasPass) {
        status = 'PASS';
        details = 'make verify-phase1-4 succeeded with all hermetic golden flow tests passing strictly without skips.';
      } else {
        status = 'FAIL';
        details = `make verify-phase1-4 failed with exit code ${exitCode}.`;
      }

      resolve({
        timestamp: new Date().toISOString(),
        suite: 'Backend Golden Flow & Strict Daemon Verification',
        status,
        exitCode,
        durationMs,
        details,
        sanitizedLog,
      });
    });
  });
}

if (import.meta.main) {
  runBackendVerification().then((res) => {
    console.log(`Backend Verification Result: ${res.status} (${res.durationMs}ms)`);
    console.log(`Details: ${res.details}`);
    if (res.status !== 'PASS') {
      process.exit(1);
    }
  });
}
