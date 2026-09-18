import { test, expect } from '@playwright/test';

const APP_URL = 'http://127.0.0.1:19100';

test.describe('Phase 2 - Web Client Agent Interaction & Turn Lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(APP_URL);
    await page.click('button[data-view="agent"]');
    await expect(page.locator('#view-agent')).toBeVisible();
  });

  test('RAR-E2E-206: Agent Prompt Submission and Mock OMP Stream Handling', async ({ page }) => {
    await page.fill('#agentPromptInput', 'Refactor database models to use foreign keys');
    await page.click('#btnSendAgentPrompt');

    // Should render user message bubble
    await expect(page.locator('.msg-user')).toContainText('Refactor database models');

    // Should render tool execution bubble
    await expect(page.locator('.msg-tool')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.msg-tool')).toContainText('Executing tool: read');

    // Should render agent response bubble
    await expect(page.locator('.msg-agent').last()).toContainText('Agent response: Completed task successfully');
  });

  test('RAR-E2E-207: Agent Turn Cancellation Flow', async ({ page }) => {
    await page.click('#btnCancelAgent');
    await expect(page.locator('.msg-agent').last()).toContainText('[Turn cancelled by user]');
  });
});
