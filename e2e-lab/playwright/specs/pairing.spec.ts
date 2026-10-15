import { test, expect } from '@playwright/test';
import { ensurePaired, getRealPairingPayload } from '../helpers';
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
    const realPayload = getRealPairingPayload();
    if (!realPayload) {
      throw new Error(
        'BLOCKED: Real daemon pairing payload (E2E_REAL_PAIRING_PAYLOAD) is required. Forged payloads or simulated cancels are strictly prohibited.'
      );
    }

    await ensurePaired(page, realPayload);

    const daemonEndpoint = new URL(JSON.parse(realPayload).endpoint).host;
    await expect(page.locator(`text=${daemonEndpoint}`).first()).toBeVisible({ timeout: 15000 });
  });
});
