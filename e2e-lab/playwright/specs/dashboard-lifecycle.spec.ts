import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ensurePaired } from '../helpers';

async function returnToDashboard(page: Page, session: 'agent' | 'terminal') {
  await page.goBack();
  await expect(lifecycleAction(page, session)).toBeVisible({ timeout: 30_000 });
}

async function createAgent(page: Page) {
  await page.getByLabel(/^New Agent /).click();
  await page.getByLabel('Workspace Path').fill('project1');
  await page.getByLabel('Create Agent').click();
  await expect(page.getByLabel('Chat View')).toBeVisible({ timeout: 30_000 });
  await returnToDashboard(page, 'agent');
}

async function createTerminal(page: Page) {
  await page.getByLabel(/^New Terminal /).click();
  await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 });
  await returnToDashboard(page, 'terminal');
}

function lifecycleAction(page: Page, session: 'agent' | 'terminal') {
  return page.locator(`[aria-label^="Terminate ${session} "]`);
}


test.describe('Dashboard real session lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  for (const session of ['agent', 'terminal'] as const) {
    test(`Terminate destroys a ${session} remotely and it remains absent after reload and reconnect`, async ({ page }, testInfo) => {
      test.setTimeout(180_000);
      await ensurePaired(page);
      if (session === 'agent') await createAgent(page);
      else await createTerminal(page);
      await lifecycleAction(page, session).click();
      await expect(page.getByLabel('Session lifecycle confirmation')).toBeVisible();
      mkdirSync(resolve(process.cwd(), 'artifacts/manual-lifecycle'), { recursive: true });
      await page.screenshot({ path: resolve(process.cwd(), `artifacts/manual-lifecycle/${session}-terminate-confirmation.png`) });
      await testInfo.attach(`${session}-terminate-confirmation.png`, { body: await page.screenshot(), contentType: 'image/png' });
      const terminated = page.waitForResponse((response) => response.request().method() === 'POST' && response.status() === 200 && (session === 'agent' ? /\/v1\/agents\/[^/]+\/terminate$/.test(response.url()) : /\/v1\/sessions\/[^/]+\/close$/.test(response.url())));
      await page.getByLabel('Terminate session').click();
      await terminated;
      await expect(lifecycleAction(page, session)).toHaveCount(0, { timeout: 15_000 });
      await page.reload();
      await ensurePaired(page);
      await expect(page.getByLabel(new RegExp(`^Open ${session} `))).toHaveCount(0, { timeout: 30_000 });
    });
  }

});
