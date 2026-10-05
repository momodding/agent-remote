import { test, expect, type WebSocket } from '@playwright/test';
import { ensurePaired } from '../helpers';

test.describe('Web Desktop noVNC live RFB flow', () => {
  test('acquires a daemon ticket then renders a real Xvfb framebuffer over WSS', async ({ page }) => {
    test.setTimeout(90_000);
    const rfbSockets: WebSocket[] = [];
    let desktopSessionURL = '';
    page.on('websocket', (socket) => {
      if (socket.url().includes('/v1/ws/rfb?ticket=')) rfbSockets.push(socket);
    });
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/v1/desktop/sessions')) desktopSessionURL = request.url();
    });

    await ensurePaired(page);
    const desktopButton = page.getByLabel(/^New Desktop /).first();
    await expect(desktopButton).toBeVisible({ timeout: 20_000 });
    await desktopButton.click();
    await expect(page.locator('iframe[title="Remote Desktop"]')).toBeVisible({ timeout: 20_000 });

    await expect.poll(() => desktopSessionURL, { timeout: 20_000 }).toContain('/v1/desktop/sessions');
    await expect.poll(() => rfbSockets.length, { timeout: 20_000 }).toBe(1);
    expect(rfbSockets[0].url()).toMatch(/^wss:\/\/localhost:18765\/v1\/ws\/rfb\?ticket=/);

    const desktop = page.frameLocator('iframe[title="Remote Desktop"]');
    const framebuffer = desktop.locator('canvas').first();
    await expect(framebuffer).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => framebuffer.evaluate((canvas: HTMLCanvasElement) => ({ width: canvas.width, height: canvas.height })), { timeout: 20_000 }).toEqual({ width: 800, height: 600 });
  });
});
