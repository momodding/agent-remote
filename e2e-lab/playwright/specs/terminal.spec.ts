import { test, expect, type WebSocket } from '@playwright/test';
import { ensurePaired } from '../helpers';

test.describe('Web Terminal & Real Daemon Session Flow', () => {
  test('sends terminal input and receives a shell marker through the live daemon', async ({ page }) => {
    test.setTimeout(180000);

    const marker = `E2E_TERMINAL_MARKER_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const command = `printf '%s\\n' '${marker}'`;
    let terminalSocket: WebSocket | undefined;
    let sentInput = '';
    let resolveOutput: ((output: string) => void) | undefined;
    const markerOutput = new Promise<string>((resolve) => { resolveOutput = resolve; });

    page.on('websocket', (socket) => {
      if (!socket.url().includes('/v1/ws/sessions/')) return;
      terminalSocket = socket;
      socket.on('framesent', ({ payload }) => {
        try {
          const frame = JSON.parse(payload.toString());
          if (frame.type === 'pty.input' && typeof frame.data === 'string') {
            sentInput += Buffer.from(frame.data, 'base64').toString('utf8');
          }
        } catch {
          // Ignore non-terminal WebSocket frames.
        }
      });
      socket.on('framereceived', ({ payload }) => {
        try {
          const frame = JSON.parse(payload.toString());
          if ((frame.type === 'pty.baseline' || frame.type === 'pty.output') && typeof frame.data === 'string') {
            const output = Buffer.from(frame.data, 'base64').toString('utf8');
            if (output.includes(marker)) resolveOutput?.(output);
          }
        } catch {
          // Ignore non-terminal WebSocket frames.
        }
      });
    });

    await ensurePaired(page);
    const newTerminalBtn = page.locator('[aria-label*="New Terminal"]').first();
    await expect(newTerminalBtn).toBeVisible({ timeout: 15000 });
    await newTerminalBtn.click();

    const terminalHeader = page.getByText('Shell');
    await expect(terminalHeader).toBeVisible({ timeout: 15000 });
    const xtermSurface = page.locator('.xterm').first();
    await expect(xtermSurface).toBeVisible({ timeout: 10000 });
    const xtermInput = page.locator('.xterm-helper-textarea').first();
    await expect(xtermInput).toBeVisible({ timeout: 10000 });

    await xtermInput.click();
    await xtermInput.pressSequentially(command);
    await xtermInput.press('Enter');

    await expect.poll(() => terminalSocket, { timeout: 10000 }).toBeTruthy();
    await expect.poll(() => sentInput.includes(command) && /\r?\n?$/.test(sentInput), { timeout: 10000 }).toBeTruthy();
    await expect(await markerOutput).toContain(marker);
  });
});
