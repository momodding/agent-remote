<!-- source-branch: main -->
<!-- work-branch: omp/keyboard-shell-ux-overhaul -->
# Plan: keyboard-shell-ux-overhaul

Four independent UI/backend tasks for agenticRemote. Each section is a self-contained, decision-complete spec — an implementer needs no further design input.

---

## Task 1 — Sticky Shortcut Bar & Keyboard Handoff State Machine

### Current state (verified)
- `client/app/terminal/[id].tsx`: `keyboardMode` state (`'native'|'shortcuts'`, line 22) is toggled by a header button (lines 276-278, single-session; lines 236-238, multi-session) immediately left of the `Clear` button (line 279, single-session only). `Wrapper` = `KeyboardAvoidingView` (non-web) with `enabled: keyboardMode === 'native'` (lines 17, 24-26). A `useEffect` (lines 30-37) calls `Keyboard.dismiss()` + `terminalRef.current?.blur()` when switching to `'shortcuts'`, or `.focus()` when switching to `'native'`. `ShortcutKeyboard` only renders when `keyboardMode === 'shortcuts'` (line 286, single; line 121, `MultiTerminal.tsx`).
- `client/src/components/ShortcutKeyboard.tsx`: already has internal `collapsed`/`keyboardVisible` state. `Keyboard.addListener` (lines 33-40, iOS `keyboardWillShow/Hide` vs Android `keyboardDidShow/Hide`) toggles `keyboardVisible`, which zeroes `paddingBottom` so the bar/pill sits flush above the OS keyboard when it's up. Collapsed pill (line 41) and hide button (line 55) are the only expand/collapse triggers today; neither calls back to the parent.
- `Terminal.tsx` is an xterm WebView; its focus target is a DOM textarea *inside* the WebView, not a native `TextInput`.

### Technical constraint (why not literal InputAccessoryView)
RN's `InputAccessoryView` only binds via `inputAccessoryViewID` shared with a native `TextInput` in the same tree. Terminal's focus happens inside a WebView's DOM — there is no native `TextInput` to attach an `inputAccessoryViewID` to, and RN has no public bridge for "dock this view above whatever WebView-triggered keyboard is showing." True `InputAccessoryView` is infeasible without invasive WebView-side native bridging, which is out of scope and against the "boring code" preference. **Decision:** achieve the same *visual* docking (top-of-keyboard when active, bottom-of-screen when both dismissed) using `Keyboard` event `endCoordinates.height` — this is stdlib RN, already the pattern `ShortcutKeyboard` uses (ladder rung 3), cross-platform, zero new dependencies.

### State machine
Three visual states of the `ShortcutKeyboard` overlay, driven entirely inside the component (no more external `keyboardMode` prop):
1. **Both dismissed** — collapsed pill (`⌨ Shortcuts`), pinned to the bottom of the screen.
2. **Native keyboard active** — collapsed pill pinned to the top edge of the native keyboard (offset = `keyboardHeight`).
3. **Panel expanded** — full shortcut panel, native keyboard forced closed, pinned to the bottom of the screen (panel occupies the space the keyboard would).

Transitions:
- Tap collapsed pill → call `onExpand?.()` (parent does `Keyboard.dismiss()` + `terminalRef.current?.blur()`), then `setCollapsed(false)`.
- Tap hide (`⌄`) on expanded panel → call `onCollapse?.()` (parent does `terminalRef.current?.focus()`), then `setCollapsed(true)`.
- Native keyboard opening/closing (user tapped the terminal directly) is tracked purely via the existing `Keyboard.addListener` — no explicit mode toggle needed.

### Exact changes

**`client/src/components/ShortcutKeyboard.tsx`**
- Add `keyboardHeight` state, set from `e.endCoordinates.height` in the existing show listener (default `0` if `endCoordinates` missing — ponytail: some Android OEM/emulator builds omit it, fall back to flush-bottom rather than crash).
- Add two new optional props: `onExpand?: () => void`, `onCollapse?: () => void`.
- Line 41 (collapsed pill `onPress`): call `onExpand?.()` before `setCollapsed(false)`.
- Line 55 (hide button `onPress`): call `onCollapse?.()` before `setCollapsed(true)`.
- Wrap the returned pill/panel in a `View` positioned `{ position: 'absolute', left: 0, right: 0, bottom: keyboardVisible ? keyboardHeight : 0 }` (new style `dock`) instead of relying on in-flow placement — this is what makes the pill hug the top of the native keyboard.

**`client/app/terminal/[id].tsx`**
- Remove `keyboardMode` state (line 22), `wrapperProps` ternary (lines 24-26) and the mode-switch `useEffect` (lines 30-37), `toggleKeyboardMode` callback (lines 210-212).
- `Wrapper` becomes plain `View` unconditionally (drop the `Platform.OS === 'web' ? View : KeyboardAvoidingView` ternary, line 17) — no longer needed since `ShortcutKeyboard` self-docks via absolute positioning instead of being pushed by `KeyboardAvoidingView`.
- Remove the "Toggle keyboard" button beside `Clear` (lines 276-278, single-session header) — **this is the button named in the task**.
- Remove the matching multi-session header toggle button (lines 236-238) for consistency — `keyboardMode` no longer exists as a prop to drive it.
- Line 286: render `<ShortcutKeyboard .../>` unconditionally (drop the `keyboardMode === 'shortcuts' &&` guard), passing `onExpand={() => { Keyboard.dismiss(); terminalRef.current?.blur(); }}` and `onCollapse={() => terminalRef.current?.focus()}`.
- Multi-session branch (line 255-256): stop passing `keyboardMode`/`onKeyboardModeToggle` to `<MultiTerminal>`.

**`client/src/components/MultiTerminal.tsx`**
- Remove `keyboardMode`/`onKeyboardModeToggle` from `Props` (lines 17-18) and destructuring (lines 30-31).
- Line 121: render `<ShortcutKeyboard>` unconditionally (drop the `keyboardMode === 'shortcuts' &&` guard), wiring `onExpand`/`onCollapse` through `getFocused()` (existing helper, lines 35-38) — `onExpand={() => getFocused()?.blur()}`, `onCollapse={() => getFocused()?.focus()}` (no `Keyboard.dismiss()` needed here since multi-mode never enabled `KeyboardAvoidingView`).

**`client/src/components/MultiTerminal.test.tsx`** — remove `keyboardMode="shortcuts" onKeyboardModeToggle={jest.fn()}` from all 5 `<MultiTerminal>` render calls (lines 60, 82, 109, 135, 162) — prop no longer exists on the type.

**`client/src/components/ShortcutKeyboard.test.ts`** — re-run after the edit (`make client-test`); if it asserts on the pill/panel's static in-flow position rather than behavior, adjust to match the new `onExpand`/`onCollapse` callback contract. No assertions on `keyboardHeight` math are required (behavior, not pixel values, is what's testable).

---

## Task 2 — Bottom Sheet Keyboard Occlusion Fix

### Root cause (verified)
`client/src/components/AddSessionFAB.tsx` nests `KeyboardAvoidingView` **inside** a `Pressable` backdrop (lines 44-45: `<Pressable style={styles.backdrop}><KeyboardAvoidingView .../></Pressable>`). The backdrop's `justifyContent: 'flex-end'` already positions the sheet at the bottom; `KeyboardAvoidingView` then tries to *also* push it up by adding padding — from inside a flex child, not the screen root — which the working sheets don't do. `ConnectionSheet.tsx`/`PairingSheet.tsx` put `KeyboardAvoidingView` as the **direct child of `Modal`** (`ConnectionSheet.tsx` line 31-32), with no intermediate backdrop wrapper. Compounding this, `AddSessionFAB`'s form (line 53, plain `View`) has no `ScrollView`, so once the keyboard covers part of the fixed `minHeight: 300` sheet, the `Command` input / `Create` button have no way to scroll into view.

### Fix (mirrors the working pattern, keeps current visuals)
Keep the transparent/fade bottom-sheet look (do **not** switch to `ConnectionSheet`'s pageSheet style — that's a visual redesign, not what was asked). Restructure so `KeyboardAvoidingView` is a **direct child of `Modal`**, with the dimming backdrop as a separate absolutely-positioned sibling instead of an outer wrapper:

```tsx
<Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
  <Pressable style={styles.backdrop} onPress={() => setVisible(false)} />
  <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.sheet}>
    <View style={{ paddingTop: insets.top }}>
      <View style={styles.header}>...</View>
      <ScrollView style={styles.formScroll} contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        {/* Name input, shell radio list from Task 3, Create button */}
      </ScrollView>
    </View>
  </KeyboardAvoidingView>
</Modal>
```

Exact edits to `client/src/components/AddSessionFAB.tsx`:
- Line 44-76: remove the `Pressable`-wraps-`KeyboardAvoidingView` nesting. Backdrop `Pressable` becomes its own sibling with `style={StyleSheet.absoluteFillObject}` merged into the existing `backdrop` style (drop `justifyContent: 'flex-end'` from `backdrop`, since it no longer positions the sheet).
- `styles.sheet` (lines 111-116): add `position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '85%'` (explicit cap so the sheet never grows past 85% of screen height on small devices; `KeyboardAvoidingView`'s padding still pushes it up above the keyboard).
- Line 53 (`<View style={styles.form}>`) becomes `<ScrollView style={styles.formScroll} contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">...</ScrollView>` (closing tag likewise). Add `formScroll: { maxHeight: '100%' }` to styles (bounds it inside `sheet`'s `maxHeight`).
- The `onTouchStart={(e) => e.stopPropagation()}` on the old nested `KeyboardAvoidingView` (line 45) is no longer needed — backdrop and sheet are now siblings, so taps on the sheet never reach the backdrop's `onPress` in the first place. Drop it.

No `app.json`/`AndroidManifest` changes: `ConnectionSheet`/`PairingSheet` already use plain `Modal` + `KeyboardAvoidingView` successfully with the current config, so the config isn't the blocker — the nesting was.

---

## Task 3 — Dynamic OS Shell Discovery & Radio Button UI

### Backend

**`backend/internal/protocol/protocol.go`** — append after `NotifyRegisterRequest` (line 151-154):
```go
type ListShellsResponse struct {
	Shells []string `json:"shells"`
}
```

**`backend/internal/session/manager.go`** — new free function after `defaultShell()` (after line 489), same file/style, reusing the `runtime.GOOS` branch and `os.ReadFile`+`strings.Split` pattern already used by `defaultShell()`:
```go
func AvailableShells() []string {
	if runtime.GOOS == "windows" {
		var shells []string
		for _, candidate := range []string{"cmd.exe", "powershell.exe", "pwsh.exe"} {
			if _, err := exec.LookPath(candidate); err == nil {
				shells = append(shells, candidate)
			}
		}
		if len(shells) == 0 {
			shells = []string{defaultShell()}
		}
		return shells
	}
	data, err := os.ReadFile("/etc/shells")
	if err != nil {
		return []string{defaultShell()}
	}
	var shells []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		shells = append(shells, line)
	}
	if len(shells) == 0 {
		// ponytail: /etc/shells missing entries on minimal containers — fall back rather than return empty.
		return []string{defaultShell()}
	}
	return shells
}
```
No new imports needed — `os`, `os/exec`, `runtime`, `strings` are already imported (lines 3-21).

**`backend/internal/server/server.go`**
- Add import `"github.com/agenticremote/agenticremote/backend/internal/session"` (no import cycle: `session` doesn't import `server`).
- `Handler()` (after line 67, the `/v1/sessions/` route): add `mux.HandleFunc("/v1/shells", s.withAuth(s.handleShells))`.
- New handler after `handleSessions` (after line 203):
```go
func (s *Server) handleShells(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, protocol.ListShellsResponse{Shells: session.AvailableShells()})
}
```
Calling the `session` package function directly (not through the `SessionAPI` interface) is deliberate: `AvailableShells()` is stateless, so threading a new method through `SessionAPI` + `Manager` + every test double buys nothing (ladder rung 2 — reuse what's already there, don't grow the interface for a pure OS query).

**Tests**
- `backend/internal/session/manager_test.go`: add `TestAvailableShellsNonEmpty` asserting `len(AvailableShells()) > 0` and no blank entries (cross-platform-safe; can't assert exact paths).
- `backend/internal/server/server_test.go`: add `TestHandleShellsRequiresBearerAndReturnsList`, mirroring `TestSessionsRequiresBearer` (lines 29-44) — unauthenticated GET → 401; authenticated GET → 200 with non-empty `Shells`.

### Client

**`client/src/protocol.ts`** — after `GitStatus` (line 53): `export type ListShellsResponse = { shells: string[] };`

**`client/src/lib/api.ts`**
- Import `ListShellsResponse` in the top type-import block (lines 1-9).
- Add method after `gitStatus` (after line 55): `async shells(): Promise<string[]> { return (await this.request<ListShellsResponse>('/v1/shells')).shells; }`

**`client/src/components/AddSessionFAB.tsx`** — replace the `Command` `TextInput` (lines 63-69) with a radio list:
- New state: `const [shells, setShells] = useState<string[]>([]);`
- `useEffect` firing when `visible` becomes `true`: `api.shells().then(setShells).catch(() => setShells([]))` (older daemon without this endpoint, or offline — degrade to just the "Default shell" row, no crash).
- Render a `ScrollView` (`maxHeight: 180`, nested inside the Task-2 form `ScrollView` — safe since both are plain `ScrollView`s with a small, non-virtualized item count) containing:
  - One fixed leading row: `"Default shell"`, selected when `command === ''`.
  - One row per entry in `shells`, selected when `command === entry`, `onPress={() => setCommand(entry)}`.
  - Each row: a `Pressable` with a radio circle (`View`, `styles.radioOuter` = 18×18 circle border, `styles.radioInner` = 10×10 filled circle rendered only when selected) + `Text` showing the shell path — plain RN styling, no icon library (a filled/empty circle needs no vector icon).
- `command` already defaults to `''` (line 16) meaning "daemon picks its default" — unchanged semantics, `create()` (line 24) is unaffected.

---

## Task 4 — Intuitive Iconography & Touch Feedback

### Scope
Terminal-facing surfaces only, per the task's own framing ("terminal toolbars/headers/shortcut panel"): `ShortcutKeyboard.tsx`, `client/app/terminal/[id].tsx` header, `MultiTerminal.tsx` toolbar/pane headers. **Explicitly out of scope:** `client/app/index.tsx` (dashboard topbar/session cards) — not a terminal toolbar/header; left untouched.

### Dependency decision
No icon library is installed (verified: absent from `client/package.json` and `node_modules`). A same-size stdlib/native substitute doesn't exist for a multi-glyph icon set (unlike Task 3's single radio dot, which plain `View` styling covers) — this genuinely needs a new dependency (ladder rung 5). **Choice: `@expo/vector-icons`, `Feather` icon set** — the Expo-ecosystem-standard package (officially maintained, SDK-version-matched via `expo install`), outline style matching the current minimal dark UI, ships bundled TypeScript types. Install via `bunx expo install @expo/vector-icons` (Expo-aware install resolves the SDK-compatible version, matching this project's Managed-workflow convention — not a plain `bun add`).

### Icon mapping (Feather glyph names, verified to exist in the Feather set)
| Location | Current | New icon |
|---|---|---|
| `ShortcutKeyboard.tsx` Copy (line 52) | `Text` "Copy" | `copy` |
| `ShortcutKeyboard.tsx` Paste (line 53) | `Text` "Paste" | `clipboard` |
| `ShortcutKeyboard.tsx` SelAll (line 54) | `Text` "SelAll" | `check-square` (closest Feather semantic match — no literal "select-all" glyph exists) |
| `ShortcutKeyboard.tsx` hide/collapse (line 55) | `Text` "⌄" | `chevron-down` |
| `[id].tsx` Clear (line 279) | `Text` "Clear" | `trash-2` |
| `[id].tsx` Close session (line 280) | `Text` "Close" | `x` |
| `MultiTerminal.tsx` Minimize (line 73) | `Text` "−" | `minimize-2` |
| `MultiTerminal.tsx` Close pane (line 79) | `Text` "✕" | `x` |
| `MultiTerminal.tsx` Broadcast toggle (line 54-56) | `Text` "⚡ Broadcasting"/"Broadcast Input" | `zap` icon + retained `Text` label (icon-only would lose the on/off wording; keep both) |

`Ctrl`/`Alt` modifier buttons (`ShortcutKeyboard.tsx` lines 50-51) and terminal-row key buttons (line 59, e.g. `Esc`/`Tab`/`F1`) stay **text-only, deliberately** — these are literal key-name labels; an icon would reduce clarity, not add it. Not a gap — an explicit non-goal.

Render pattern (no wrapper component — too few call sites, ~9, to justify one; inline JSX matches the file's existing terse style):
```tsx
<Pressable accessibilityLabel="Copy" ...><Feather name="copy" size={16} color="#F0F0F0" /></Pressable>
```
Every icon-ified `Pressable` keeps its existing (or gains a new) `accessibilityLabel` equal to its prior text, so accessibility and any label-based test queries survive the visual swap unchanged.

### Touch feedback
Repo convention is 100% `Pressable`, zero `TouchableOpacity`/`TouchableHighlight`/`android_ripple` today — introducing `TouchableHighlight` would plant a second competing pattern (prohibited). **Decision: extend `Pressable`, don't replace it.** For every `Pressable` touched by the icon swap above, add:
```tsx
<Pressable
  android_ripple={{ color: 'rgba(255,255,255,0.15)' }}
  style={({ pressed }) => [existingStyle, pressed && styles.pressed]}
  ...
>
```
Add one shared style: `pressed: { opacity: 0.6 }`. This is `Pressable`'s built-in ripple/pressed-state API (stdlib RN, zero new dependency) — satisfies "android_ripple, opacity" from the task without adding a second touch-feedback component family.

### Test impact
`MultiTerminal.test.tsx` already queries by `accessibilityLabel` (e.g. `'Minimize Shell 1'`, `'Enable broadcast'`/`'Disable broadcast'`, lines 140, 144, 167-169) — unaffected by swapping the inner `Text` for `Feather`, since labels are preserved. `ShortcutKeyboard.test.ts` must be checked at implementation time: if it queries by visible text content (e.g. `"Copy"`), switch those assertions to `accessibilityLabel` queries instead, adding `accessibilityLabel="Copy"` etc. to the now-icon-only buttons. Verify via `make client-test` after the edit; fix any surfaced query mismatches — this is the real verification step for this task, not a planning gap.

---

## Cross-task notes
- Tasks 1, 2, 4 touch only `client/`; Task 3 touches both `backend/` and `client/`. No file is touched by more than one task except `AddSessionFAB.tsx` (Task 2 restructures the Modal/KeyboardAvoidingView shell; Task 3 replaces the Command `TextInput` inside it) — apply Task 2's structural edit first, then Task 3's content edit lands inside the new `ScrollView`.
- Verification: `make backend-test` (Task 3 Go tests), `make client-test` (Tasks 1/2/3/4 Jest suites, including the `ShortcutKeyboard.test.ts` check called out above), `make client-build-web` (Expo web export still compiles with the new dependency and removed props), `make lint`.
