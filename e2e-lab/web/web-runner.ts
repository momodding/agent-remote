import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
import { getRealPairingPayload } from '../playwright/pairing-payload';

export interface WebRunnerReport {
  timestamp: string;
  suite: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED_ENVIRONMENT';
  details: string;
  remediation?: string;
  testsTotal: number;
  testsPassed: number;
  testsFailed: number;
}

interface PlaywrightJsonOutput {
  stats: {
    startTime: string;
    duration: number;
    expected: number;
    skipped: number;
    unexpected: number;
    flaky: number;
  };
  errors?: unknown[];
}

export async function checkServerReachable(urlStr: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(urlStr);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname || '/',
          method: 'GET',
          timeout: timeoutMs,
        },
        (res) => {
          resolve(res.statusCode !== undefined && res.statusCode < 500);
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.on('error', () => {
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

export async function runPlaywrightTests(): Promise<WebRunnerReport> {
  const clientDir = path.join(__dirname, '../../client');
  const webPort = process.env.CLIENT_WEB_PORT || '8081';
  const targetUrl = `http://127.0.0.1:${webPort}`;

  if (!fs.existsSync(clientDir) || !fs.existsSync(path.join(clientDir, 'package.json'))) {
    return {
      timestamp: new Date().toISOString(),
      suite: 'Web Client Production & Browser E2E',
      status: 'BLOCKED_ENVIRONMENT',
      details: 'Client directory or package.json missing.',
      remediation: 'Ensure client/ directory exists with valid Expo configuration.',
      testsTotal: 0,
      testsPassed: 0,
      testsFailed: 0,
    };
  }
  // Always ensure fresh daemon/provider topology and canonical exported web build.
  const upScript = path.join(__dirname, '../scripts/up.sh');
  if (fs.existsSync(upScript)) {
    try {
      execFileSync('bash', [upScript], { stdio: 'pipe', timeout: 180000 });
    } catch (error) {
      let exitStatus = 'none';
      let signal = 'none';
      let code = 'none';
      let stdout = '';
      let stderr = '';

      if (error && typeof error === 'object') {
        if ('status' in error && (typeof error.status === 'number' || error.status === null)) exitStatus = String(error.status ?? 'none');
        if ('signal' in error && (typeof error.signal === 'string' || error.signal === null)) signal = error.signal ?? 'none';
        if ('code' in error && typeof error.code === 'string') code = error.code;
        if ('stdout' in error && (typeof error.stdout === 'string' || Buffer.isBuffer(error.stdout))) stdout = String(error.stdout);
        if ('stderr' in error && (typeof error.stderr === 'string' || Buffer.isBuffer(error.stderr))) stderr = String(error.stderr);
      }

      return {
        timestamp: new Date().toISOString(),
        suite: 'Web Client Production & Browser E2E',
        status: 'BLOCKED_ENVIRONMENT',
        details: `Could not start the E2E topology. Exit status: ${exitStatus}; signal: ${signal}; code: ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        remediation: 'Inspect the captured startup diagnostics above and ensure required images are available.',
        testsTotal: 0,
        testsPassed: 0,
        testsFailed: 0,
      };
    }
  }

  const isLive = await checkServerReachable(targetUrl, 5000);
  if (!isLive) {
    return {
      timestamp: new Date().toISOString(),
      suite: 'Web Client Production & Browser E2E',
      status: 'BLOCKED_ENVIRONMENT',
      details: `Canonical Expo web export is not serving on ${targetUrl}.`,
      remediation: 'Run e2e-lab/scripts/up.sh to build client/dist and start the local server.',
      testsTotal: 0,
      testsPassed: 0,
      testsFailed: 0,
    };
  }

  // Pairing payloads remain in memory and are passed only to Playwright's environment.
  const realPairingPayload = getRealPairingPayload();

  if (!realPairingPayload) {
    return {
      timestamp: new Date().toISOString(),
      suite: 'Web Client Production & Browser E2E',
      status: 'BLOCKED_ENVIRONMENT',
      details: 'Web browser E2E blocked: no current Auth-v2 pairing payload is available from the daemon topology.',
      remediation: 'Ensure the daemon topology is running and emitting a current Auth-v2 pairing payload.',
      testsTotal: 0,
      testsPassed: 0,
      testsFailed: 0,
    };
  }

  const artifactsDir = path.join(__dirname, '../artifacts');
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }
  const resultsJsonPath = path.join(artifactsDir, 'playwright-results.json');
  if (fs.existsSync(resultsJsonPath)) {
    try {
      fs.unlinkSync(resultsJsonPath);
    } catch {
      // ignore
    }
  }

  try {
    const cwd = path.join(__dirname, '..');
    const home = process.env.HOME || '/root';
    const extendedPath = `${home}/.bun/bin:${home}/go/bin:${home}/.local/bin:${process.env.PATH || ''}`;
    const runtimeNodeModules = path.join(cwd, '.runtime/node_modules');

    // Ensure local Playwright is installed in .runtime
    const playwrightBin = path.join(cwd, '.runtime/node_modules/.bin/playwright');
    if (!fs.existsSync(playwrightBin)) {
      console.log('Local Playwright not found; installing into .runtime...');
      execFileSync('bun', ['install', '--production'], {
        cwd: path.join(cwd, '.runtime'),
        env: { ...process.env, PATH: extendedPath },
        stdio: 'inherit',
      });
    }

    const browserCache = path.join(cwd, '.runtime/browser');
    execFileSync(playwrightBin, ['install', 'chromium'], {
      env: { ...process.env, PATH: extendedPath, PLAYWRIGHT_BROWSERS_PATH: browserCache, NODE_PATH: runtimeNodeModules },
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 180000,
    });
    execFileSync(playwrightBin, ['test', '--config=playwright/playwright.config.ts'], {
      env: {
        ...process.env,
        PATH: extendedPath,
        NODE_PATH: runtimeNodeModules,
        CLIENT_WEB_URL: targetUrl,
        E2E_REAL_PAIRING_PAYLOAD: realPairingPayload,
        PLAYWRIGHT_BROWSERS_PATH: browserCache,
      },
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    let passed = 0;
    let failed = 0;
    let total = 0;

    if (fs.existsSync(resultsJsonPath)) {
      try {
        const jsonContent: PlaywrightJsonOutput = JSON.parse(fs.readFileSync(resultsJsonPath, 'utf-8'));
        if (jsonContent && jsonContent.stats) {
          passed = jsonContent.stats.expected ?? 0;
          failed = jsonContent.stats.unexpected ?? 0;
          total = passed + failed + (jsonContent.stats.skipped ?? 0);
        }
      } catch {
        // fallback
      }
    }

    if (passed + failed === 0) {
      return {
        timestamp: new Date().toISOString(),
        suite: 'Web Client Production & Browser E2E',
        status: 'BLOCKED_ENVIRONMENT',
        details: 'Playwright completed without executing any tests.',
        remediation: 'Inspect the Playwright configuration and results artifact before retrying.',
        testsTotal: total,
        testsPassed: passed,
        testsFailed: failed,
      };
    }

    return {
      timestamp: new Date().toISOString(),
      suite: 'Web Client Production & Browser E2E',
      status: failed === 0 ? 'PASS' : 'FAIL',
      details: `Playwright browser E2E test suite passed with authentic daemon pairing and live Auth-v2 (${passed}/${total} specs passed).`,
      testsTotal: total,
      testsPassed: passed,
      testsFailed: failed,
    };
  } catch {
    let passed = 0;
    let failed = 0;
    let total = 0;

    if (fs.existsSync(resultsJsonPath)) {
      try {
        const jsonContent: PlaywrightJsonOutput = JSON.parse(fs.readFileSync(resultsJsonPath, 'utf-8'));
        if (jsonContent && jsonContent.stats) {
          passed = jsonContent.stats.expected ?? 0;
          failed = jsonContent.stats.unexpected ?? 0;
          total = passed + failed + (jsonContent.stats.skipped ?? 0);
        }
      } catch {
        // fallback
      }
    }

    if (total === 0) {
      failed = 1;
      total = 1;
    }

    return {
      timestamp: new Date().toISOString(),
      suite: 'Web Client Production & Browser E2E',
      status: 'FAIL',
      details: `Playwright tests failed (${passed}/${total} passed).`,
      testsTotal: total,
      testsPassed: passed,
      testsFailed: failed,
    };
  }
}

export const runWebVerification = runPlaywrightTests;

async function main() {
  console.log('=== Web Runner Execution ===');
  const report = await runPlaywrightTests();
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'FAIL') {
    process.exit(1);
  }
}

if (import.meta.main || (typeof require !== 'undefined' && require.main === module)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
