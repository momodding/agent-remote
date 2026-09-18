import { test, expect } from '@playwright/test';

const APP_URL = 'http://127.0.0.1:19100';

test.describe('Phase 2 - Web Client Pairing Flow', () => {
  test('RAR-E2E-201: Renders Pairing Portal and validates empty payload rejection', async ({ page }) => {
    await page.goto(APP_URL);
    await expect(page.locator('h1')).toContainText('agenticRemote');
    await expect(page.locator('#connectionBadge')).toContainText('NOT PAIRED');

    // Click pair with empty input
    await page.click('#btnPairManual');
    await expect(page.locator('#pairingFeedback')).toContainText('Pairing Error');
    await expect(page.locator('#connectionBadge')).toContainText('NOT PAIRED');
  });

  test('RAR-E2E-202: Manual JSON Pairing Payload Exchange and Host Identity', async ({ page }) => {
    await page.goto(APP_URL);

    const samplePayload = JSON.stringify({
      v: 2,
      endpoint: 'https://127.0.0.1:18765',
      pairingId: 'TEST_PAIRING_101',
      token: 'secret_token_1234567890',
      fingerprint: '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00',
    });

    await page.fill('#pairingInput', samplePayload);
    await page.click('#btnPairManual');

    await expect(page.locator('#connectionBadge')).toContainText('CONNECTED');
    await expect(page.locator('#pairingFeedback')).toContainText('Successfully paired');
    await expect(page.locator('#infoPairingId')).toContainText('TEST_PAIRING_101');
    await expect(page.locator('#infoEndpoint')).toContainText('https://127.0.0.1:18765');
  });

  test('RAR-E2E-203: Simulated QR Code Scan Flow & Session Teardown', async ({ page }) => {
    await page.goto(APP_URL);

    // Simulate QR Scan
    await page.click('#btnSimulateQR');
    await expect(page.locator('#connectionBadge')).toContainText('CONNECTED');
    await expect(page.locator('#pairedInfoCard')).toBeVisible();

    // Disconnect & Unpair
    await page.click('#btnUnpair');
    await expect(page.locator('#connectionBadge')).toContainText('NOT PAIRED');
    await expect(page.locator('#pairedInfoCard')).not.toBeVisible();
  });
});
