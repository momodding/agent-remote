import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { expect, type Page } from '@playwright/test';

/**
 * Resolves the real Auth-v2 pairing payload from daemon container, env, or .runtime/pairing.json.
 */
export function getRealPairingPayload(): string {
  try {
    const output = execSync('podman logs agenticremote-daemon 2>&1 | grep -E "^{\\"v\\":2," | tail -n 1', {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    if (output) return output;
  } catch {
    // ignore
  }

  const runtimeFile = path.join(__dirname, '../.runtime/pairing.json');
  if (fs.existsSync(runtimeFile)) {
    try {
      return fs.readFileSync(runtimeFile, 'utf-8').trim();
    } catch {
      // ignore
    }
  }

  if (process.env.E2E_REAL_PAIRING_PAYLOAD) {
    return process.env.E2E_REAL_PAIRING_PAYLOAD.trim();
  }

  return '';
}

/**
 * Ensures browser client is paired with real daemon over live Auth-v2.
 * No localStorage tokens or forged credentials.
 */
export async function ensurePaired(page: Page, realPayload?: string): Promise<void> {
  const payload = realPayload || getRealPairingPayload();
  if (!payload) {
    throw new Error(
      'BLOCKED: Real daemon pairing payload is required. Forged payloads or simulated auth are strictly prohibited.'
    );
  }

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const newAgentBtn = page.locator('[aria-label^="New Agent"]:visible').first();
  const connectBtn = page.locator('[aria-label="Connect daemon"]:visible').first();

  // Wait for either the dashboard (already connected) or the Connect daemon button
  await page
    .locator('[aria-label^="New Agent"]:visible, [aria-label="Connect daemon"]:visible')
    .first()
    .waitFor({ timeout: 25000 });

  if (await newAgentBtn.isVisible()) {
    return;
  }

  await expect(connectBtn).toBeVisible({ timeout: 10000 });
  await connectBtn.click();

  const modalTitle = page.locator('text="Connect a daemon"').first();
  await expect(modalTitle).toBeVisible({ timeout: 5000 });

  const deviceNameInput = page.locator('input[placeholder="Device name"]');
  await expect(deviceNameInput).toBeVisible({ timeout: 5000 });
  await deviceNameInput.fill('Playwright Web Client');

  const payloadInput = page.locator(
    'textarea[placeholder="Paste pairing JSON"], input[placeholder="Paste pairing JSON"]'
  );
  await expect(payloadInput).toBeVisible({ timeout: 5000 });
  await payloadInput.fill(payload);

  const submitBtn = page.locator('[aria-label="Connect"], [accessibilityLabel="Connect"]').first();
  await expect(submitBtn).toBeVisible({ timeout: 5000 });
  await submitBtn.click();

  // Assert navigation to dashboard with New Agent button visible
  await expect(newAgentBtn).toBeVisible({ timeout: 25000 });
}
