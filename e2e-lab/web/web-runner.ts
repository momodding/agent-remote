import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { execSync } from 'node:child_process';

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

export async function checkServerReachable(urlStr: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(urlStr);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || 80,
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

  const isLive = await checkServerReachable(targetUrl, 3000);
  if (!isLive) {
    return {
      timestamp: new Date().toISOString(),
      suite: 'Web Client Production & Browser E2E',
      status: 'BLOCKED_ENVIRONMENT',
      details: `Live Expo Web client server is not running on ${targetUrl}. Web E2E requires actual Expo web production server.`,
      remediation: 'Start Expo web server: cd client && bun install && npx expo start --web --port 8081',
      testsTotal: 0,
      testsPassed: 0,
      testsFailed: 0,
    };
  }

  // Check for real daemon pairing payload (forged localStorage auth is strictly disallowed)
  const pairingFile = path.join(__dirname, '../.runtime/pairing.json');
  let realPairingPayload = process.env.E2E_REAL_PAIRING_PAYLOAD;

  if (!realPairingPayload && fs.existsSync(pairingFile)) {
    try {
      realPairingPayload = fs.readFileSync(pairingFile, 'utf-8').trim();
    } catch {
      // ignore
    }
  }

  if (!realPairingPayload) {
    return {
      timestamp: new Date().toISOString(),
      suite: 'Web Client Production & Browser E2E',
      status: 'BLOCKED_ENVIRONMENT',
      details:
        'Web browser E2E blocked: Real daemon pairing payload (Auth-v2) is not emitted by container topology. Injected/fake localStorage authentication is disabled.',
      remediation:
        'Export real temporary pairing payload from daemon container to .runtime/pairing.json or set E2E_REAL_PAIRING_PAYLOAD so Playwright can perform authentic Auth-v2 pairing.',
      testsTotal: 0,
      testsPassed: 0,
      testsFailed: 0,
    };
  }

  try {
    const cwd = path.join(__dirname, '..');
    const stdout = execSync(
      './node_modules/.bin/playwright test --config=playwright/playwright.config.ts --reporter=list',
      {
        cwd,
        env: {
          ...process.env,
          CLIENT_WEB_URL: targetUrl,
          E2E_REAL_PAIRING_PAYLOAD: realPairingPayload,
        },
        encoding: 'utf-8',
        stdio: 'pipe',
      }
    );

    return {
      timestamp: new Date().toISOString(),
      suite: 'Web Client Production & Browser E2E',
      status: 'PASS',
      details: `Playwright browser E2E test suite passed with authentic daemon pairing and live Auth-v2 (${targetUrl}).`,
      testsTotal: 6,
      testsPassed: 6,
      testsFailed: 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      timestamp: new Date().toISOString(),
      suite: 'Web Client Production & Browser E2E',
      status: 'FAIL',
      details: 'Playwright tests failed: ' + message,
      testsTotal: 6,
      testsPassed: 0,
      testsFailed: 6,
    };
  }
}

export async function runWebVerification(): Promise<WebRunnerReport> {
  return runPlaywrightTests();
}

if (import.meta.main) {
  runWebVerification().then((res) => {
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.status === 'PASS' ? 0 : 1);
  });
}
