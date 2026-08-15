<!-- source-branch:  -->
# Fix: noVNC crash, terminal selection, macOS shell default

## Bug 1 — noVNC `window.RFB is not a constructor` (Android)

**Root cause**: `client/app/desktop.tsx:19` loads the noVNC bundle via
`<script src="data:text/javascript;base64,${noVNCBase64}"></script>`. Bundle
itself is fine (IIFE, sets `globalThis.RFB`). Android WebView's Chromium
subresource loader silently drops/blocks `data:` URLs used as `<script src>`
(confirmed via web search: `ERR_UNKNOWN_URL_SCHEME`/CSP class of failures,
known WebView vs desktop-Chrome divergence for non-HTTP script src). Script
never runs → `window.RFB` stays undefined.

**Fix**: stop using `src="data:...;base64,..."`. Decode and inline the JS
text directly inside a `<script>` body.

- `client/scripts/build-novnc.ts`: keep emitting the bundle text (already
  IIFE). No base64 needed anymore — export the raw JS string instead of a
  base64 string (drop the `Buffer.from(...).toString('base64')` step).
- `client/app/desktop.tsx`: change
  `<script src="data:text/javascript;base64,${noVNCBase64}"></script>`
  → `<script>${noVNCBase64}</script>` (rename import/var to `noVNCScript`
  since it's no longer base64).
- No backend change. No new dependency (rung 3: stdlib string, no encoding).

## Bug 2 — No text selection in terminal (Android)

**Root cause**: xterm.js selection (`SelectionService`) is built on
`mousedown`→`mousemove`→`mouseup`. Mobile WebViews do not synthesize
`mousemove` from `touchmove`, only a tap becomes a synthetic
click/mousedown/mouseup pair. So drag-to-select never fires on touch — this
is a known xterm.js gap (upstream issue: mobile touch selection
unsupported), not a bug introduced by this app. `onSelectionChange` +
`getSelection()` + the existing Copy/Select-All toolbar buttons in
`ShortcutKeyboard.tsx` (`client/app/terminal/[id].tsx:299`) already work
once a selection exists — the missing piece is *making* a selection with a
touch drag.

**Fix**: add a small touch-drag-to-select layer in the init script appended
to `terminal_html.ts`, using xterm's public `terminal.select(col, row, len)`
API (rung 7 — no addon, no dependency: xterm ships this natively for
programmatic selection, only the touch→cell math is new code).

- Bind `touchstart`/`touchmove`/`touchend` on `terminal.element` (the
  `.xterm` container), long-press-free (single-finger drag begins
  selection immediately — matches the existing "no separate selection
  mode" UX and is closest to zero new UI).
- Convert touch point → col/row using `terminal.element`'s bounding rect
  and `terminal._core._renderService.dimensions` cell size (or simpler:
  reuse `fit.proposeDimensions()`'s cell math already loaded via
  `FitAddon`) — actually simplest: derive cell size from
  `terminal.element.querySelector('.xterm-rows')` rect / `terminal.cols`
  and `terminal.rows`, same technique as the FitAddon already bundled.
- On `touchmove`, call `terminal.select(startCol, startRow, length)` where
  length spans start↔current position on the same/adjacent rows; call
  `event.preventDefault()` only while a selection drag is active, so normal
  scroll/tap-to-focus is untouched otherwise.
- CSS: add `touch-action: pan-y` (not `none` — keep vertical scroll) is
  wrong for a drag-to-select gesture that needs to beat scroll; use
  `touch-action: none` on `#terminal` while selecting is simplest and
  matches other terminal apps (scrolling still available via output
  growing / keyboard). Keep it minimal: `touch-action:none` added once,
  permanently, to `.xterm-screen` — the existing scrollback view already
  scrolls by content, not by native touch pan of that layer in most usage;
  verify no regression in smoke test.
- Existing `onSelectionChange` → `copy` postMessage path is untouched and
  already correct.
- No new npm package. `ponytail:` comment noting the ceiling (single-finger
  linear top-to-bottom selection only, no word/line granularity, no
  selection handles) with upgrade path noted (`xterm.js` issue #5377 if/when
  upstream ships real mobile touch support).

## Bug 3 — macOS sessions default to bash, not zsh

**Root cause**: backend `defaultShell()` in
`backend/internal/session/manager.go:466` is correct (checks `$SHELL` →
`/etc/passwd` → falls back `/bin/sh`) and only runs when
`Create()` receives `command == ""`. Client never sends `""` — it hardcodes
`'bash'` in three call sites, overriding the backend default outright:

- `client/app/index.tsx:127` (`create()`)
- `client/app/index.tsx:136` (`createMulti()`)
- `client/src/components/AddSessionFAB.tsx:23,42` (initial state +
  post-create reset)

**Fix**: send `command: ''` from all three call sites instead of `'bash'`,
so the backend's existing `defaultShell()` decides (zsh on macOS via
`$SHELL`, matching SSH login shell behavior). One-line changes, no new
code, no backend change (rung 2: codebase already has the right behavior,
client just needs to stop overriding it).

- Update `client/src/dashboard-route.test.tsx:75` mock session factory
  (`command: 'bash'` → `command: ''`) — it's a fixture describing what the
  daemon *returns*, so use the same empty-string convention for
  consistency; check nothing in that test asserts on the literal `'bash'`
  string first (`grep` shows only the fixture line, no assertions on the
  value) — adjust only if an assertion depends on it.
- `AddSessionFAB`'s user-facing shell picker (populated by
  `api.shells()`) is unaffected — it already lets a user pick a shell
  explicitly; only the *default* (empty selection) should stop forcing
  bash.

## Verification plan

1. `make client-test` (typecheck + Jest) after all 3 fixes.
2. noVNC: rebuild bundle (`bun run scripts/build-novnc.ts`), inline-render
   the generated HTML in a plain browser tab and assert
   `typeof window.RFB === 'function'` (can't reproduce Android WebView's
   `data:` src rejection on desktop Chromium — the fix removes the
   `data:`-as-script-src pattern entirely regardless of platform, so a
   passing desktop smoke test plus the code-level rationale is the
   available proof; flag to the user that true Android confirmation needs
   a device/emulator run).
3. Terminal selection: Jest/unit test is a poor fit for touch gesture math;
   add one small deterministic unit test of the col/row-from-touch helper
   (pure function extraction) and note real drag confirmation needs manual
   Android testing (browser tool can't emulate WebView touch semantics on
   this Linux desktop).
4. Shell default: extend existing backend test coverage for
   `defaultShell()`/`Create()` if not already asserting the
   empty-command path (`make backend-test`); confirm client tests still
   pass with `command: ''`.

## Files touched

- `client/scripts/build-novnc.ts`
- `client/app/desktop.tsx`
- `client/src/components/terminal_html.ts` (init script + CSS)
- `client/app/index.tsx`
- `client/src/components/AddSessionFAB.tsx`
- `client/src/dashboard-route.test.tsx`
- (backend: none — `manager.go` already correct)
