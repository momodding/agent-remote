import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

export interface BackendSuiteResult {
  timestamp: string;
  suite: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED_ENVIRONMENT';
  exitCode: number;
  durationMs: number;
  details: string;
  sanitizedLog: string;
}

function sanitizeSecrets(input: string): string {
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
  const artifactsDir = path.join(__dirname, '../artifacts');
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }

  const startTime = Date.now();
  console.log('[Backend Runner] Executing `make verify-phase1-4` with real OMP, tmux, and strict integration...');

  return new Promise((resolve) => {
    const home = process.env.HOME || '/root';
    const currentPath = process.env.PATH || '';
    const extendedPath = `${home}/.bun/bin:${home}/go/bin:${home}/.local/bin:${currentPath}`;

    const proc = spawn('make', ['verify-phase1-4'], {
      cwd: rootDir,
      env: {
        ...process.env,
        PATH: extendedPath,
        AGENTICREMOTE_STRICT_INTEGRATION: '1',
      },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      process.stdout.write(s);
    });

    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(s);
    });

    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;

      const exitCode = code ?? 1;
      const durationMs = Date.now() - startTime;
      const fullLog = `${stdout}\n${stderr}`;
      const sanitizedLog = sanitizeSecrets(fullLog);

      // 1. Mandatory test no-skip check
      const skipPattern = /---\s*SKIP:\s*(TestGoldenFlowHermetic\w*|TestHermeticOMP\w*)/i;
      const skipMatch = fullLog.match(skipPattern);
      const mandatoryTestSkipped = !!skipMatch;

      // 2. Missing prerequisite pattern check
      const missingPrereqPattern = /(?:binary required but not found in PATH|installed omp binary required|command not found|executable file not found in \$PATH|no such file or directory.*omp|no such file or directory.*tmux)/i;
      const isMissingPrereq = missingPrereqPattern.test(fullLog);

      // 3. Strict verification of pass criteria
      const hasGoldenPass = fullLog.includes('PASS: TestGoldenFlowHermeticPhase1to4') || fullLog.includes('PASS: TestHermeticOMP');
      const hasFail = fullLog.includes('--- FAIL:') || fullLog.includes('FAIL\t');
      const hasPass = exitCode === 0 && hasGoldenPass && !hasFail && !mandatoryTestSkipped;

      let status: 'PASS' | 'FAIL' | 'BLOCKED_ENVIRONMENT' = 'FAIL';
      let details = '';

      if (mandatoryTestSkipped) {
        status = 'FAIL';
        details = `Strict verification rejected: Mandatory test ${skipMatch ? skipMatch[1] : 'GoldenFlow/HermeticOMP'} was skipped.`;
      } else if (hasPass) {
        status = 'PASS';
        details = 'Golden flow backend hermetic phase 1-4 tests passed with strict verification.';
      } else if (isMissingPrereq) {
        status = 'BLOCKED_ENVIRONMENT';
        details = 'Backend verification blocked by missing environment prerequisite (Go, tmux, or OMP binary).';
      } else {
        status = 'FAIL';
        details = `make verify-phase1-4 failed with exit code ${exitCode}.`;
      }

      const res: BackendSuiteResult = {
        timestamp: new Date().toISOString(),
        suite: 'Backend Golden Flow & Strict Daemon Verification',
        status,
        exitCode,
        durationMs,
        details,
      sanitizedLog,
      };

      fs.writeFileSync(
        path.join(artifactsDir, 'backend-verification.json'),
        JSON.stringify(res, null, 2),
        'utf-8'
      );
      fs.writeFileSync(
        path.join(artifactsDir, 'backend-make-verify.log'),
        sanitizedLog,
        'utf-8'
      );

      resolve(res);
    };

    proc.on('exit', (code: number | null) => finish(code));
    proc.on('close', (code: number | null) => finish(code));
    proc.on('error', (err: Error) => {
      stderr += `\nProcess error: ${err.message}`;
      finish(1);
    });
  });
}

if (import.meta.main) {
  runBackendVerification().then((res) => {
    console.log(`Backend Runner Status: ${res.status} (exit ${res.exitCode})`);
    console.log(`Details: ${res.details}`);
    if (res.status === 'FAIL') {
      process.exit(1);
    }
  });
}
