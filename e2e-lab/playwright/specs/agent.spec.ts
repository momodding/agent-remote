import { test, expect } from '@playwright/test';

test.describe('Web Agent & Live Daemon Session Flow', () => {
  test('should drive real Agent session with live daemon', async ({ page }) => {
    const realPayload = process.env.E2E_REAL_PAIRING_PAYLOAD;
    if (!realPayload) {
      throw new Error(
        'BLOCKED: Real paired daemon connection required. Forged localStorage tokens or mocked sessions are strictly prohibited.'
      );
    }

    await page.goto('/', { waitUntil: 'commit' });

    // Expect real paired connection on dashboard
    const newSessionBtn = page.locator('text=New Session, text=Create Agent').first();
    await expect(newSessionBtn).toBeVisible({ timeout: 15000 });
    await newSessionBtn.click();

    // Verify chat interface loaded
    const promptInput = page.locator('textarea[placeholder*="Ask"], input[placeholder*="Ask"]').first();
    await expect(promptInput).toBeVisible({ timeout: 10000 });
    await promptInput.fill('E2E_PONG');

    const sendBtn = page.locator('[aria-label="Send"], button:has-text("Send")').first();
    await expect(sendBtn).toBeVisible({ timeout: 5000 });
    await sendBtn.click();

    // Verify response from deterministic provider through daemon
    const responseMsg = page.locator('text=PONG').first();
    await expect(responseMsg).toBeVisible({ timeout: 20000 });
  });
});
