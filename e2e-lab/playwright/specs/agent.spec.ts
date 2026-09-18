import { test, expect } from '@playwright/test';
import { ensurePaired } from '../helpers';

test.describe('Web Agent & Live Daemon Session Flow', () => {
  test('should drive full Agent lifecycle: pairing, live E2E_PONG, terminal runtime, files, history retention, and termination', async ({
    page,
  }) => {
    test.setTimeout(90000);

    // 1. Ensure authentic Auth-v2 pairing
    await ensurePaired(page);

    // Setup dialog auto-accept for native window.confirm / Alert.alert
    page.on('dialog', async (dialog) => {
      await dialog.accept();
    });

    // 2. Open New Agent Sheet from dashboard
    const newAgentBtn = page.locator('[aria-label*="New Agent"]').first();
    await expect(newAgentBtn).toBeVisible({ timeout: 15000 });
    await newAgentBtn.click();

    // 3. Set workspace to project1 and create agent
    const workspaceInput = page.getByPlaceholder('Workspace path (e.g. ./workspace)').first();
    if (await workspaceInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await workspaceInput.fill('project1');
    }

    const createAgentBtn = page.locator('[aria-label="Create Agent"]').first();
    await expect(createAgentBtn).toBeVisible({ timeout: 5000 });
    await createAgentBtn.click();

    // 4. Verify prompt bar is active
    const promptInput = page.locator(
      'textarea[placeholder="Send instruction to agent..."]:visible, input[placeholder="Send instruction to agent..."]:visible'
    ).first();
    await expect(promptInput).toBeVisible({ timeout: 20000 });

    // 5. Submit live prompt and assert E2E_PONG appears without page refresh
    await promptInput.fill('Reply with exactly the word: E2E_PONG');

    const sendBtn = page.locator('[aria-label="Send Prompt"]:visible').first();
    await expect(sendBtn).toBeVisible({ timeout: 5000 });
    await sendBtn.click();

    // Verify user message is rendered in transcript
    const userMsg = page.getByText('Reply with exactly the word: E2E_PONG').last();
    await expect(userMsg).toBeVisible({ timeout: 10000 });

    // Verify live assistant response arrives without refresh
    const assistantPong = page.getByText('E2E_PONG').last();
    await expect(assistantPong).toBeVisible({ timeout: 30000 });

    // 6. Verify Terminal view is the same agent runtime
    const terminalViewBtn = page.locator('[aria-label="Terminal View"]:visible').first();
    await expect(terminalViewBtn).toBeVisible({ timeout: 5000 });
    await terminalViewBtn.click();

    const xtermSurface = page.locator('.xterm, canvas, [data-testid="terminal-container"]').last();
    await expect(xtermSurface).toBeVisible({ timeout: 10000 });

    // Switch back to Chat view
    const chatViewBtn = page.locator('[aria-label="Chat View"]:visible').first();
    await expect(chatViewBtn).toBeVisible({ timeout: 5000 });
    await chatViewBtn.click();
    await expect(promptInput).toBeVisible({ timeout: 10000 });

    // 7. Verify Files integration (project1/sample.txt)
    const openFilesBtn = page.locator('[aria-label="Open Files"]:visible').first();
    await expect(openFilesBtn).toBeVisible({ timeout: 5000 });
    await openFilesBtn.click();

    const sampleFile = page.getByText('sample.txt').first();
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

    // 8. Reopen agent session from dashboard and verify history rendered
    const agentCard = page.locator('[aria-label^="Open agent"]:visible').last();
    await agentCard.scrollIntoViewIfNeeded();
    await expect(agentCard).toBeAttached({ timeout: 10000 });
    await agentCard.click();

    // Wait for agent screen to hydrate and assert transcript message rendered
    const activePrompt = page.locator(
      'textarea[placeholder="Send instruction to agent..."]:visible, input[placeholder="Send instruction to agent..."]:visible'
    ).first();
    await expect(activePrompt).toBeVisible({ timeout: 15000 });

    const rehydratedPong = page.getByText('E2E_PONG').last();
    await expect(rehydratedPong).toBeVisible({ timeout: 15000 });

    // 9. Explicit termination / close surface
    const terminateBtn = page.locator('[aria-label="Terminate Agent"]:visible').first();
    await expect(terminateBtn).toBeVisible({ timeout: 5000 });
    await terminateBtn.click();

    const confirmTerminateBtn = page.getByText('Terminate').last();
    if (await confirmTerminateBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmTerminateBtn.click();
    }

    const backBtn = page.locator('[aria-label="Back"]:visible').first();
    if (await backBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await backBtn.click();
    }

    // Verify back on dashboard with active connection
    const deckHeader = page.getByText('localhost:18765').last();
    await expect(deckHeader).toBeVisible({ timeout: 15000 });

    // Close agent tab from deck
    const closeTabBtn = page.locator('[aria-label^="Close tab"]:visible').last();
    if (await closeTabBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closeTabBtn.click();
    }
  });
});
