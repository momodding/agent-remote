# multi-terminal-window-plan

## Context

Add a multi-session window feature to the agenticRemote client (Expo React Native + web) that lets users open multiple terminal sessions simultaneously in separate panes within one screen.

- **Android**: maximum 2 windows per screen (mobile constraint).
- **Web**: up to 4 windows per screen (larger screens).
- **Controls**:
  - **+** button to open a new session in a new pane.
  - **Minimize** button per pane to collapse it into a compact session strip (session stays alive, output streams, restores when clicked).
  - **Close** button per pane to terminate the remote session and close the WebSocket.
  - **Broadcast Input** toggle: when enabled, keystrokes from any focused pane are sent to all visible (non-minimized) panes.

This is a user-facing new feature in `client/app/terminal/[id].tsx` with supporting components.

## Approach

1. **Update dashboard → session creation** (`client/app/index.tsx`)
   - Add “New multi-session window” button (distinct from single “New shell”).
   - For multi-window, navigate to `/terminal/[id]?mode=multi`.
   - No backend changes needed; multi-window is purely client-side layout.

2. **Create MultiTerminal component** (`client/src/components/MultiTerminal.tsx`)
   - Accepts props: `sessions: MultiSessionState[]`, `onAdd`, `onClose`, `onBroadcastToggle`, `isBroadcasting: boolean`, `platformMax: number`.
   - Layout grid based on platform: 1-2 columns on mobile (Android max 2), 1-4 on web.
   - Per-pane UI:
     - Header: session name, minimize/close buttons, broadcast indicator if broadcasting.
     - Terminal view: render `Terminal` component (WebView/native or web xterm).
     - Status strip below for minimized sessions (collapsed).
   - Broadcast Input toggle in header or sticky toolbar.

3. **Define `MultiSessionState` type** (`client/src/lib/multi-session.ts`)
   - `sessionId`, `name`, `connectionEndpoint`, `output: string`, `minimized: boolean`, `socket?: SessionSocket`.
   - Utility functions: `addSession`, `closeSession`, `toggleMinimize`, `broadcastToggle`.

4. **Update TerminalScreen to support multi-window mode** (`client/app/terminal/[id].tsx`)
   - When `mode=multi`, render `MultiTerminal` instead of single `Terminal`.
   - On first load (single-window legacy path without `mode=multi`), show existing single-pane behavior (backward compatible).
   - Add “+ Add Session” floating action button (FAB) for adding new sessions.

5. **Session FAB** (`client/src/components/AddSessionFAB.tsx`)
   - Pressing FAB opens the existing “New session” sheet or modal (reuse `PairingSheet`/`ConnectionSheet` pattern, or create `CreateSessionSheet`).
   - User selects daemon connection, enters name/command. On create, `onAdd(session)` callback updates `MultiSessionState`.

6. **Minimize behavior** (`client/src/lib/multi-session.ts`)
   - When minimized, socket stays connected and output is still received (scrollback accumulates).
   - Session strip shows collapsed name + status badge and scrollback preview (first N chars).
   - Click on strip restores pane to grid.

7. **Close behavior** (`client/src/lib/multi-session.ts`)
   - On pane close, call `api.closeSession(sessionId)`, call `socket.close()`, remove state entry.
   - Broadcast continues to other active panes.

8. **Broadcast Input** (`client/src/lib/multi-session.ts`)
   - When `isBroadcasting` is true, `onInput` from any pane is forwarded to all non-minimized panes.
   - Each pane's socket input() method is called.
   - Visual indicator in pane header when broadcasting (e.g., “ Broadcasting” badge).

9. **Platform max enforcement**
   - On Android: `max = 2`; on web: `max = 4`.
   - When `Object.values(sessions).length >= max`, FAB is disabled.

10. **Tests**
    - `client/src/components/MultiTerminal.test.tsx`: layout, minimize, close, broadcast behavior.
    - Update `client/src/terminal-route.test.tsx` to cover multi-window mode render path.
    - `client/src/lib/multi-session.test.ts`: state helpers.

11. **Style consistency**
    - Match existing theme (`#0A0A0A` bg, `#181818` headers, `#46B8C4` accents).
    - Reuse `ShortcutKeyboard` per-pane (already installed).
    - Grid gaps: 12px, padding 10px.

## Critical files & anchors

- `client/app/index.tsx:136` — Add “New multi-session window” button beside “New shell”.
- `client/app/index.tsx:123` — Change `router.push` params for multi-session (`{ id: session.id, name: session.name, connectionEndpoint, mode: 'multi' }`).
- `client/app/terminal/[id].tsx:11-20` — Read `mode` from `useLocalSearchParams` and route to `MultiTerminal`.
- `client/src/components/MultiTerminal.tsx` — New component; render grid of panes with minimize/close/broadcast.
- `client/src/lib/multi-session.ts` — New module; `MultiSessionState`, `addSession`, `closeSession`, `toggleMinimize`, `broadcastToggle`, `getPlatformMax`.
- `client/src/components/AddSessionFAB.tsx` — New FAB component with existing session creation modal.

## Verification

1. **Build/typecheck**: `cd client && npm run typecheck` — no errors in `MultiTerminal.tsx`/`multi-session.ts`.
2. **Tests**: `cd client && npm test` — new tests pass, existing `terminal-route.test.tsx` still passes for legacy single-window mode.
3. **Manual smoke**:
   - Open dashboard → “New multi-session window” → 1 pane appears with new shell.
   - Click FAB → create 2nd session → grid shows 2 panes.
   - On Android device: add button disabled when 2 panes present.
   - On web: add 3rd and 4th panes, add button disabled at 4.
   - Press minimize on one pane → strip appears at bottom (or top), grid shrinks.
   - Click strip → pane restores to grid.
   - Enable Broadcast Input → type in one pane → all visible panes receive input.
   - Press Close on one pane → session terminates, pane removed, others unaffected.
   - Detach → returns to dashboard, sessions remain live (no REST close).

## Assumptions & contingencies

- **Backend**: No changes needed. Close kills PTY and broadcasts `session.state: exited` to all subscribers; we rely on existing session manager behavior.
- **Platform**: Android max = 2, Web max = 4 (hardcoded constants in `getPlatformMax`).
- **Session creation modal**: Reuse `PairingSheet` pattern (modal with `presentationStyle="pageSheet"`) for creating new sessions in multi-window mode.
- **Backward compatibility**: Single-window sessions (`mode` absent or `mode=single`) continue to render the legacy `Terminal` component.
- **If session broadcast fails**: If a socket is closed between broadcast iteration, skip it (no error bubble); session strip still shows scrollback.

## Skip/defer

- **Per-pane scrollback sync**: We don’t sync scroll position across panes (would require WebSocket resize/frame ordering guarantees and more complex state).
- **Drag-to-reorder**: Layout is static (first-added left/top).
- **Session name editing**: After creation, name is fixed (reuse `SessionSummary.name`).
- **Per-pane theme/customization**: Single theme for all panes (existing `#0A0A0A`).
- **Session grouping/folders**: Future enhancement, not in this scope.
