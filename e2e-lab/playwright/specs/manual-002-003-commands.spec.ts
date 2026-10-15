import { test, expect, type Page } from "@playwright/test";
import { ensurePaired } from "../helpers";


async function createAgent(page: Page): Promise<{ id: string }> {
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/v1/agents") &&
      response.status() === 201,
  );
  await page.getByLabel(/^New Agent /).click();
  await page.getByLabel("Workspace Path").fill("project1");
  await page.getByLabel("Create Agent").click();
  return (await (await created).json()) as { id: string };
}

function promptInput(page: Page) {
  return page
    .locator(
      'textarea[placeholder="Send instruction to agent..."], input[placeholder="Send instruction to agent..."]',
    )
    .first();
}

// OMP 18.6.1 does not append a persisted mode_change until its fresh session
// has first materialized through an assistant turn. Then establish Plan through
// the actual terminal and wait on the real browser mode indicator.
async function establishKnownMode(page: Page): Promise<void> {
  const input = promptInput(page);
  await expect(input).toBeVisible({ timeout: 20_000 });
  const promptAccepted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/prompt"),
  );
  await input.fill("E2E_PING");
  await page.getByLabel("Send Prompt").click();
  expect((await promptAccepted).status()).toBe(200);
  await expect(page.getByText("E2E_PONG", { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("Terminal View").click();
  const term = page.locator(".xterm-helper-textarea").first();
  await expect(term).toBeVisible({ timeout: 20_000 });
  await term.click();
  await term.pressSequentially("/plan", { delay: 100 });
  await page.waitForTimeout(100);
  await term.press("Enter");
  await expect(page.locator(".xterm").first()).toContainText("/plan", { timeout: 30_000 });
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.getByLabel("Agent Mode")).toHaveText("Plan", { timeout: 30_000 });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByLabel("Chat View").click();
}

test.describe("MANUAL-002/003 real structured commands, @ mentions, and attachments", () => {
  test("discovers and executes a real structured slash command after source-backed mode establishment", async ({ page }) => {
    test.setTimeout(120_000);
    await ensurePaired(page);
    await createAgent(page);
    await expect(page.getByLabel("Chat View")).toBeVisible({ timeout: 20_000 });
    await establishKnownMode(page);

    const input = promptInput(page);
    await expect(input).toBeVisible({ timeout: 20_000 });
    await input.fill("/goal");
    await expect(page.getByLabel("Slash command palette")).toBeVisible({ timeout: 10_000 });
    const row = page.getByLabel("Run command goal_show");
    await expect(row).toBeVisible({ timeout: 10_000 });
    expect(await row.getAttribute("aria-disabled")).not.toBe("true");

    const commandDispatch = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/command") &&
        response.request().postDataJSON()?.name === "goal_show",
    );
    await row.click();
    const response = await commandDispatch;
    expect(response.status()).toBe(200);
    await expect(page.getByLabel("Slash command palette")).not.toBeVisible({ timeout: 10_000 });
  });

  test("rejects an unknown slash command before any network dispatch", async ({ page }) => {
    test.setTimeout(90_000);
    await ensurePaired(page);
    await createAgent(page);
    await expect(page.getByLabel("Chat View")).toBeVisible({ timeout: 20_000 });

    let commandDispatched = false;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/command")) commandDispatched = true;
    });

    const input = promptInput(page);
    await expect(input).toBeVisible({ timeout: 20_000 });
    await input.fill("/totally-unknown-command");
    await expect(page.getByLabel("Slash command palette")).toHaveCount(0, { timeout: 5_000 });
    expect(commandDispatched).toBe(false);
  });

  test("real @ mention completion inserts a real workspace-relative path", async ({ page }) => {
    test.setTimeout(90_000);
    await ensurePaired(page);
    await createAgent(page);
    await expect(page.getByLabel("Chat View")).toBeVisible({ timeout: 20_000 });

    const input = promptInput(page);
    await expect(input).toBeVisible({ timeout: 20_000 });
    await input.fill("please check @sample");
    await expect(page.getByLabel("Mention file suggestions")).toBeVisible({ timeout: 10_000 });
    const suggestion = page.getByLabel(/^Mention file .*sample\.txt$/).first();
    await expect(suggestion).toBeVisible({ timeout: 10_000 });
    const suggestionLabel = await suggestion.getAttribute("aria-label");
    const mentionedPath = suggestionLabel?.replace(/^Mention file /, "") ?? "";
    expect(mentionedPath.endsWith("sample.txt")).toBe(true);
    await suggestion.click();
    await expect(input).toHaveValue(new RegExp(`@${mentionedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} $`));
    await expect(page.getByLabel("Mention file suggestions")).toHaveCount(0, { timeout: 5_000 });
  });

  test("a real local file attachment reaches the submitted prompt, and chip removal cleans up staged upload before send", async ({ page }) => {
    test.setTimeout(120_000);
    await ensurePaired(page);
    await createAgent(page);
    await expect(page.getByLabel("Chat View")).toBeVisible({ timeout: 20_000 });

    const uploadResponse = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().includes("/v1/fs/upload") && response.status() === 201,
    );
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByLabel("Attach local file").click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: "manual-002-attachment.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("MANUAL-002/003 real attachment delivery proof"),
    });
    const upload = await uploadResponse;
    const uploaded = (await upload.json()) as { path: string };
    expect(uploaded.path).toBeTruthy();

    await expect(page.getByLabel("Attachment chips")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("manual-002-attachment.txt")).toBeVisible();

    const input = promptInput(page);
    await input.fill("Please review the attached file");
    const promptDispatch = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/prompt") &&
        response.status() === 200,
    );
    await page.getByLabel("Send Prompt").click();
    const promptRequest = await promptDispatch;
    const promptBody = promptRequest.request().postDataJSON() as {
      attachments?: Array<{ storageRef: string; name: string }>;
    };
    expect(promptBody.attachments?.some((attachment) => attachment.storageRef === uploaded.path)).toBe(true);

    // Second attachment: remove its chip before sending, and assert the staged
    // upload is deleted server-side rather than accumulating.
    const secondUploadResponse = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().includes("/v1/fs/upload") && response.status() === 201,
    );
    const secondFileChooserPromise = page.waitForEvent("filechooser");
    await page.getByLabel("Attach local file").click();
    const secondFileChooser = await secondFileChooserPromise;
    await secondFileChooser.setFiles({
      name: "manual-002-remove-before-send.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("should be deleted before send"),
    });
    const secondUpload = await secondUploadResponse;
    const secondUploaded = (await secondUpload.json()) as { path: string };

    const deleteResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().endsWith("/v1/fs/upload") &&
        response.request().postDataJSON()?.path === secondUploaded.path &&
        response.status() === 204,
    );
    await page.getByLabel(`Remove manual-002-remove-before-send.txt`).click();
    const deleted = await deleteResponse;
    expect(deleted.status()).toBe(204);
  });

  test("a real local PNG attachment reaches the submitted prompt", async ({ page }) => {
    test.setTimeout(120_000);
    await ensurePaired(page);
    await createAgent(page);
    await expect(page.getByLabel("Chat View")).toBeVisible({ timeout: 20_000 });

    const uploadResponse = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().includes("/v1/fs/upload") && response.status() === 201,
    );
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByLabel("Attach local file").click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: "manual-002-image.png",
      mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8VwAAAABJRU5ErkJggg==", "base64"),
    });
    const uploaded = (await (await uploadResponse).json()) as { path: string };

    await expect(page.getByLabel("Attachment chips")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("manual-002-image.png")).toBeVisible();
    const input = promptInput(page);
    await input.fill("Please review the attached image");
    const promptDispatch = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith("/prompt") && response.status() === 200,
    );
    await page.getByLabel("Send Prompt").click();
    const promptRequest = await promptDispatch;
    const promptBody = promptRequest.request().postDataJSON() as { attachments?: Array<{ storageRef: string; name: string }> };
    expect(promptBody.attachments?.some((attachment) => attachment.storageRef === uploaded.path && attachment.name === "manual-002-image.png")).toBe(true);
  });

  test("a pasted PNG reaches the submitted prompt", async ({ page }) => {
    test.setTimeout(120_000);
    await ensurePaired(page);
    await createAgent(page);
    await expect(page.getByLabel("Chat View")).toBeVisible({ timeout: 20_000 });

    const uploadResponse = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().includes("/v1/fs/upload") && response.status() === 201,
    );
    await page.evaluate(() => {
      const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8VwAAAABJRU5ErkJggg=="), (character) => character.charCodeAt(0));
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([bytes], "manual-003-clipboard.png", { type: "image/png" }));
      window.dispatchEvent(new ClipboardEvent("paste", { clipboardData }));
    });
    const uploaded = (await (await uploadResponse).json()) as { path: string };

    await expect(page.getByLabel("Attachment chips")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("manual-003-clipboard.png")).toBeVisible();
    const input = promptInput(page);
    await input.fill("Please review the pasted image");
    const promptDispatch = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith("/prompt") && response.status() === 200,
    );
    await page.getByLabel("Send Prompt").click();
    const promptRequest = await promptDispatch;
    const promptBody = promptRequest.request().postDataJSON() as { attachments?: Array<{ storageRef: string; name: string }> };
    expect(promptBody.attachments?.some((attachment) => attachment.storageRef === uploaded.path && attachment.name === "manual-003-clipboard.png")).toBe(true);
  });
});
