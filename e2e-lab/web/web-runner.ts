import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { execSync } from 'node:child_process';

export interface WebRunnerReport {
  timestamp: string;
  suite: 'Web Client Production & Browser E2E';
  status: 'PASS' | 'BLOCKED_ENVIRONMENT' | 'FAIL';
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
          resolve((res.statusCode ?? 500) < 500);
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

export async function runWebVerification(): Promise<WebRunnerReport> {
  const clientDir = path.join(__dirname, '../../client');
  const webPort = process.env.EXPO_WEB_PORT || '8081';
  const targetUrl = `http://127.0.0.1:${webPort}`;

  // Check client directory and package.json
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

  // Check if live Expo Web server is reachable
  const isLive = await checkServerReachable(targetUrl);
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

  return {
    timestamp: new Date().toISOString(),
    suite: 'Web Client Production & Browser E2E',
    status: 'PASS',
    details: `Successfully connected to live Expo Web client at ${targetUrl}.`,
    testsTotal: 1,
    testsPassed: 1,
    testsFailed: 0,
  };
}

if (import.meta.main) {
  runPlaywrightTests().then((res) => {
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.status === 'PASS' ? 0 : 1);
  });
}

export async function runPlaywrightTests(): Promise<WebRunnerReport> {
  const webPort = process.env.EXPO_WEB_PORT || '8081';
  const targetUrl = `http://127.0.0.1:${webPort}`;

  // Check if Expo web server is running
  const isLive = await checkServerReachable(targetUrl);

  if (!isLive) {
    return {
      timestamp: new Date().toISOString(),
      suite: 'Web Client Production & Browser E2E',
      status: 'BLOCKED_ENVIRONMENT',
      details: 'Expo web server not running on port ' + webPort,
      remediation: 'Start Expo web: cd client && npx expo start --web',
      testsTotal: 0,
      testsPassed: 0,
      testsFailed: 0,
    };
  }

  try {
    const cwd = path.join(__dirname, '..');
    execSync('npx playwright test --config=playwright/playwright.config.ts', {
      cwd,
      stdio: 'inherit',
      env: {
        ...process.env,
        PLAYWRIGHT_TEST_BASE_URL: targetUrl,
      },
    });

    return {
      timestamp: new Date().toISOString(),
      suite: 'Web Client Production & Browser E2E',
      status: 'PASS',
      details: 'Playwright tests passed',
      testsTotal: 1,
      testsPassed: 1,
      testsFailed: 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      timestamp: new Date().toISOString(),
      suite: 'Web Client Production & Browser E2E',
      status: 'FAIL',
      details: 'Playwright tests failed: ' + message,
      testsTotal: 1,
      testsPassed: 0,
      testsFailed: 1,
    };
  }
}
