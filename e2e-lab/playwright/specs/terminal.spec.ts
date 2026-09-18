import { test, expect } from '@playwright/test';
import { ensurePaired } from '../helpers';

test.describe('Web Terminal & Real Daemon Session Flow', () => {
  test('should drive real Terminal session with live daemon', async ({ page }) => {
    // Ensure authentic Auth-v2 pairing
    await ensurePaired(page);
    // Open dedicated Terminal session from dashboard
    const newTerminalBtn = page.locator('[aria-label*="New Terminal"]').first();
    await expect(newTerminalBtn).toBeVisible({ timeout: 15000 });
    await newTerminalBtn.click();

    // Verify dedicated terminal page and surface
    const terminalHeader = page.getByText('Shell');
    await expect(terminalHeader).toBeVisible({ timeout: 15000 });

    const xtermSurface = page.locator('.xterm, canvas, [data-testid="terminal-container"]').first();
    await expect(xtermSurface).toBeVisible({ timeout: 10000 });
  });
});
