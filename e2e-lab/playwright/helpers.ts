import { getRealPairingPayload } from './pairing-payload';
import { type Page } from './page-interface';

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
  await connectBtn.waitFor({ state: 'visible', timeout: 10000 });
  await connectBtn.click();
  const modalTitle = page.locator('text="Connect a daemon"').first();
  await modalTitle.waitFor({ state: 'visible', timeout: 5000 });
  const deviceNameInput = page.locator('input[placeholder="Device name"]');
  await deviceNameInput.waitFor({ state: 'visible', timeout: 5000 });
  await deviceNameInput.fill('Playwright Web Client');
  const skipSwitch = page.locator('button[role="switch"], input[type="checkbox"]').first();
  if (await skipSwitch.isVisible().catch(() => false)) {
    const checked = await skipSwitch.getAttribute('aria-checked');
    if (checked !== 'true') {
      await skipSwitch.click();
    }
  }
  const payloadInput = page.locator(
    'textarea[placeholder="Paste pairing JSON"], input[placeholder="Paste pairing JSON"]'
  );
  await payloadInput.waitFor({ state: 'visible', timeout: 5000 });
  await payloadInput.fill(payload);
  const submitBtn = page.locator('[aria-label="Connect"], [accessibilityLabel="Connect"]').first();
  await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
  await submitBtn.click();
  // After pairing, dashboard with "New Agent" button should appear
  const newAgentBtn2 = page.locator('[aria-label^="New Agent"]:visible').first();
  await newAgentBtn2.waitFor({ state: 'visible', timeout: 40000 });
}

// Re-export for specs that use it directly
export { getRealPairingPayload };
