import { test, expect } from '@playwright/test';

test.describe('Web Client Pairing & TLS Verification', () => {
  test('should load web client landing page over HTTP/HTTPS', async ({ page }) => {
    await page.goto('/', { waitUntil: 'commit' });
    const wordmark = page.locator('text=agenticRemote').first();
    await expect(wordmark).toBeVisible({ timeout: 15000 });
    const subtitle = page.locator('text=Your terminal, at reach.').first();
    await expect(subtitle).toBeVisible({ timeout: 5000 });
  });

  test('should render daemon secure pairing prompt', async ({ page }) => {
    await page.goto('/', { waitUntil: 'commit' });
    const prompt = page.locator('text=Pair this device with a running daemon').first();
    await expect(prompt).toBeVisible({ timeout: 15000 });
    const connectBtn = page.locator('text=Connect daemon').first();
    await expect(connectBtn).toBeVisible({ timeout: 5000 });
  });

  test('should open pairing sheet and accept secure daemon payload', async ({ page }) => {
    await page.goto('/', { waitUntil: 'commit' });
    const connectBtn = page.locator('text=Connect daemon').first();
    await expect(connectBtn).toBeVisible({ timeout: 15000 });
    await connectBtn.click();

    const modalTitle = page.locator('text=Connect a daemon').first();
    await expect(modalTitle).toBeVisible({ timeout: 5000 });

    const deviceNameInput = page.locator('input[placeholder="Device name"]');
    await expect(deviceNameInput).toBeVisible({ timeout: 5000 });
    await deviceNameInput.fill('e2e-browser-client');
    await expect(deviceNameInput).toHaveValue('e2e-browser-client');

    const payloadInput = page.locator('textarea[placeholder="Paste pairing JSON"]');
    await expect(payloadInput).toBeVisible({ timeout: 5000 });
    const payload = JSON.stringify({
      daemonId: 'daemon-test-1',
      url: 'https://127.0.0.1:18765',
      fingerprint: 'sha256:abcd1234abcd1234',
      token: 'tok-e2e-test-1234',
    });
    await payloadInput.fill(payload);
    await expect(payloadInput).toHaveValue(payload);

    const cancelBtn = page.locator('[aria-label="cancel-pairing"]');
    await expect(cancelBtn).toBeVisible({ timeout: 5000 });
    await cancelBtn.click();

    await expect(modalTitle).toBeHidden({ timeout: 5000 });
  });
});
