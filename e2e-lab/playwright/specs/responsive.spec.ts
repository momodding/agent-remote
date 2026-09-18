import { test, expect } from '@playwright/test';

const APP_URL = 'http://127.0.0.1:19100';

test.describe('Phase 2 - Web Client Responsive Layout & Viewports', () => {
  test('RAR-E2E-208: Mobile Viewport (390x844) & Navigation Drawer Toggle', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(APP_URL);

    // Hamburger button should be visible on mobile
    const menuBtn = page.locator('#menuToggle');
    await expect(menuBtn).toBeVisible();

    // Toggle menu
    await menuBtn.click();
    await expect(page.locator('#sidebar')).toHaveClass(/open/);

    // Click terminal nav
    await page.click('button[data-view="terminal"]');
    await expect(page.locator('#view-terminal')).toBeVisible();

    // Capture mobile screenshot
    await page.screenshot({ path: 'artifacts/playwright/mobile-390x844.png' });
  });

  test('RAR-E2E-209: Tablet Viewport (820x1180) & Layout Adaptability', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto(APP_URL);

    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('#sidebar')).toBeVisible();

    await page.click('button[data-view="settings"]');
    await expect(page.locator('#diagViewport')).toContainText('820 x 1180');

    // Capture tablet screenshot
    await page.screenshot({ path: 'artifacts/playwright/tablet-820x1180.png' });
  });

  test('RAR-E2E-210: Desktop Viewport (1920x1080) & High-Resolution Layout', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(APP_URL);

    await page.click('button[data-view="settings"]');
    await expect(page.locator('#diagViewport')).toContainText('1920 x 1080');

    // Capture desktop screenshot
    await page.screenshot({ path: 'artifacts/playwright/desktop-1920x1080.png' });
  });
});
