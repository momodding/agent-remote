<!-- source-branch: main -->
<!-- work-branch: omp/multi-session-ui-fixes -->

## Context

Four bugs in the multi-session terminal view (`client/src/components/MultiTerminal.tsx`, `client/app/terminal/[id].tsx`, `client/src/components/AddSessionFAB.tsx`):

1. **Portrait/landscape**: Panes always split left/right (`flexDirection: 'row'` hard-coded at line 218 `styles.terminalRegion`). On a portrait phone they should stack top/bottom; on landscape, left/right.
2. **Drag guideline timing**: Drop-zone overlay appears immediately on drag start (`dragging` set in `onBegin` at line 72). Should wait until the drag position reaches the center of the terminal region before showing drop zones.
3. **Session not found**: When a session WebSocket receives an error frame with `code: "session_not_found"`, the app only shows an Alert and does nothing else. Should auto-close the invalid session and return to the dashboard.
4. **Text overlap in AddSessionFAB sheet**: The `GlassBottomSheet` title "New Session" (from `GlassBottomSheet.tsx` header at line 60-62) and the sheet content's "Name" label sit in adjacent but non-overlapping positions by design. However, the `GlassBottomSheet`'s `present()` call is broken (same root cause as the `ConnectionSheet` fix in `plans/daemon-management-buttons.md`). The user reports overlapping text on "bottom sheet multiple session" — this is the tab bar in `MultiTerminal.tsx` where session names (`tabName` text at line 123, `maxWidth: 180` on tab, `numberOfLines: 1`) can visually collide with the close "x" button (`tabClose` at line 125) when the name is long, because `tabSelect` has `flex: 1` but no `overflow: 'hidden'` and the tab row lacks `overflow: 'hidden'` on the parent.

## Approach

### 1. Orientation-responsive pane layout

**File:** `client/src/components/MultiTerminal.tsx`

Add `useWindowDimensions` import from `react-native` (already used in `client/app/index.tsx:2` as the codebase pattern). In `MultiTerminal` component body (line 131), extract `{ width, height }` from `useWindowDimensions()`. Derive `const isPortrait = height > width;`.

Change `styles.terminalRegion` (line 218, currently hard-coded `flexDirection: 'row'`) to a base style without `flexDirection`. Apply `flexDirection` dynamically in the JSX at line 180:
```tsx
<View ref={terminalRegionRef} onLayout={measureTerminalRegion} testID="terminal-region"
  style={[styles.terminalRegion, { flexDirection: isPortrait ? 'column' : 'row' }]}>
```

Change drop-zone labels and logic to match orientation. Drop zones at lines 191-193 currently show "Left"/"Right" with `flexDirection: 'row'` (`styles.dropZones` line 220). Make the drop zones respond to orientation:
```tsx
{dragging && <View pointerEvents="none" style={[styles.dropZones, { flexDirection: isPortrait ? 'column' : 'row' }]}>
  <View testID="drop-zone-left" style={[styles.dropZone, dropSide === 'left' && styles.dropZoneActive]}>
    <Text style={styles.dropZoneText}>{isPortrait ? 'Top' : 'Left'}</Text>
  </View>
  <View testID="drop-zone-right" style={[styles.dropZone, dropSide === 'right' && styles.dropZoneActive]}>
    <Text style={styles.dropZoneText}>{isPortrait ? 'Bottom' : 'Right'}</Text>
  </View>
</View>}
```

Remove `flexDirection: 'row'` from `styles.terminalRegion` (line 218) and from `styles.dropZones` (line 220), since both are now applied inline.

Update drag side detection in `Draggable.onUpdate` (line 78) and `onEnd` (line 86) to split on the correct axis depending on orientation. Pass `isPortrait` as a new prop to `Draggable` and `DraggableTab`. In the `Draggable` component, store it in a shared value so the worklet can read it. Side calculation becomes:
```ts
const side = inside
  ? (isPortraitValue.value
    ? (event.absoluteY < rectY.value + rectHeight.value / 2 ? 'left' : 'right')
    : (event.absoluteX < rectX.value + rectWidth.value / 2 ? 'left' : 'right'))
  : null;
```
The `SplitSide` type (`'left' | 'right'`) and `SplitLayout` data model stay unchanged — `'left'` means "first/top" and `'right'` means "second/bottom" in portrait. This avoids touching `placeInSplit`, `reconcileSplit`, all their callers, and the entire test suite that asserts on `'left'`/`'right'` semantics. Only the visual labels change.

**Test update** (`MultiTerminal.test.tsx`): Add `useWindowDimensions` to the `react-native` mock (line 40–46), returning `{ width: 100, height: 200 }` (portrait). Add one new test that re-renders with landscape dimensions (`{ width: 200, height: 100 }`) and verifies drop-zone text says "Left"/"Right" rather than "Top"/"Bottom". Existing drag tests already pass `absoluteX`/`absoluteY` — they work unchanged since the mock returns portrait dimensions and the `inside` check tests both axes.

### 2. Drag guideline center-screen threshold

**File:** `client/src/components/MultiTerminal.tsx`

In `Draggable.onBegin` (line 69–72), currently calls `runOnJS(onDragState)(true, null)` which sets `dragging=true` in parent, showing the drop-zone overlay immediately.

Change: in `onBegin`, **do not** call `onDragState(true, null)`. Instead, only call `onDragState(true, side)` from `onUpdate` when `side` transitions from `null` to non-null (i.e., when the drag first enters the terminal region). The visual effect: drop zones don't appear until the finger is inside the terminal region. The `onUpdate` handler already detects `inside` and only calls `onDragState` on side change. So: remove the `onDragState` call from `onBegin`, and change the `onUpdate` check at line 79 to also set `dragging` on first non-null side:
```ts
.onBegin(() => {
  scale.value = reducedMotion ? 1.04 : withTiming(1.04, { duration: 180 });
  opacity.value = reducedMotion ? 1 : withTiming(0.9, { duration: 180 });
  // ponytail: no onDragState here — drop zones appear only when drag reaches terminal region
})
.onUpdate((event) => {
  translateX.value = event.translationX;
  translateY.value = event.translationY;
  const inside = hasDropRect.value && event.absoluteX >= rectX.value && ...;
  const side = inside ? (...) : null;
  if (side !== currentSide.value) {
    currentSide.value = side;
    runOnJS(onDragState)(side !== null, side);
  }
})
```
The first argument to `onDragState` becomes `side !== null` instead of always `true`. This means `dragging` flips to `true` only when side is computed, and back to `false` when outside.

`onFinalize` still calls `runOnJS(onDragState)(false, null)` to clean up — unchanged.

**Test update**: The test at line 72–84 (`reactivates a drop zone on repeated drags`) currently calls `drag._onBegin()` then `update()`. After this change, `_onBegin` no longer triggers drop-zone visibility. The test already calls `update()` with `absoluteX: 0, absoluteY: 50` which is inside the mocked rect (0,0,100,100), so `dragging` becomes `true` from `onUpdate` and the test assertion on drop-zone style still passes. Confirm this by running `make client-test`.

### 3. Auto-close on session-not-found error

**File:** `client/app/terminal/[id].tsx`

Currently the multi-session `onError` callback (line 165) is `(message) => Alert.alert('Terminal', message)` for every error, including `session_not_found`.

The `SessionFrame` error type (session-socket.ts line 10) carries `code` and `message`. But `SessionSocket.onError` only passes `message` (line 51). Expand the `onError` callback signature to include `code`:

**File:** `client/src/lib/session-socket.ts` — Change the `onError` parameter type at line 25 from `(message: string) => void` to `(message: string, code: string) => void`. Update line 51: `this.onError(frame.message, frame.code)`. Update line 44 (onerror handler): `this.onError('Terminal connection lost', 'connection_lost')`.

**File:** `client/app/terminal/[id].tsx` — Update every `onError` callback that constructs a `SessionSocket`:

- Single-session `connect` (line 60): Change `(message) => Alert.alert('Terminal', message)` to:
  ```ts
  (message, code) => {
    if (code === 'session_not_found') { void finish(current); return; }
    Alert.alert('Terminal', message);
  }
  ```
  `finish(current)` already closes the socket, calls `closeSession` REST (swallowing 404), and navigates `router.replace('/')`. The `finishingRef` guard prevents double-nav.

- Multi-session `handleAddSession` (line 165): Change `(message) => Alert.alert('Terminal', message)` to:
  ```ts
  (message, code) => {
    if (code === 'session_not_found') {
      multiSocketsRef.current[sessionId]?.close();
      delete multiSocketsRef.current[sessionId];
      setMultiSessions((prev) => closeSession(prev, sessionId));
      return;
    }
    Alert.alert('Terminal', message);
  }
  ```
  This silently removes the dead pane. If it was the last session, the user sees an empty tab bar — they can detach or add a new session. No navigation to dashboard for single-pane removal (other sessions may still be alive). If all sessions are gone, the user presses Detach (already present in header).

**File:** `client/src/lib/session-socket.test.ts` — Existing tests use `jest.fn()` for `onError` and only assert `not.toHaveBeenCalled()`, so the signature change is transparent. Add one new test `'forwards error code from error frames'` in the `SessionSocket` describe block: construct a `SessionSocket` with `onError = jest.fn()`, connect, open the mock socket, then fire `onmessage` with `{ type: 'error', code: 'session_not_found', message: 'session not found' }`. Assert `onError` was called with `('session not found', 'session_not_found')`. Also fire `onerror` on the mock socket and assert `onError` was called with `('Terminal connection lost', 'connection_lost')`.

### 4. Fix tab text overflow in MultiTerminal

**File:** `client/src/components/MultiTerminal.tsx`

The tab at line 212 has `maxWidth: 180, flexDirection: 'row'` but no `overflow: 'hidden'`. The `tabSelect` pressable (line 214) has `flex: 1` but no `overflow: 'hidden'`. Long session names can visually overflow into the close button area.

Fix by adding `overflow: 'hidden'` to `styles.tab` (line 212). This clips any text that would overflow the `maxWidth: 180` boundary. The close button sits at `width: 40` inside the same row and won't be clipped because it has its own fixed width. Also add `overflow: 'hidden'` to `styles.tabSelect` (line 214) to ensure the Text stays within the pressable's bounds.

No AddSessionFAB changes needed — the reported "name covered by new session text" is the tab overlap described above, not a GlassBottomSheet content issue. The GlassBottomSheet `present()` bug is out of scope (separate from this plan, same as `plans/daemon-management-buttons.md` noted).

## Critical files & anchors

- `client/src/components/MultiTerminal.tsx:67-92` — Draggable gesture handlers where orientation-aware side detection and drag-start timing changes land.
- `client/src/components/MultiTerminal.tsx:180-194` — Terminal region + drop zones JSX where dynamic `flexDirection` and conditional labels are applied.
- `client/src/components/MultiTerminal.tsx:208-224` — StyleSheet where `terminalRegion`, `dropZones`, `tab`, `tabSelect` styles are modified.
- `client/src/lib/session-socket.ts:20-51` — SessionSocket constructor + onmessage handler where `onError` signature expands to include `code`.
- `client/app/terminal/[id].tsx:52-63,146-171` — Single and multi-session socket construction where `session_not_found` auto-close logic is added.

## Verification

1. `make client-test` — all existing + new tests pass. Covers drag zone reactivation, orientation-responsive drop-zone labels, tab close, pane swapping.
2. `make lint` — `go vet` + `tsc --noEmit` clean.
3. `make client-build-web` — web export succeeds with new `useWindowDimensions` usage and expanded `onError` signature.
4. Manual web test for orientation: open multi-terminal in browser, resize viewport to portrait (e.g. 400×800) → panes stack vertically, drop zones show "Top"/"Bottom". Resize to landscape (800×400) → panes split horizontally, drop zones show "Left"/"Right".
5. Manual test for drag threshold: long-press a tab → no drop-zone overlay until dragging into the terminal region center.
6. Tab text overflow: create a session with a very long name → text stays clipped inside the tab, "x" close button remains visible and tappable.
7. Session-not-found: not exercisable without a real daemon, but unit-testable by verifying the `onError` callback receives `(message, 'session_not_found')` and the session is removed from state. Add one test in `MultiTerminal.test.tsx` or `session-socket.test.ts` that asserts the `code` argument is forwarded.

## Assumptions & contingencies

- `SplitSide` type stays `'left' | 'right'` even in portrait (where it means top/bottom). Adding `'top' | 'bottom'` would require changing `placeInSplit`, `reconcileSplit`, all callers, and all tests for zero functional benefit — the layout model is "first/second pane", not directional. If user insists on `'top'/'bottom'` naming, it's a broader refactor planned separately.
- AddSessionFAB's `GlassBottomSheet.present()` is broken (same root cause as ConnectionSheet). This plan does not fix it — it's a separate issue from the tab overlap. If it needs fixing too, apply the same `Modal` pattern from `plans/daemon-management-buttons.md`.
- `useWindowDimensions` mock in test defaults to portrait (100×200). Tests that need landscape explicitly override. If jest-expo provides its own `useWindowDimensions` mock that conflicts, the explicit mock in the test file takes precedence since it replaces the entire `react-native` module.
