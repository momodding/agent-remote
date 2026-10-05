import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type WebSocket } from '@playwright/test';
import { ensurePaired } from '../helpers';

test.describe('Web Terminal & Real Daemon Session Flow', () => {
  test('sends terminal input and receives a shell marker through the live daemon', async ({ page }, testInfo) => {
    test.setTimeout(180000);

    const marker = `E2E_TERMINAL_MARKER_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const command = `printf '%s\\n' '${marker}'`;
    const provenancePath = resolve(process.cwd(), 'artifacts/terminal-marker-provenance.json');
    const provenance = {
      startedAt: new Date().toISOString(),
      finishedAt: '',
      test: {
        file: 'playwright/specs/terminal.spec.ts',
        title: testInfo.title,
        project: testInfo.project.name,
      },
      git: {
        head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(process.cwd(), '..'), encoding: 'utf8' }).trim(),
        status: execFileSync('git', ['status', '--short'], { cwd: resolve(process.cwd(), '..'), encoding: 'utf8' }).trim(),
      },
      daemon: {
        containerfile: 'e2e-lab/containers/Containerfile.daemon',
        configuredTerminalBackend: 'tmux',
        configuredGoVersion: '1.26.4',
        configuredOMPVersion: '18.1.22',
      },
      terminal: {
        sessionId: '',
        webSocketPath: '',
        inputFrames: 0,
        outputFrames: 0,
        initialBaselineSeen: false,
        markerOutputSeen: false,
      },
    };
    const persistProvenance = () => {
      mkdirSync(resolve(provenancePath, '..'), { recursive: true });
      writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
    };
    persistProvenance();

    let terminalSocket: WebSocket | undefined;
    let sentInput = '';
    let receivedOutput = '';

    page.on('websocket', (socket) => {
      if (!socket.url().includes('/v1/ws/sessions/')) return;
      const url = new URL(socket.url());
      const sessionId = url.pathname.split('/').at(-1) ?? '';
      terminalSocket = socket;
      provenance.terminal.sessionId = sessionId;
      provenance.terminal.webSocketPath = url.pathname;
      persistProvenance();
      socket.on('framesent', ({ payload }) => {
        try {
          const frame = JSON.parse(payload.toString());
          if (frame.type === 'pty.input' && typeof frame.data === 'string') {
            provenance.terminal.inputFrames += 1;
            sentInput += Buffer.from(frame.data, 'base64').toString('utf8');
            persistProvenance();
          }
        } catch {
          // Ignore non-terminal WebSocket frames.
        }
      });
      socket.on('framereceived', ({ payload }) => {
        try {
          const frame = JSON.parse(payload.toString());
          if ((frame.type === 'pty.baseline' || frame.type === 'pty.output') && typeof frame.data === 'string') {
            provenance.terminal.outputFrames += 1;
            if (frame.type === 'pty.baseline') provenance.terminal.initialBaselineSeen = true;
            const output = Buffer.from(frame.data, 'base64').toString('utf8');
            receivedOutput += output;
            if (output.includes(marker)) provenance.terminal.markerOutputSeen = true;
            persistProvenance();
          }
        } catch {
          // Ignore non-terminal WebSocket frames.
        }
      });
    });

    try {
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
      await expect.poll(() => receivedOutput.includes(marker), { timeout: 30000 }).toBeTruthy();
      await expect(xtermSurface).toContainText(marker, { timeout: 10000 });
    } finally {
      provenance.finishedAt = new Date().toISOString();
      persistProvenance();
    }
  });
});
