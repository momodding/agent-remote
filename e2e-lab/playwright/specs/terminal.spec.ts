import { test, expect } from '@playwright/test';

const APP_URL = 'http://127.0.0.1:19100';

test.describe('Phase 2 - Web Client Terminal & PTY Sessions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(APP_URL);
    // Pair first
    await page.click('#btnSimulateQR');
    await expect(page.locator('#connectionBadge')).toContainText('CONNECTED');
    // Navigate to terminal
    await page.click('button[data-view="terminal"]');
    await expect(page.locator('#view-terminal')).toBeVisible();
  });

  test('RAR-E2E-204: Multi-tab terminal management (Create, Switch, Close)', async ({ page }) => {
    // Initial tab exists from pairing
    await expect(page.locator('.tab-item')).toHaveCount(1);

    // Create 2 more tabs
    await page.click('#btnNewTerminal');
    await page.click('#btnNewTerminal');
    await expect(page.locator('.tab-item')).toHaveCount(3);

    // Select second tab
    const tabs = page.locator('.tab-item');
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveClass(/active/);

    // Close the third tab
    await page.locator('.tab-item:nth-child(3) .close-tab').click();
    await expect(page.locator('.tab-item')).toHaveCount(2);
  });

  test('RAR-E2E-205: PTY command execution and output rendering', async ({ page }) => {
    await page.fill('#terminalInput', 'echo PTY_PLAYWRIGHT_OK');
    await page.click('#btnSendInput');

    // Terminal screen should contain the echoed output
    await expect(page.locator('#terminalScreen')).toContainText('PTY_PLAYWRIGHT_OK');

    // Send another command
    await page.fill('#terminalInput', 'ls');
    await page.press('#terminalInput', 'Enter');
    await expect(page.locator('#terminalScreen')).toContainText('backend/');
  });
});
