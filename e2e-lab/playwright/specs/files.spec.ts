import { test, expect } from '@playwright/test';
import { ensurePaired } from '../helpers';

test.describe('Web Files sandbox live daemon flow', () => {
  test('browses the seeded workspace tree and reads daemon-created content', async ({ page }) => {
    test.setTimeout(90_000);
    await ensurePaired(page);

    const filesButton = page.getByLabel(/^New Files /).first();
    await expect(filesButton).toBeVisible({ timeout: 20_000 });
    await filesButton.click();

    await expect(page.getByLabel('Open folder project1')).toBeVisible({ timeout: 20_000 });
    await page.getByLabel('Open folder project1').click();
    await expect(page.getByLabel('Open file sample.txt')).toBeVisible({ timeout: 15_000 });

    const readResponse = page.waitForResponse((response) =>
      response.request().method() === 'GET' &&
      /\/v1\/fs\/read\?path=project1%2Fsample\.txt$/.test(response.url()) &&
      response.status() === 200,
    );
    await page.getByLabel('Open file sample.txt').click();
    await readResponse;

    const editor = page.locator('textarea').first();
    await expect(editor).toHaveValue('Hello from sample.txt in project1\n');
    await expect(page.getByText('project1/sample.txt', { exact: true })).toBeVisible();
  });
});
