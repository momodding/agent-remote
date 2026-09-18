import { test, expect } from '@playwright/test';

test.describe('Web Terminal & Real Daemon Session Flow', () => {
  test('should drive real Terminal session with live daemon', async ({ page }) => {
    const realPayload = process.env.E2E_REAL_PAIRING_PAYLOAD;
    if (!realPayload) {
      throw new Error(
        'BLOCKED: Real paired daemon connection required. Forged localStorage tokens or mocked sessions are strictly prohibited.'
      );
    }

    await page.goto('/', { waitUntil: 'commit' });

    // Open terminal tab/session
    const terminalBtn = page.locator('text=Terminal, [aria-label="Terminal"]').first();
    await expect(terminalBtn).toBeVisible({ timeout: 15000 });
    await terminalBtn.click();

    // Verify terminal surface is rendered
    const xterm = page.locator('.xterm, [data-testid="terminal-container"]').first();
    await expect(xterm).toBeVisible({ timeout: 10000 });
  });
});
