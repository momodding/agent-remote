import { test, expect } from '@playwright/test';
import { ensurePaired } from '../helpers';

test.describe('Web Agent & Live Daemon Session Flow', () => {
  test('should drive full Agent lifecycle: pairing, live E2E_PONG, live E2E_TOOL_TEST, terminal runtime, files, history retention, and termination', async ({
    page,
  }) => {
    test.setTimeout(120000);

    // Polyfill Alert.alert in React Native Web for non-interactive browser testing
    await page.addInitScript(() => {
      let _d: unknown;
      Object.defineProperty(window, '__d', {
        configurable: true,
        get() {
          return _d;
        },
        set(origD: (factory: unknown, moduleId: unknown, dependencyMap: unknown) => unknown) {
          _d = function (factory: (...args: unknown[]) => void, moduleId: unknown, dependencyMap: unknown) {
            const wrapped = function (g: unknown, r: unknown, i: unknown, a: unknown, m: { exports?: { default?: { alert?: unknown }; alert?: unknown } }, e: unknown, d: unknown) {
              factory(g, r, i, a, m, e, d);
              if (m && m.exports) {
                const exp = m.exports.default || m.exports;
                if (exp && typeof exp.alert === 'function') {
                  exp.alert = function (_title: string, _msg?: string, buttons?: Array<{ text: string; onPress?: () => void; style?: string }>) {
                    const term = buttons?.find((b) => b.text === 'Terminate' || b.style === 'destructive');
                    if (term?.onPress) {
                      term.onPress();
                      return;
                    }
                    const first = buttons?.[0];
                    if (first?.onPress) {
                      first.onPress();
                    }
                  };
                }
              }
            };
            return origD(wrapped, moduleId, dependencyMap);
          };
        },
      });
    });

    page.on('console', (msg) => console.log(`[PAGE ${msg.type()}] ${msg.text()}`));

    // 1. Ensure authentic Auth-v2 pairing
    await ensurePaired(page);

    const initialAgentCardsCount = await page.locator('[aria-label^="Open agent"]:visible').count();
    const newAgentBtn = page.locator('[aria-label^="New Agent"]:visible').first();
    await expect(newAgentBtn).toBeVisible({ timeout: 15000 });
    await newAgentBtn.click();
    // 3. Set workspace to project1 and create agent
    const workspaceInput = page.getByLabel('Workspace Path');
    await expect(workspaceInput).toBeVisible({ timeout: 10000 });
    await workspaceInput.fill('project1');

    const createAgentBtn = page.locator('[aria-label="Create Agent"]').first();
    await expect(createAgentBtn).toBeVisible({ timeout: 5000 });
    await createAgentBtn.click();

    // 4. Verify prompt bar is active
    const promptInput = page.locator(
      'textarea[placeholder="Send instruction to agent..."]:visible, input[placeholder="Send instruction to agent..."]:visible'
    ).first();
    await expect(promptInput).toBeVisible({ timeout: 20000 });

    // 5. Submit live prompt 1 and assert E2E_PONG appears without page refresh
    await promptInput.fill('Reply with exactly the word: E2E_PONG');
    const sendBtn = page.locator('[aria-label="Send Prompt"]:visible').first();
    await expect(sendBtn).toBeVisible({ timeout: 5000 });
    await expect(sendBtn).toBeEnabled({ timeout: 10000 });
    await sendBtn.click();

    // Verify user message is rendered in transcript
    const userMsg1 = page.getByText('Reply with exactly the word: E2E_PONG').last();
    await expect(userMsg1).toBeVisible({ timeout: 10000 });

    // Verify live assistant response arrives without refresh
    const assistantPong = page.getByText('E2E_PONG').last();
    await expect(assistantPong).toBeVisible({ timeout: 30000 });

    // Wait for prompt bar to settle and clear from turn 1
    await expect(promptInput).toHaveValue('', { timeout: 10000 });

    // 6. Submit live prompt 2 (E2E_TOOL_TEST) and prove tool.call, tool.result, final output
    await promptInput.fill('Execute tool test: E2E_TOOL_TEST');
    await expect(promptInput).toHaveValue('Execute tool test: E2E_TOOL_TEST');
    await expect(sendBtn).toBeVisible({ timeout: 5000 });
    await expect(sendBtn).toBeEnabled({ timeout: 20000 });
    await sendBtn.click();
    // Verify tool.call event rendered in transcript
    const toolCallName = page.getByText('bash').first();
    await expect(toolCallName).toBeVisible({ timeout: 25000 });
    const toolCallInput = page.getByText('echo E2E_TOOL_RESULT').first();
    await expect(toolCallInput).toBeVisible({ timeout: 25000 });

    // Verify tool.result event rendered in transcript
    const toolResultOutput = page.getByText('E2E_TOOL_RESULT').first();
    await expect(toolResultOutput).toBeVisible({ timeout: 25000 });

    // Verify final assistant output arrives without refresh
    const toolFinalOutput = page.getByText('E2E_TOOL_FINAL_OUTPUT').first();
    await expect(toolFinalOutput).toBeVisible({ timeout: 25000 });

    await expect(page.getByText('E2E_PONG', { exact: true }).and(page.locator(':visible'))).toHaveCount(1);
    await expect(page.getByText('E2E_TOOL_FINAL_OUTPUT', { exact: true }).and(page.locator(':visible'))).toHaveCount(1);
    const terminalViewBtn = page.locator('[aria-label="Terminal View"]:visible').first();
    await expect(terminalViewBtn).toBeVisible({ timeout: 5000 });
    await terminalViewBtn.click();

    // Assert active tab URL matches the agent tab route
    const currentUrl = page.url();
    expect(currentUrl).toContain('/agent/');
    const tabId = currentUrl.split('/agent/')[1].split('?')[0];
    expect(tabId).toBeTruthy();

    const xtermSurface = page.locator('.xterm, canvas, [data-testid="terminal-container"]').last();
    await expect(xtermSurface).toBeVisible({ timeout: 10000 });

    // 8. Close agent view to return cleanly to dashboard
    const closeViewBtn = page.locator('[aria-label="Close View"]:visible').first();
    await expect(closeViewBtn).toBeVisible({ timeout: 5000 });
    await closeViewBtn.click();

    // 9. Verify Files integration from dashboard (project1/sample.txt)
    const newFilesBtn = page.locator('[aria-label^="New Files"]:visible').first();
    await expect(newFilesBtn).toBeVisible({ timeout: 10000 });
    await newFilesBtn.click();

    const project1Folder = page.locator('[aria-label="Open folder project1"]:visible').first();
    await expect(project1Folder).toBeVisible({ timeout: 15000 });
    await project1Folder.click();

    const sampleFile = page.locator('[aria-label="Open file sample.txt"]:visible').first();
    await expect(sampleFile).toBeVisible({ timeout: 15000 });
    await sampleFile.click();

    const sampleContent = page.getByText('Hello from sample.txt in project1').first();
    await expect(sampleContent).toBeVisible({ timeout: 10000 });

    // Close file editor
    const backToFilesBtn = page.locator('[aria-label="Back to files"]:visible').first();
    await expect(backToFilesBtn).toBeVisible({ timeout: 5000 });
    await backToFilesBtn.click();

    // Close file manager and return to dashboard
    const closeFilesBtn = page.locator('[aria-label="Close file manager"]:visible').first();
    await expect(closeFilesBtn).toBeVisible({ timeout: 5000 });
    await closeFilesBtn.click();

    // 10. Reopen agent session from dashboard and verify history retention
    const agentCard = page.locator('[aria-label^="Open agent"]:visible').last();
    await agentCard.scrollIntoViewIfNeeded();
    await expect(agentCard).toBeAttached({ timeout: 10000 });
    await agentCard.click();

    // Verify session view is loaded
    const terminateBtn = page.locator('[aria-label="Terminate Agent"]:visible').first();
    await expect(terminateBtn).toBeVisible({ timeout: 15000 });

    // Assert rehydrated history: count of each message is exactly 1 on the active screen
    await expect(page.getByText('E2E_PONG', { exact: true }).and(page.locator(':visible'))).toHaveCount(1, { timeout: 15000 });
    await expect(page.getByText('E2E_TOOL_FINAL_OUTPUT', { exact: true }).and(page.locator(':visible'))).toHaveCount(1, { timeout: 15000 });
    // 11. Explicit termination removes surface from dashboard/runtime
    await terminateBtn.click();
    // Verify redirected to dashboard and connection card is active
    const deckHeader = page.getByText('localhost:18765').last();
    await expect(deckHeader).toBeVisible({ timeout: 15000 });

    // Assert remote agent surface disappears from dashboard
    const remainingAgentCards = page.locator('[aria-label^="Open agent"]:visible');
    await expect(remainingAgentCards).toHaveCount(initialAgentCardsCount, { timeout: 10000 });
  });
});
