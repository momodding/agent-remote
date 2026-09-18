import { defineConfig, devices } from '@playwright/test';
import * as path from 'node:path';

export default defineConfig({
  testDir: path.join(__dirname, 'specs'),
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(__dirname, '../artifacts/playwright/report.json') }],
    ['html', { outputFolder: path.join(__dirname, '../artifacts/playwright/html-report'), open: 'never' }],
  ],
  use: {
    headless: true,
    ignoreHTTPSErrors: true,
    screenshot: 'on',
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
