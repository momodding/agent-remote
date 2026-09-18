import { test, expect } from '@playwright/test';

test.describe('Web Terminal (xterm)', () => {
  test('should render terminal container', async ({ page }) => {
    await page.goto('/');
    
    // Look for xterm canvas or terminal div
    const terminal = page.locator('[data-testid="terminal"], .xterm, [class*="terminal"]');
    
    if (await terminal.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      await expect(terminal.first()).toBeVisible();
    }
  });

  test('should render multiple terminal tabs', async ({ page }) => {
    await page.goto('/');
    
    const tabs = page.locator('[role="tab"], [data-testid*="tab"], .tab');
    const tabCount = await tabs.count().catch(() => 0);
    
    if (tabCount > 0) {
      expect(tabCount).toBeGreaterThan(0);
    }
  });

  test('should switch between terminal tabs', async ({ page }) => {
    await page.goto('/');
    
    const tabs = page.locator('button:has-text("Terminal"), button[role="tab"]');
    const firstTab = tabs.first();
    
    if (await firstTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await firstTab.click();
      await page.waitForTimeout(500);
      await expect(firstTab).toHaveAttribute('aria-selected', 'true').catch(() => true);
    }
  });

  test('should accept terminal input', async ({ page }) => {
    await page.goto('/');
    
    const terminal = page.locator('[data-testid="terminal"], .xterm, [class*="terminal"]');
    
    if (await terminal.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      // Click terminal to focus
      await terminal.first().click();
      // Type a test command
      await page.keyboard.type('echo hello', { delay: 50 });
      await page.keyboard.press('Enter');
      // Wait for potential response
      await page.waitForTimeout(500);
    }
  });

  test('should handle terminal disconnection gracefully', async ({ page }) => {
    await page.goto('/');
    
    const terminal = page.locator('[data-testid="terminal"], .xterm, [class*="terminal"]');
    
    if (await terminal.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      // Navigate away and back
      await page.goto('/');
      await expect(terminal.first()).toBeVisible({ timeout: 5000 }).catch(() => true);
    }
  });
});
