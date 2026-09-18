import { test, expect } from '@playwright/test';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'desktop', width: 1920, height: 1080 },
];

test.describe('Responsive Design', () => {
  for (const viewport of viewports) {
    test(`should render correctly on ${viewport.name} (${viewport.width}x${viewport.height})`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      const page = await context.newPage();
      await page.goto('/', { waitUntil: 'commit' });

      const wordmark = page.locator('text=agenticRemote').first();
      await expect(wordmark).toBeVisible({ timeout: 15000 });

      const connectBtn = page.locator('text=Connect daemon').first();
      await expect(connectBtn).toBeVisible({ timeout: 5000 });

      await page.screenshot({
        path: `./artifacts/playwright/responsive-${viewport.name}.png`,
        fullPage: false,
      });

      await context.close();
    });
  }

  test('should not show horizontal scroll on mobile', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.goto('/', { waitUntil: 'commit' });

    const wordmark = page.locator('text=agenticRemote').first();
    await expect(wordmark).toBeVisible({ timeout: 15000 });

    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });

    expect(hasHorizontalScroll).toBe(false);

    await context.close();
  });
});
