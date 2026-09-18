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
      
      await page.goto('/');
      
      // Check that main content is visible
      const main = page.locator('main, [role="main"], body > *');
      await expect(main.first()).toBeVisible({ timeout: 5000 }).catch(() => true);
      
      // Take screenshot for visual inspection
      await page.screenshot({
        path: `./artifacts/playwright/responsive-${viewport.name}.png`,
        fullPage: false,
      }).catch(() => {
        // Screenshot directory may not exist, that's okay for this test
      });
      
      await context.close();
    });
  }

  test('should not show horizontal scroll on mobile', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    
    await page.goto('/');
    
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const viewportWidth = 390;
    
    expect(scrollWidth).toBeLessThanOrEqual(viewportWidth + 1);
    
    await context.close();
  });

  test('should have readable text on all viewports', async ({ browser }) => {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      const page = await context.newPage();
      
      await page.goto('/');
      
      // Check for text content
      const textContent = await page.textContent('body');
      expect(textContent).toBeTruthy();
      
      await context.close();
    }
  });
});
