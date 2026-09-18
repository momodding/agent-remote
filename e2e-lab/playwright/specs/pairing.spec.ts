import { test, expect } from '@playwright/test';

test.describe('Web Client Pairing & Real Auth-v2 Verification', () => {
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

  test('should perform real daemon Auth-v2 pairing via pairing sheet', async ({ page }) => {
    const realPayload = process.env.E2E_REAL_PAIRING_PAYLOAD;
    if (!realPayload) {
      throw new Error(
        'BLOCKED: Real daemon pairing payload (E2E_REAL_PAIRING_PAYLOAD) is required. Forged payloads or simulated cancels are strictly prohibited.'
      );
    }

    await page.goto('/', { waitUntil: 'commit' });

    const connectBtn = page.locator('text=Connect daemon').first();
    await expect(connectBtn).toBeVisible({ timeout: 15000 });
    await connectBtn.click();

    const modalTitle = page.locator('text=Connect a daemon').first();
    await expect(modalTitle).toBeVisible({ timeout: 5000 });

    const deviceNameInput = page.locator('input[placeholder="Device name"]');
    await expect(deviceNameInput).toBeVisible({ timeout: 5000 });
    await deviceNameInput.fill('e2e-browser-client');

    const payloadInput = page.locator('textarea[placeholder="Paste pairing JSON"]');
    await expect(payloadInput).toBeVisible({ timeout: 5000 });
    await payloadInput.fill(realPayload);

    // Click real Connect button to execute Auth-v2 handshake
    const submitBtn = page.locator('[aria-label="Connect"], [accessibilityLabel="Connect"]').first();
    await expect(submitBtn).toBeVisible({ timeout: 5000 });
    await submitBtn.click();

    // Verify modal closes and daemon dashboard appears with live connection
    await expect(modalTitle).toBeHidden({ timeout: 15000 });
    const daemonCard = page.locator('text=e2e-browser-client').first();
    await expect(daemonCard).toBeVisible({ timeout: 10000 });
  });
});
