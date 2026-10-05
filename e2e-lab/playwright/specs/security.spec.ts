import { test, expect } from '@playwright/test';
import { ensurePaired } from '../helpers';

test.describe('Web session transport and credential surface security', () => {
  test('uses HTTPS/WSS and exposes no cleartext credential in DOM, localStorage, or cookies', async ({ page }) => {
    test.setTimeout(90_000);
    const secureRequests: string[] = [];
    const secureSockets: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith('https://')) secureRequests.push(request.url());
    });
    page.on('websocket', (socket) => {
      if (socket.url().startsWith('wss://')) secureSockets.push(socket.url());
    });

    await ensurePaired(page);
    await expect(page.getByLabel(/^New Files /).first()).toBeVisible({ timeout: 20_000 });
    await page.getByLabel(/^New Files /).first().click();
    await expect(page.getByLabel('Open folder project1')).toBeVisible({ timeout: 20_000 });

    expect(secureRequests.length).toBeGreaterThan(0);
    expect(secureSockets.length).toBeGreaterThan(0);
    const clientSurface = await page.evaluate(() => ({
      dom: document.documentElement.outerHTML,
      localStorage: Object.values(localStorage),
      cookies: document.cookie,
    }));
    expect(clientSurface.dom).not.toMatch(/bearer\s+[a-z0-9._-]{16,}/i);
    expect(clientSurface.cookies).not.toMatch(/token|bearer|session/i);
    for (const persistedValue of clientSurface.localStorage) {
      const parsed = JSON.parse(persistedValue) as { connections?: Array<{ token?: unknown }> };
      expect(parsed.connections?.some((connection) => typeof connection.token === 'string' && connection.token.length > 0)).toBeFalsy();
    }
  });
});
