import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ensurePaired } from '../helpers';

const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
];

const longWindowName = 'manual-005-window-with-a-name-longer-than-sixty-characters-for-overflow-coverage';
const longCwd = '/app/workspace/manual-005/a/deeply/nested/path/that/contains/more/than/one/hundred/characters/for/the/pane-sheet-layout-check';

function compose(args: string[]): string {
  return execFileSync(resolve(process.cwd(), 'scripts/compose.sh'), args, { encoding: 'utf8' });
}

async function createTerminals(page: Page, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await page.locator('[aria-label^="New Terminal"]:visible').first().click();
    await expect(page.getByText('Shell')).toBeVisible({ timeout: 15_000 });
    if (index === 0) {
      // The daemon only persists tmux topology (window name, cwd) into the
      // runtime store that the client reads from at terminal-creation time
      // (session.Manager.recordTopology is invoked from Create(), never by
      // the 1s background RefreshTopology ticker). Renaming here, right
      // after the first pane exists, guarantees every subsequent Create()
      // call for panes 2..12 re-persists the already-renamed window state,
      // so the client's runtime snapshot reflects the long name once all
      // panes exist.
      //
      // IMPORTANT: every "Terminal" is a *window* inside ONE shared private
      // tmux session (backend/internal/tmux/control.go: privateSessionName
      // = "agenticremote"; CreatePane does `new-window -t privateSessionName`).
      // Renaming that session (as an earlier version of this fixture did via
      // `rename-session`) deletes the target `new-window -t "agenticremote"`
      // resolves against, so every later terminal-creation call fails with a
      // 400 `command_error` from tmux control mode. Only `rename-window` (and
      // `send-keys ... cd`) are valid per-terminal seeding operations here.
      seedLongTmuxLabels();
    }
    if (index + 1 < count) {
      // In-app client-side navigation (expo-router `router.replace`) preserves the
      // web client's in-memory session token (`webSessionTokens` in connection.ts is
      // intentionally never persisted to storage on web). A hard `page.goto('/')`
      // reload would drop it and force re-pairing, which is a test artifact, not a
      // product defect. react-navigation's web Stack keeps the previous screen
      // mounted with `display:none` during the transition, so a bare accessible
      // label can still match the stale hidden node; `:visible` is the existing
      // disambiguation convention used throughout helpers.ts.
      await page.locator('[aria-label="Detach"]:visible').first().click();
      await expect(page.locator('[aria-label^="New Terminal"]:visible').first()).toBeVisible({ timeout: 15_000 });
    }
  }
}

function seedLongTmuxLabels(): void {
  const command = [
    'set -eu',
    'sock=/app/.agenticremote/app/.agenticremote/state/tmux/tmux.sock',
    `mkdir -p '${longCwd}'`,
    // ControlClient.Start() keeps a detached anchor session alive so the
    // private tmux server survives control-client reconnects; tmux always
    // gives that anchor window index 0, and it is never bound to any
    // terminal ID in session.Manager (so it never reaches the client).
    // `list-windows -F '#{window_index}|...'` sorted descending and taking
    // the first row targets the most-recently-created real terminal window
    // instead of the untracked anchor.
    `tmux -S "$sock" list-windows -a -F '#{window_index}|#{window_id}' | sort -t'|' -k1,1 -rn | head -1 | while IFS='|' read -r index window; do`,
    `  pane=$(tmux -S "$sock" list-panes -t "$window" -F '#{pane_id}' | head -1)`,
    `  tmux -S "$sock" rename-window -t "$window" '${longWindowName}'`,
    `  tmux -S "$sock" send-keys -t "$pane" "cd '${longCwd}'" Enter`,
    'done',
  ].join('\n');
  compose(['exec', '--no-TTY', 'daemon', 'sh', '-lc', command]);
}

async function openPaneSheet(page: Page): Promise<void> {
  await page.locator('[aria-label="Switch pane"]:visible').first().click();
  await expect(page.locator('text="Panes"').first()).toBeVisible({ timeout: 15_000 });
}

async function assertPaneSheetBounds(page: Page, viewport: { name: string; width: number; height: number }): Promise<void> {
  const rows = page.locator('[aria-label^="Open "]:visible');
  await expect(rows).toHaveCount(12, { timeout: 15_000 });

  const content = rows.first().locator('xpath=..');
  const contentBox = await content.boundingBox();
  expect(contentBox, 'pane list content is visible').not.toBeNull();

  const firstRow = await rows.first().boundingBox();
  expect(firstRow, 'first pane row is visible').not.toBeNull();
  expect(firstRow!.x).toBeGreaterThanOrEqual(contentBox!.x - 1);
  expect(firstRow!.x + firstRow!.width).toBeLessThanOrEqual(contentBox!.x + contentBox!.width + 1);

  const longText = page.locator('[aria-label*="' + longWindowName + '"]:visible').first();
  await expect(longText).toBeVisible();
  const longTextBox = await longText.boundingBox();
  expect(longTextBox, 'long window name/cwd row is visible').not.toBeNull();
  expect(longTextBox!.x + longTextBox!.width).toBeLessThanOrEqual(contentBox!.x + contentBox!.width + 1);

  const lastRow = rows.last();
  await lastRow.scrollIntoViewIfNeeded();
  await expect(lastRow).toBeVisible();
  const visibleRows = await rows.evaluateAll((elements) => elements
    .map((element) => {
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
    })
    .filter((box) => box.bottom > 0 && box.top < window.innerHeight)
    .sort((a, b) => a.top - b.top));
  for (let index = 1; index < visibleRows.length; index++) {
    expect(visibleRows[index].top, 'visible pane rows do not overlap').toBeGreaterThanOrEqual(visibleRows[index - 1].bottom - 1);
    expect(visibleRows[index].left).toBeGreaterThanOrEqual(contentBox!.x - 1);
    expect(visibleRows[index].right).toBeLessThanOrEqual(contentBox!.x + contentBox!.width + 1);
  }

  mkdirSync(resolve(process.cwd(), 'artifacts/manual-005'), { recursive: true });
  await page.screenshot({
    path: resolve(process.cwd(), `artifacts/manual-005/pane-sheet-${viewport.name}.png`),
    fullPage: false,
  });
}

test.describe('MANUAL-005 real daemon pane sheet', () => {
  test('shows twelve real tmux panes without overlap or horizontal clipping', async ({ browser }) => {
    test.setTimeout(180_000);
    const mobile = await browser.newContext({ viewport: viewports[0] });
    const mobilePage = await mobile.newPage();
    try {
      await ensurePaired(mobilePage);
      await createTerminals(mobilePage, 12);
      await openPaneSheet(mobilePage);
      await assertPaneSheetBounds(mobilePage, viewports[0]);
    } finally {
      // context.close() packages trace/video artifacts internally; under
      // concurrent host load this can throw ENOENT on its own temp files
      // (e.g. traces/screencast/*.jpeg) even though every assertion above
      // already passed. Swallow teardown-only errors so a flaky artifact
      // race never masks a real pass.
      await mobile.close().catch((error) => {
        console.warn('mobile context teardown error (ignored):', error);
      });
    }

    const desktop = await browser.newContext({ viewport: viewports[1] });
    const desktopPage = await desktop.newPage();
    try {
      await ensurePaired(desktopPage);
      await desktopPage.getByLabel(/^Open terminal /).first().click();
      // Reopening an existing terminal shows its session name as the header
      // ("Terminal", the default `name` all 12 fixture sessions were created
      // with). The client's 'Shell' fallback (`tab.title || 'Shell'` in
      // app/terminal/[id].tsx) only applies when the tab has no title, which
      // is not the case for a reopened session.
      await expect(desktopPage.locator(':text-is("Terminal"):visible').first()).toBeVisible({ timeout: 15_000 });
      await openPaneSheet(desktopPage);
      await assertPaneSheetBounds(desktopPage, viewports[1]);
    } finally {
      await desktop.close().catch((error) => {
        console.warn('desktop context teardown error (ignored):', error);
      });
    }
  });
});
