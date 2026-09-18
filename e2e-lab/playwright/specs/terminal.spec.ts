import { test, expect } from '@playwright/test';

test.describe('Web Terminal & Daemon Topbar', () => {
  test('should render topbar daemon actions and brand wordmark', async ({ page }) => {
    await page.goto('/', { waitUntil: 'commit' });

    // Seed connection into localStorage
    await page.evaluate(() => {
      const store = {
        connections: [
          {
            name: 'Terminal Host',
            endpoint: 'https://127.0.0.1:18765',
            hostId: 'daemon-term-host',
            fingerprint: 'sha256:term1234',
            skipFingerprintVerification: true,
            token: 'tok-term-1234',
            clientName: 'web-term-tester',
          },
        ],
      };
      localStorage.setItem('agenticremote.connection', JSON.stringify(store));
    });

    await page.reload({ waitUntil: 'commit' });

    // Verify wordmark and active host
    const wordmark = page.locator('text=agenticRemote').first();
    await expect(wordmark).toBeVisible({ timeout: 15000 });

    const hostName = page.locator('text=Terminal Host').first();
    await expect(hostName).toBeVisible({ timeout: 5000 });
  });
});
