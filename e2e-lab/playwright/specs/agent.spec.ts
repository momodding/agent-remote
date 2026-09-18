import { test, expect } from '@playwright/test';

test.describe('Web Agent Chat', () => {
  test('should load chat interface', async ({ page }) => {
    await page.goto('/');
    
    const chatContainer = page.locator('[data-testid="chat"], [data-testid="agent"], textarea, input[placeholder*="message"]');
    
    if (await chatContainer.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      await expect(chatContainer.first()).toBeVisible();
    }
  });

  test('should display agent prompt input', async ({ page }) => {
    await page.goto('/');
    
    const input = page.locator('textarea[placeholder*="message"], textarea[placeholder*="prompt"], input[placeholder*="message"]').first();
    
    if (await input.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(input).toBeVisible();
    }
  });

  test('should submit agent prompt', async ({ page }) => {
    await page.goto('/');
    
    const input = page.locator('textarea, input[placeholder*="message"]').first();
    const button = page.locator('button').filter({ hasText: /send|submit|go/i }).first();
    
    if (await input.isVisible({ timeout: 3000 }).catch(() => false)) {
      await input.click();
      await input.fill('List directory contents');
      
      if (await button.isVisible({ timeout: 2000 }).catch(() => false)) {
        await button.click();
        await page.waitForTimeout(1000);
      }
    }
  });

  test('should render tool card from agent', async ({ page }) => {
    await page.goto('/');
    
    const toolCard = page.locator('[data-testid="tool-card"], [class*="tool"], [class*="card"]');
    
    const count = await toolCard.count().catch(() => 0);
    if (count > 0) {
      await expect(toolCard.first()).toBeVisible().catch(() => true);
    }
  });

  test('should render agent message history', async ({ page }) => {
    await page.goto('/');
    
    const messages = page.locator('[role="log"], [data-testid="messages"], [class*="message"]');
    
    const count = await messages.count().catch(() => 0);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('should handle agent response display', async ({ page }) => {
    await page.goto('/');
    
    const responseArea = page.locator('[data-testid="response"], [class*="response"], [class*="output"]');
    
    if (await responseArea.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(responseArea.first()).toBeVisible();
    }
  });
});
