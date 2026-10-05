import { execFileSync } from "node:child_process";
import { test, expect, type APIResponse, type Page } from "@playwright/test";
import { ensurePaired } from "../helpers";

function ompPids(): string[] {
  const compose = `${process.cwd()}/scripts/compose.sh`;
  const command =
    'for p in /proc/[0-9]*; do read comm < "$p/comm" 2>/dev/null || continue; [ "$comm" = omp ] && printf "%s\\n" "${p##*/}"; done; true';
  return execFileSync(
    compose,
    ["exec", "--no-TTY", "daemon", "sh", "-lc", command],
    { encoding: "utf8" },
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

async function createAgent(
  page: Page,
): Promise<{ id: string; terminalSessionId: string }> {
  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/v1/agents") &&
      response.status() === 201,
  );
  await page.getByLabel(/^New Agent /).click();
  const workspaceInput = page.getByLabel("Workspace Path");
  await expect(workspaceInput).toBeVisible({ timeout: 15_000 });
  await workspaceInput.fill("project1");
  await page.getByLabel("Create Agent").click();
  const response: APIResponse = await createResponse;
  const agent = (await response.json()) as {
    id: string;
    terminalSessionId: string;
  };
  expect(agent.id).toBeTruthy();
  expect(agent.terminalSessionId).toBeTruthy();
  return agent;
}

async function sendTurn(
  page: Page,
  prompt: string,
  expected: string,
): Promise<void> {
  const input = page
    .locator(
      'textarea[placeholder="Send instruction to agent..."], input[placeholder="Send instruction to agent..."]',
    )
    .first();
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill(prompt);
  await page.getByLabel("Send Prompt").click();
  await expect(page.getByText(prompt, { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(expected, { exact: true }).last()).toBeVisible({
    timeout: 30_000,
  });
  await expect(input).toHaveValue("", { timeout: 10_000 });
}

test.describe("Web Agent Chat live OMP flow", () => {
  test("keeps one OMP runtime across five Chat turns and a Chat/Terminal switch", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const terminalSockets = new Set<string>();
    page.on("websocket", (socket) => terminalSockets.add(socket.url()));

    await ensurePaired(page);
    expect(ompPids()).toEqual([]);

    const created = await createAgent(page);
    await expect(page.getByLabel("Chat View")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => ompPids(), { timeout: 30_000 }).toHaveLength(1);

    const promptInput = page
      .locator(
        'textarea[placeholder="Send instruction to agent..."], input[placeholder="Send instruction to agent..."]',
      )
      .first();
    await expect(promptInput).toBeVisible({ timeout: 20_000 });
    await promptInput.fill("Reply with exactly the word: E2E_PONG");
    await page.getByLabel("Send Prompt").click();
    await expect(page.getByText("E2E_PONG", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Turn started", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(promptInput).toHaveValue("", { timeout: 10_000 });
    await expect.poll(() => ompPids(), { timeout: 10_000 }).toHaveLength(1);

    await sendTurn(
      page,
      "Execute tool test: E2E_TOOL_TEST",
      "E2E_TOOL_FINAL_OUTPUT",
    );
    await expect(page.getByText("bash", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("E2E_TOOL_RESULT").last()).toBeVisible({
      timeout: 30_000,
    });

    await page.getByLabel("Terminal View").click();
    await expect(page.locator(".xterm").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(
        () =>
          [...terminalSockets].some((url) =>
            url.endsWith(`/v1/ws/sessions/${created.terminalSessionId}`),
          ),
        { timeout: 15_000 },
      )
      .toBeTruthy();
    await page.getByLabel("Chat View").click();
    await expect(promptInput).toBeVisible({ timeout: 10_000 });

    await page.getByLabel("More actions").click();
    const modelButton = page.getByLabel("Model and Thinking");
    if (await modelButton.isVisible().catch(() => false)) {
      await modelButton.click();
      await expect(page.getByText("MODEL", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(
        page.getByText("THINKING LEVEL", { exact: true }),
      ).toBeVisible({ timeout: 10_000 });
      await page.getByLabel("Close Model and Thinking").click();
      await expect(page.getByText("MODEL", { exact: true })).not.toBeVisible({
        timeout: 10_000,
      });
    } else {
      await page.getByLabel("Dismiss menu").click();
    }

    const unicodeCodePrompt =
      'Unicode turn: こんにちは 🌍\n```ts\nconst café = "✅";\n```\n' +
      "x".repeat(256);
    await sendTurn(
      page,
      unicodeCodePrompt,
      `Processed: ${unicodeCodePrompt.slice(0, 50)}`,
    );
    await sendTurn(
      page,
      "Fourth sequential live Agent Chat turn",
      "Processed: Fourth sequential live Agent Chat turn",
    );
    await sendTurn(
      page,
      "Fifth sequential live Agent Chat turn",
      "Processed: Fifth sequential live Agent Chat turn",
    );
    await expect(page.getByText("E2E_PONG", { exact: true })).toHaveCount(1);
    await expect(
      page.getByText("E2E_TOOL_FINAL_OUTPUT", { exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByText(`Processed: ${unicodeCodePrompt.slice(0, 50)}`, {
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(
      page.getByText("Processed: Fourth sequential live Agent Chat turn", {
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(
      page.getByText("Processed: Fifth sequential live Agent Chat turn", {
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(page.getByText("message.system", { exact: true })).toHaveCount(
      0,
    );
    await expect.poll(() => ompPids(), { timeout: 10_000 }).toHaveLength(1);

    const terminateRequest = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/v1/agents/${created.id}/terminate`) &&
        response.status() === 200,
    );
    await page.getByLabel("More actions").click();
    await page.getByLabel("Terminate Agent").click();
    await expect(page.getByLabel("Terminate Agent Confirmation")).toBeVisible();
    await page.getByLabel("Confirm Terminate Agent").click();
    await terminateRequest;
    await expect(page).not.toHaveURL(/\/agent\//, { timeout: 15_000 });
    await expect.poll(() => ompPids(), { timeout: 30_000 }).toEqual([]);
  });
});
