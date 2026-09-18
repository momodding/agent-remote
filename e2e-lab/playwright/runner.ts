import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { WebTestAppServer } from './web-server';
import { MockOpenAIServer } from '../fixtures/mock-omp';

export interface PlaywrightSuiteReport {
  timestamp: string;
  suite: 'Phase 2 - Web Client Playwright E2E';
  passed: number;
  failed: number;
  total: number;
  results: Array<{
    testId: string;
    name: string;
    status: 'PASS' | 'FAIL';
    durationMs: number;
    error?: string;
  }>;
}

export async function runPlaywrightSuite(): Promise<PlaywrightSuiteReport> {
  const artifactsDir = path.join(__dirname, '../artifacts/playwright');
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }

  const webServer = new WebTestAppServer(19100);
  const mockOMP = new MockOpenAIServer(19090);

  let webPort = 0;
  let ompPort = 0;

  try {
    webPort = await webServer.start();
    ompPort = await mockOMP.start();
    console.log(`[Phase 2] Web Server on :${webPort}, Mock OMP on :${ompPort}`);

    // Run Playwright test CLI
    const pwPromise = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const proc = spawn('npx', ['playwright', 'test', '--config=playwright/playwright.config.ts'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          APP_PORT: String(webPort),
          OMP_PORT: String(ompPort),
        },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (d) => {
        stdout += d.toString();
        process.stdout.write(d.toString());
      });

      proc.stderr?.on('data', (d) => {
        stderr += d.toString();
        process.stderr.write(d.toString());
      });

      proc.on('close', (code) => {
        resolve({ code: code ?? 0, stdout, stderr });
      });
    });

    const pwResult = await pwPromise;

    // Parse JSON report
    const jsonReportPath = path.join(artifactsDir, 'report.json');
    const parsedResults: Array<{
      testId: string;
      name: string;
      status: 'PASS' | 'FAIL';
      durationMs: number;
      error?: string;
    }> = [];

    if (fs.existsSync(jsonReportPath)) {
      try {
        const rawJson = JSON.parse(fs.readFileSync(jsonReportPath, 'utf8'));
        const suites = rawJson.suites ?? [];

        const collectSpecs = (node: { specs?: Array<{ title: string; tests: Array<{ results: Array<{ status: string; duration: number; error?: { message?: string } }> }> }>; suites?: unknown[] }) => {
          if (node.specs) {
            for (const spec of node.specs) {
              const testCase = spec.tests?.[0];
              const testRes = testCase?.results?.[0];
              const idMatch = spec.title.match(/RAR-E2E-\d+/);
              const testId = idMatch ? idMatch[0] : 'RAR-E2E-2XX';
              const isPass = testRes?.status === 'passed';

              parsedResults.push({
                testId,
                name: spec.title,
                status: isPass ? 'PASS' : 'FAIL',
                durationMs: testRes?.duration ?? 0,
                error: testRes?.error?.message,
              });
            }
          }
          if (Array.isArray(node.suites)) {
            for (const s of node.suites) {
              collectSpecs(s as typeof node);
            }
          }
        };

        for (const s of suites) {
          collectSpecs(s);
        }
      } catch (err: unknown) {
        console.error('Failed to parse Playwright JSON report:', err);
      }
    }

    // Fallback if parsedResults is empty
    if (parsedResults.length === 0) {
      const isOk = pwResult.code === 0;
      parsedResults.push({
        testId: 'RAR-E2E-200',
        name: 'Playwright Suite Execution',
        status: isOk ? 'PASS' : 'FAIL',
        durationMs: 0,
        error: isOk ? undefined : pwResult.stderr,
      });
    }

    const report: PlaywrightSuiteReport = {
      timestamp: new Date().toISOString(),
      suite: 'Phase 2 - Web Client Playwright E2E',
      passed: parsedResults.filter((r) => r.status === 'PASS').length,
      failed: parsedResults.filter((r) => r.status === 'FAIL').length,
      total: parsedResults.length,
      results: parsedResults,
    };

    fs.writeFileSync(path.join(artifactsDir, '../phase2-results.json'), JSON.stringify(report, null, 2));

    let log = `=================================================================\n`;
    log += `        PHASE 2: PLAYWRIGHT WEB CLIENT REPORT                   \n`;
    log += `=================================================================\n`;
    log += `Timestamp: ${report.timestamp}\n`;
    log += `Result: ${report.passed}/${report.total} PASSED (${report.failed} FAILED)\n\n`;
    for (const r of parsedResults) {
      log += `[${r.status}] ${r.testId} - ${r.name} (${r.durationMs}ms)\n`;
      if (r.error) {
        log += `       Error: ${r.error}\n`;
      }
    }
    fs.writeFileSync(path.join(artifactsDir, '../phase2-playwright.log'), log);

    return report;
  } finally {
    await webServer.stop();
    await mockOMP.stop();
  }
}

if (import.meta.main) {
  runPlaywrightSuite().then((report) => {
    console.log(`Phase 2 complete: ${report.passed}/${report.total} passed.`);
    if (report.failed > 0) {
      process.exit(1);
    }
  });
}
