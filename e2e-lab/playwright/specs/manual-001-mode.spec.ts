import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { ensurePaired } from "../helpers";

function ompPids(): string[] {
  const compose = `${process.cwd()}/scripts/compose.sh`;
  const command =
    'for p in /proc/[0-9]*; do read comm < "$p/comm" 2>/dev/null || continue; [ "$comm" = omp ] && printf "%s\\n" "${p##*/}"; done; true';
  return execFileSync(compose, ["exec", "--no-TTY", "daemon", "sh", "-lc", command], {
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function ompVersion(): string {
  return execFileSync(`${process.cwd()}/scripts/compose.sh`, ["exec", "--no-TTY", "daemon", "sh", "-lc", "omp --version"], {
    encoding: "utf8",
  }).trim();
}

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

async function sendTerminalCommand(page: Page, command: string): Promise<void> {
  const input = page.locator(".xterm-helper-textarea").first();
  await expect(input).toBeAttached({ timeout: 20_000 });
  await input.evaluate((element) => (element as HTMLTextAreaElement).focus());
  await input.pressSequentially(command);
  await input.press("Enter");
}

function modeResponse(page: Page, action: "plan_toggle" | "goal_show") {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/mode") &&
      response.status() === 200 &&
      response.request().postDataJSON().action === action,
  );
}

test.describe("MANUAL-001 real OMP mode parity", () => {
  test("keeps one OMP PID while terminal and browser Plan/Goal controls share persisted mode", async ({ page }) => {
    test.setTimeout(240_000);
    test.skip(!process.env.E2E_REAL_PAIRING_ENDPOINT, "requires the test-only direct bridge pairing endpoint");
    expect(ompVersion()).toBe("omp/18.6.1");
    let terminalInput = "";
    let terminalOutput = "";
    let terminalConnected = false;
    page.on("websocket", (socket) => {
      if (!socket.url().includes("/v1/ws/sessions/")) return;
      terminalConnected = true;
      socket.on("framesent", ({ payload }) => {
        try {
          const frame = JSON.parse(payload.toString());
          if (frame.type === "pty.input" && typeof frame.data === "string") {
            terminalInput += Buffer.from(frame.data, "base64").toString("utf8");
          }
        } catch {
          // Ignore non-terminal socket frames.
        }
      });
      socket.on("framereceived", ({ payload }) => {
        try {
          const frame = JSON.parse(payload.toString());
          if ((frame.type === "pty.baseline" || frame.type === "pty.output") && typeof frame.data === "string") {
            terminalOutput += Buffer.from(frame.data, "base64").toString("utf8");
          }
        } catch {
          // Ignore non-terminal socket frames.
        }
      });
    });

    await ensurePaired(page);
    const baselinePIDs = ompPids();
    const created = await createAgent(page);
    await expect(page.getByLabel("Chat View")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => ompPids(), { timeout: 30_000 }).toHaveLength(baselinePIDs.length + 1);
    const ompPID = ompPids().find((pid) => !baselinePIDs.includes(pid));
    expect(ompPID).toBeTruthy();

    // OMP 18.6.1 keeps a fresh session unmaterialized until an assistant message
    // is appended, which is a precondition for persisted mode_change entries.
    const promptInput = page.locator('textarea[placeholder="Send instruction to agent..."], input[placeholder="Send instruction to agent..."]').first();
    await expect(promptInput).toBeVisible({ timeout: 20_000 });
    await promptInput.fill("E2E_PING");
    await page.getByLabel("Send Prompt").click();
    await expect(page.getByText("E2E_PONG", { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Terminal View").click();
    await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => terminalConnected, { timeout: 20_000 }).toBeTruthy();
    await expect.poll(() => terminalOutput.length, { timeout: 20_000 }).toBeGreaterThan(0);
    await sendTerminalCommand(page, "/plan");
    await expect.poll(() => terminalInput.includes("/plan")).toBeTruthy();
    await expect.poll(() => terminalOutput.includes("/plan"), { timeout: 30_000 }).toBeTruthy();
    await page.setViewportSize({ width: 360, height: 800 });
    await expect(page.getByLabel("Agent Mode")).toHaveText("Plan", { timeout: 30_000 });
    expect(ompPids()).toContain(ompPID);

    mkdirSync(resolve(process.cwd(), "artifacts"), { recursive: true });
    await page.screenshot({ path: resolve(process.cwd(), "artifacts/manual-001-terminal-plan.png"), fullPage: true });

    // A reload clears browser-only connection state (the web auth token lives only
    // in an in-memory Map). Re-pair, then re-enter the agent the way a real user
    // would: through the dashboard's existing session tile, not a raw URL jump,
    // so the mode must be reconstructed from persisted server state.
    await page.reload({ waitUntil: "domcontentloaded" });
    await ensurePaired(page);
    await page.getByLabel(/^Open agent /).first().click();
    await expect(page.getByLabel("Agent Mode")).toHaveText("Plan", { timeout: 30_000 });
    expect(ompPids()).toContain(ompPID);

    // Browser-initiated plan_toggle is the real 2nd /plan toggle overall
    // (OMP's /plan cycle is active -> paused -> disabled); it must route
    // through the same terminal process that persisted across the reload
    // above, pausing the plan it just reconstructed from server state.
    await page.getByLabel("Agent Mode").click();
    await expect(page.getByText("Select Mode", { exact: true })).toBeVisible();
    const planResponse = modeResponse(page, "plan_toggle");
    await page.getByLabel("Mode Plan").click();
    await planResponse;
    await expect(page.getByLabel("Agent Mode")).toHaveText("Plan", { timeout: 30_000 });
    expect(ompPids()).toContain(ompPID);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByLabel("Terminal View").click();
    await expect(page.locator(".xterm").first()).toContainText("Plan mode paused.", { timeout: 15_000 });
    await page.setViewportSize({ width: 360, height: 800 });

    // The same browser plan_toggle control drives the real 3rd /plan toggle
    // (paused -> disabled per OMP's own "No-arg third toggle: paused -> off"
    // handling), fully exiting plan mode so the subsequent Goal segment below
    // is valid per OMP's plan/goal mutual-exclusivity rules.
    await page.getByLabel("Agent Mode").click();
    await expect(page.getByText("Select Mode", { exact: true })).toBeVisible();
    const planDisableResponse = modeResponse(page, "plan_toggle");
    await page.getByLabel("Mode Plan").click();
    await planDisableResponse;
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByLabel("Terminal View").click();
    await expect(page.locator(".xterm").first()).toContainText("Plan mode disabled.", { timeout: 15_000 });
    await page.setViewportSize({ width: 360, height: 800 });
    expect(ompPids()).toContain(ompPID);

    // Goal is display-only state, but its browser control must still reach the same TUI.
    await page.getByLabel("Agent Mode").click();
    const goalResponse = modeResponse(page, "goal_show");
    await page.getByLabel("Mode Goal").click();
    await goalResponse;
    await expect(page.locator(".xterm").first()).toContainText("No goal set.", { timeout: 15_000 });
    expect(ompPids()).toContain(ompPID);

    await page.screenshot({ path: resolve(process.cwd(), "artifacts/manual-001-browser-controls.png"), fullPage: true });

    const terminate = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/v1/agents/${created.id}/terminate`) &&
        response.status() === 200,
    );
    await page.getByLabel("More actions").click();
    await page.getByLabel("Terminate Agent", { exact: true }).click();
    await page.getByLabel("Confirm Terminate Agent").click();
    await terminate;
    await expect.poll(() => ompPids(), { timeout: 30_000 }).toEqual(baselinePIDs);
  });
});
