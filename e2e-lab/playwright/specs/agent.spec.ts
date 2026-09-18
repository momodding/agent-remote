import { test, expect } from '@playwright/test';

test.describe('Web Agent & Daemon View', () => {
  test('should render daemon card and session area when connection is active', async ({ page }) => {
    await page.goto('/', { waitUntil: 'commit' });

    // Seed connection into localStorage
    await page.evaluate(() => {
      const store = {
        connections: [
          {
            name: 'Production Daemon',
            endpoint: 'https://127.0.0.1:18765',
            hostId: 'daemon-e2e-prod',
            fingerprint: 'sha256:abcd1234abcd1234',
            skipFingerprintVerification: true,
            token: 'tok-e2e-agent-test',
            clientName: 'web-browser',
          },
        ],
      };
      localStorage.setItem('agenticremote.connection', JSON.stringify(store));
    });

    await page.reload({ waitUntil: 'commit' });

    // Verify daemon card renders
    const daemonTitle = page.locator('text=Production Daemon').first();
    await expect(daemonTitle).toBeVisible({ timeout: 15000 });

    const daemonEndpoint = page.locator('text=127.0.0.1:18765').first();
    await expect(daemonEndpoint).toBeVisible({ timeout: 5000 });

    const emptySessionNotice = page.locator('text=No open sessions for this daemon').first();
    await expect(emptySessionNotice).toBeVisible({ timeout: 5000 });
  });
});
