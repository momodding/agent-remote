<!-- work-branch: omp/new-session-glass-sheet -->
<!-- source-branch: main -->
# New-session bottom sheet: keyboard-safe + liquid-glass style

## Context

`AddSessionFAB` (`client/src/components/AddSessionFAB.tsx`) renders the "New Session" form as a `Modal` + `KeyboardAvoidingView` fixed-height sheet. On Android, `behavior="height"` shrinks the sheet but the focused `TextInput` (Name field) still ends up under the on-screen keyboard because nothing scrolls the input into view once the sheet shrinks. Replace this with a `@gorhom/bottom-sheet` `BottomSheetModal` that expands (grows toward the top of the screen) and auto-scrolls so the focused input clears the keyboard, and restyle the sheet/backdrop with an `expo-blur` frosted-glass surface that reads correctly in both the app's forced-dark theme and a light theme, keeping content off the screen edges. Same fix pattern applies to `ConnectionSheet.tsx`, which has the identical `Modal` + `KeyboardAvoidingView` problem with two focusable text inputs (`Editor` sub-component) — decided in scope because the ask is "new session" specifically but the same regression exists here with an identical fix; skip only if the user narrows scope. `PairingSheet.tsx` is unaffected by this plan — check it as a candidate but do not touch unless it has the same Modal+KeyboardAvoidingView shape (Step 0 verifies this).

End state: opening "New Session" (or "Daemon connections") on Android, tapping the Name/Command/Endpoint/Token field scrolls that field to just above the keyboard inside a translucent, blurred bottom sheet that is legible with light or dark theme applied, with consistent inset padding from every screen edge.

## Approach

### Step 0 — `PairingSheet.tsx` has the same defect; include it
`client/src/components/PairingSheet.tsx` uses the identical `Modal`+`KeyboardAvoidingView` shape (line 140–141) with two `TextInput`s: device-name (line 144) and paste-JSON (line 155, `multiline`). Confirmed by direct read this session — same conversion applies. Add it as a third target alongside `AddSessionFAB.tsx`/`ConnectionSheet.tsx` in Steps 4/5/6 (a "Step 5b" — same transform as Step 5: wrap in `GlassBottomSheet`, `dismiss()` → existing `dismiss` function (line 52), swap both `TextInput`s for `BottomSheetTextInput`, swap any inner `ScrollView` for `BottomSheetScrollView` if present in the unread `styles.camera`/scan-branch JSX — re-read lines 126–170 in full before editing since only the scan-mode branch header was inspected this session). `PairingSheet`'s `multiline` paste-JSON field needs no special handling — `BottomSheetTextInput` forwards `multiline` like any other `TextInput` prop.

- `"expo-blur": "~57.0.2"`

`react-native-reanimated@4.5.0` and `react-native-gesture-handler@2.32.0` are already present (peer deps satisfied); `react-native-worklets` is already resolved transitively via `expo-modules-core` (confirmed present in `node_modules`), no new entry needed for it.

In `client/jest.config.js`, add `resolver: 'react-native-worklets/jest/resolver'` to the exported config object (alongside `testMatch`/`transformIgnorePatterns`). Without this, any test file that imports `react-native-reanimated` or `react-native-gesture-handler` (transitively, via `@gorhom/bottom-sheet`) throws `TypeError` in `NativeWorklets.native.ts` during `loadUnpackers` — verified locally: adding the resolver line was the only change needed to make a reanimated+gesture-handler smoke test pass under the current `jest-expo` preset; leaving it out reproduces the crash. Do not add a `setupFilesAfterEnv: ['reanimated/setUpTests']` entry — it does not fix this particular failure (verified) and is unnecessary since existing tests don't assert on animated values.

Run `bun install` in `client/` after the `package.json` edit (not covered by an automated check below — this is a one-time setup action, run it manually before Step 2).

### Step 2 — Android keyboard layout mode (prerequisite for Steps 3–5, independent of Step 1)
In `client/app.json`, under `"android"`, add `"softwareKeyboardLayoutMode": "resize"` (Expo default is already `resize`, but state it explicitly since `@gorhom/bottom-sheet`'s Android keyboard handling assumes resize mode — its `android_keyboardInputMode` prop, defaulting to `'adjustPan'`, is the *sheet's own* internal handling and works with either manifest mode, but explicit `resize` avoids double-handling with `windowTranslucentStatus`, which is not enabled here since `statusBarStyle` in `_layout.tsx` uses `expo-status-bar`'s own `style="light"`, not translucent — confirm no regression by checking `client/app.json` has no `"statusBar": {"translucent": true}` key, which it doesn't as of this read).

### Step 3 — Build `GlassBottomSheet` shared wrapper (new file, no existing equivalent)
Create `client/src/components/GlassBottomSheet.tsx`. No existing bottom-sheet or blur wrapper exists in `client/src/components` (confirmed: only `AddSessionFAB.tsx`, `ConnectionSheet.tsx`, `PairingSheet.tsx`, `ShortcutKeyboard.tsx`, `MultiTerminal.tsx`, `Terminal.tsx`/`Terminal.web.tsx` exist there) — this is genuinely new, not a duplicate of a rival pattern.

Signature:
```tsx
export type GlassBottomSheetHandle = { present: () => void; dismiss: () => void };

type Props = {
  title: string;
  onDismiss?: () => void;
  children: React.ReactNode; // caller supplies BottomSheetScrollView content
};

export const GlassBottomSheet = forwardRef<GlassBottomSheetHandle, Props>(function GlassBottomSheet(
  { title, onDismiss, children },
  ref,
) { ... });
```
Internals:
- Wrap `BottomSheetModal` from `@gorhom/bottom-sheet`. `useImperativeHandle(ref, () => ({ present: () => sheetRef.current?.present(), dismiss: () => sheetRef.current?.dismiss() }))`.
- `enableDynamicSizing={true}`, no `snapPoints` prop (dynamic sizing handles "expandable to top" — the sheet grows to fit content up to `maxDynamicContentSize`); set `maxDynamicContentSize` to `screenHeight - insets.top - 24` (import `useWindowDimensions` from `react-native`, `useSafeAreaInsets` from `react-native-safe-area-context` — both already used elsewhere, e.g. `AddSessionFAB.tsx:3`) so the sheet can expand to just below the status bar / notch, never fully off top-of-screen.
- `keyboardBehavior="interactive"` (offsets sheet content by keyboard height — the "auto expand and scroll when cursor focused" requirement; this is a documented prop of `BottomSheetModal`/`BottomSheet`, default value is already `'interactive'` but set it explicitly for clarity since it's load-bearing here).
- `android_keyboardInputMode="adjustResize"` (explicit; library default is `'adjustPan'` — `adjustResize` is required so the sheet's internal height recalculation on Android matches the shrunk window, matching the "expandable to top and scrollable" requirement; `adjustPan` only pans, doesn't resize, which is what causes today's Android cover-up bug in the old `KeyboardAvoidingView height` mode. This is the single most load-bearing prop change for the Android bug fix).
- `keyboardBlurBehavior="restore"` (sheet returns to its pre-keyboard snap point when keyboard dismisses — matches "auto expand and scroll... to prevent covered" intent without leaving the sheet stuck tall after keyboard closes).
- `backdropComponent`: pass `BottomSheetBackdrop` (import from `@gorhom/bottom-sheet`) rendered via a local render-prop function, with `opacity={0.55}`, `enableTouchThrough={false}`, `pressBehavior="close"` — reuse library default backdrop instead of hand-rolling one (the current `AddSessionFAB.tsx:52` `Pressable` backdrop and `ConnectionSheet.tsx` (no backdrop, uses native `pageSheet` presentation) are the two rival patterns; standardize on `BottomSheetBackdrop` for both since it wires backdrop-press-to-close and index-based fade automatically).
- `backgroundComponent`: custom function component `GlassBackground` (defined in the same file, not exported) that renders `<BlurView intensity={GLASS_BLUR_INTENSITY} tint={colorScheme === 'dark' ? 'dark' : 'light'} style={[styles.glassBackground, style]} />` wrapping nothing else (background components in this library only receive `style`/`pointerEvents` per `BottomSheetBackgroundProps` — content is layered separately by the library, do not put children here). Determine `colorScheme` via `useColorScheme()` from `react-native` (see Step 4 for why this now actually varies at runtime).
  - `GLASS_BLUR_INTENSITY = 60` (0–100 scale; verified against `expo-blur` docs example range 80–100 for strong blur — 60 balances "still visible" legibility against a genuine frosted look per the liquid-glass reference aesthetic, since full clarity-mode transparency (like the native iOS 26 effect) isn't reproducible with a blur-only approximation).
  - `styles.glassBackground`: `{ borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' }` — the 1px translucent border is the key "liquid glass" edge-highlight cue that a plain blur lacks; use the same literal in both themes (it reads correctly against both a dark and light blurred backdrop because it's low-opacity white, standard glassmorphism convention).
- `handleIndicatorStyle`: `{ backgroundColor: colorScheme === 'dark' ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.3)' }` — the grabber must be visible on either theme's blurred background (this is the literal "all components still visible in both themes" requirement applied to the sheet's own drag handle).
- Render `title` in a header row using `BottomSheetView` (not `View` — `BottomSheetView` is the library's non-scrollable content-height-reporting container, required for `enableDynamicSizing` to measure correctly; using plain `View` here breaks dynamic sizing) with padding `{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12 }` — the 20px horizontal is the "not too close to edge" requirement for the header; children (the scrollable form) are rendered as `{children}` directly below, so callers control their own edge padding (Step 4/5 specify exact values for each caller).
- Export `GlassBottomSheet`, `GLASS_BLUR_INTENSITS` intensity constant is internal-only (not exported — no other file needs it).

Edge case: `onDismiss` prop forwarded to `BottomSheetModal`'s `onDismiss` — fires on backdrop press, swipe-down, or programmatic `dismiss()`; this is how callers reset their own `visible`/form state (see Step 4/5).

### Step 4 — Convert `AddSessionFAB.tsx` to use `GlassBottomSheet`
Rewrite `client/src/components/AddSessionFAB.tsx`:
- Remove imports: `KeyboardAvoidingView`, `Modal`, `Pressable` (backdrop no longer hand-rolled — the FAB `Pressable` itself stays), `ScrollView` (replaced by `BottomSheetScrollView`).
- Add imports: `BottomSheetScrollView`, `BottomSheetTextInput` from `@gorhom/bottom-sheet`; `GlassBottomSheet`, `type GlassBottomSheetHandle` from `./GlassBottomSheet`; `useColorScheme` from `react-native`.
- Replace `const [visible, setVisible] = useState(false)` usage: keep `visible` state (still needed to gate the `api.shells()` effect at line 19–23) but drive the sheet via a `useRef<GlassBottomSheetHandle>(null)` (`sheetRef`) instead of the `Modal`'s `visible` prop. `setVisible(true)` on FAB press (line 45) becomes: `setVisible(true); sheetRef.current?.present();`. Cancel button (line 57) and backdrop-press both funnel through `GlassBottomSheet`'s `onDismiss={() => setVisible(false)}` — remove the explicit `Pressable`-backdrop `onPress={() => setVisible(false)}` and the header's `Cancel` `Pressable`'s manual `setVisible(false)`, replacing the Cancel button's `onPress` with `sheetRef.current?.dismiss()` (which then triggers `onDismiss` → `setVisible(false)`), so there's exactly one state-reset path.
- Replace the `Modal`/`KeyboardAvoidingView`/outer `View` (lines 51–60 region) with:
  ```tsx
  <GlassBottomSheet title="New Session" onDismiss={() => setVisible(false)} ref={sheetRef}>
    <BottomSheetScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
      ...
    </BottomSheetScrollView>
  </GlassBottomSheet>
  ```
  Keep everything currently inside `styles.form`'s `ScrollView` (Name label/input, Command label/radio list, Create button) unchanged in structure — only swap the outer `ScrollView` for `BottomSheetScrollView` (drop-in API-compatible replacement per library docs) and swap the Name `TextInput` (line 63–69) for `BottomSheetTextInput` (same props — `style`, `value`, `onChangeText`, `placeholder`, etc. — it forwards them all; required so the library's internal keyboard-focus tracking (`animatedKeyboardState`) knows this input triggered the keyboard, which is what drives the auto-scroll-into-view behavior. A plain `TextInput` inside a `BottomSheetScrollView` would not trigger `keyboardBehavior="interactive"` correctly).
- Delete `styles.backdrop`, `styles.sheet`, `styles.header`, `styles.title`, `styles.cancel`, `styles.formScroll` (all superseded by `GlassBottomSheet`'s own header/background) — keep `styles.form`, `styles.label`, `styles.input`, `styles.radioList`, `styles.radioRow`, `styles.radioOuter`, `styles.radioInner`, `styles.radioLabel`, `styles.create`, `styles.createText`, `styles.fab`, `styles.fabDisabled`, `styles.fabText` as-is (FAB button styling and form-content styling are unaffected by the sheet-shell swap).
- Theme the retained styles for light/dark instead of hardcoded dark literals: add `const colorScheme = useColorScheme();` at the top of the component and a small local `palette` object:
  ```tsx
  const palette = colorScheme === 'dark'
    ? { text: '#F0F0F0', border: '#3A3A3A', accent: '#46B8C4' }
    : { text: '#1A1A1A', border: '#D0D0D0', accent: '#0E8A96' };
  ```
  Apply `palette.text`/`palette.border`/`palette.accent` inline via `style={[styles.input, { color: palette.text, borderColor: palette.border }]}` (and equivalent for `label`, `radioLabel`, `radioOuter` borderColor, `radioInner`/`create` backgroundColor, `cancel`-equivalent) rather than baking colors into `StyleSheet.create` — this is the "component visible in both light and dark theme" requirement; `#46B8C4` (cyan accent) on a light frosted-glass background has adequate contrast per existing brand color, but `#0E8A96` (darker cyan) is used in light mode for AA contrast against a white/light-blur background — pick this because `#46B8C4` at light-mode blur alpha fails contrast against near-white; `#0E8A96` is the same hue darkened, keeping brand identity. State this literal now so no implementer judgment call is needed.
  Form content padding: change `styles.form` `padding: 16` → `paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24` (matches "not too close to edge" — 20px horizontal matches the header's 20px from Step 3, 24px bottom clears the home-indicator/gesture-nav area beyond the sheet's own safe-area handling from `BottomSheetModal`).
- `fab`/`fabText`/`fabDisabled` stay hardcoded (`#46B8C4`/`#0A0A0A`/`#3A3A3A`) — the FAB itself isn't inside the sheet and isn't part of the reported bug; only theme what the ask covers (the sheet). Note as explicit scope boundary, not a follow-up.

### Step 5 — Convert `ConnectionSheet.tsx` to use `GlassBottomSheet`
Rewrite `client/src/components/ConnectionSheet.tsx` — same defect (`Modal presentationStyle="pageSheet"` + `KeyboardAvoidingView`, `Editor` sub-component at line 73 has 5 `TextInput`s: `name`, `endpoint`, `fingerprint`, `clientName`, `token`).
- Replace outer `Modal`/`KeyboardAvoidingView` (lines 31–32 region) with `GlassBottomSheet` the same way as Step 4: add `sheetRef = useRef<GlassBottomSheetHandle>(null)`; the component's own `visible` prop (passed in from `client/app/index.tsx:9`/wherever `ConnectionSheet` is rendered — confirm current call site accepts `visible` boolean) must still gate mount, so wrap: render `GlassBottomSheet` unconditionally once `visible` has ever been true (mount on first `visible=true`, keep mounted, call `sheetRef.current?.present()`/`.dismiss()` in a `useEffect` keyed on `visible`) — OR simplify: keep the component's external API (`visible` prop) unchanged, and internally do:
  ```tsx
  useEffect(() => {
    if (visible) sheetRef.current?.present();
    else sheetRef.current?.dismiss();
  }, [visible]);
  ```
  with `GlassBottomSheet` always mounted (not conditionally rendered) so the ref is always valid — this preserves the existing external contract (`visible: boolean` prop, no caller changes needed in `client/app/index.tsx`).
- Swap `Editor`'s inner `ScrollView` (line 92) for `BottomSheetScrollView`, and all 5 `TextInput`s in `Editor` for `BottomSheetTextInput` (same reasoning as Step 4 — keyboard-focus tracking).
- Replace `close()`'s manual `onDismiss()` call path: `GlassBottomSheet`'s `onDismiss` prop now calls the existing `close` function (line 21) directly — remove the header's `Done` `Pressable`'s separate manual close wiring only if it duplicates; keep `Done` button calling `close()` explicitly (still needed since sheet-close-via-button is a distinct trigger from swipe/backdrop-dismiss, both should funnel to the same `close` function to keep `editing` state reset consistent — this was already true in the original code at line 21, unchanged).
- Same light/dark palette treatment as Step 4: add `useColorScheme()`, replace hardcoded `#0A0A0A`/`#F0F0F0`/`#3A3A3A`/etc. (styles at `ConnectionSheet.tsx:112-190`, re-read exact style block before editing since only a partial excerpt was inspected this session) with the same `palette` shape as Step 4 (duplicate the small palette object in this file too — not worth extracting to a shared hook for two call sites per repo's "prefer direct, boring" convention (AGENTS.md) unless a third caller appears).
- Padding: apply the same `paddingHorizontal: 20` edge-safety to `styles.sheet`'s content areas (currently `padding: 20` per the excerpt at line 113 — likely already compliant; verify exact value on re-read and only change if less than 20px horizontal).

### Step 6 — Wrap the app root for `BottomSheetModal` support (prerequisite for Steps 4/5 to render without crashing)
In `client/app/_layout.tsx`, wrap the existing `<Stack />` tree:
```tsx
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
...
return (
  <GestureHandlerRootView style={{ flex: 1 }}>
    <BottomSheetModalProvider>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false, animation: 'fade' }} />
    </BottomSheetModalProvider>
  </GestureHandlerRootView>
);
```
`BottomSheetModalProvider` is required once at the app root for `BottomSheetModal`'s portal-based rendering to work (per library docs, confirmed) — no existing `GestureHandlerRootView` wrapper exists anywhere in `client/` (confirmed via repo-wide grep), so this is new, not a duplicate.
Also change `<StatusBar style="light" />` → `<StatusBar style="auto" />` — the current hardcoded `light` status-bar text only reads correctly against a dark background; once theming support exists (Step 7), `auto` tracks the resolved scheme so status-bar text stays legible in light mode too. This is the one non-sheet-scoped change in this plan, required because the "visible in both light and dark theme" acceptance criterion covers the whole screen the sheet appears over, not just the sheet.

### Step 7 — Enable actual light/dark switching (prerequisite for Steps 4/5's `useColorScheme()` to ever return `'light'`)
`client/app.json` currently sets `"userInterfaceStyle": "dark"`, which forces the OS-reported scheme to always be `dark` regardless of device setting (confirmed via Expo docs: `userInterfaceStyle` "restricts" the app to that appearance when set to `light`/`dark`, only `automatic` follows the system and lets `useColorScheme()` vary). Change `"userInterfaceStyle": "dark"` → `"userInterfaceStyle": "automatic"` in `client/app.json` (top-level `expo` key, currently at line 9) — without this change, Steps 4/5's `useColorScheme()` branch is unreachable dead code and the light-theme half of the acceptance criterion cannot be manually verified on-device at all.
Add `"expo-system-ui"` to `client/package.json` `dependencies` (any version compatible with SDK 57 — use `~57.0.2`, latest at time of writing) — required per Expo docs for `userInterfaceStyle: "automatic"`/`"light"`/`"dark"` to take effect on **Android** (iOS honors it natively without this package; omitting it silently no-ops the setting on Android only, which is exactly the platform this whole plan is about, so it is not optional). No config-plugin entry needed in `app.json`'s `"plugins"` array — `expo-system-ui` has no `app.plugin.js` (confirmed: package has no `files` restriction and ships no plugin file; auto-linked as a native module only).

## Critical files & anchors

- `client/src/components/AddSessionFAB.tsx` — full rewrite target; existing FAB/form logic (lines 12–101) stays, only the modal shell (lines 51–61) and styles (103–191) change per Step 4.
- `client/src/components/ConnectionSheet.tsx` — full rewrite target; re-read lines 1–192 in full before editing (only partial excerpts were read this session) since `Editor` sub-component internals (line 73+) weren't fully inspected.
- `client/app/_layout.tsx` — currently 8 lines total; Step 6's root-provider wrap is the entire remaining content of this file.
- `client/app.json` — two independent single-key edits: `android.softwareKeyboardLayoutMode` (Step 2) and top-level `userInterfaceStyle` (Step 7).
- `client/jest.config.js` — one-line `resolver` addition (Step 1); this was empirically verified this session (adding it fixed a reproduced crash; the crash was reproduced first without it).

## Verification

1. **Build check**: `cd client && bun run typecheck` — must pass with zero errors after all rewrites (new `BottomSheetModal`/`BottomSheetTextInput`/`BlurView` types resolve).
2. **Existing test suite, unmodified assertions**: `cd client && bun run test` — `terminal-route.test.tsx`'s `'terminal route multi mode'` describe block (renders `AddSessionFAB` inside multi-mode) and `ConnectionSheet.test.tsx` (renders `ConnectionSheet` directly, asserts `accessibilityLabel`-keyed `onPress` handlers for Select/Edit/Add/Delete) must still pass with zero changes to test files — this proves `sheetRef.current?.present()`-driven mounting doesn't break the existing `accessibilityLabel`-based `actionFor()` test helper pattern (button labels/handlers are unchanged, only the modal shell around them changed). If either test needs a `jest.mock('@gorhom/bottom-sheet', ...)` to avoid environment issues in the test renderer (e.g. `Portal`/`GestureHandlerRootView` absence in the bare `react-test-renderer` tree used by these tests — confirmed pattern: both test files use `react-test-renderer`'s `create()`, not RTL, and mock `react-native-safe-area-context` already), add exactly one line: `jest.mock('@gorhom/bottom-sheet', () => require('@gorhom/bottom-sheet/mock'));` at the top of each affected test file (the library ships this official mock at `@gorhom/bottom-sheet/mock`, confirmed present in the package source — it renders `children` directly for `BottomSheetModal`/`BottomSheet`/`BottomSheetView`, no additional mock authoring needed). Do not mock `expo-blur`; jest-expo's default Expo-module mocking already handles native modules it doesn't recognize (fallback to `View`-like render) — if `BlurView` causes a test failure, add `jest.mock('expo-blur', () => ({ BlurView: require('react-native').View }))` to the same two files, but only if the unmocked run actually fails (verify by running before adding).
3. **New-behavior manual proof (Android, criterion 1 — keyboard coverage)**: Launch the app via `bun run android` (or `expo start --android` per `client/package.json` scripts) against a paired daemon, open a connection with 2+ sessions to reach multi-session mode (`mode: 'multi'` route param, set by `client/app/index.tsx:138`'s `router.push`), tap the `+` FAB (`accessibilityLabel="Add session"`), tap the Name `TextInput` — observe: sheet expands upward, Name field's row scrolls to sit fully above the software keyboard's top edge, unobstructed. Repeat for `ConnectionSheet`'s Endpoint/Token fields (open via the daemon-list entry point in `client/app/index.tsx`).
4. **New-behavior manual proof (criterion 2 — glass style, both themes)**: With device set to Light mode, relaunch (or toggle via OS quick-settings while app is foregrounded, if `automatic` picks it up live — `useColorScheme()` does update live per React Native docs) — observe: sheet background is a light frosted-blur, header title/labels/accent color/handle-indicator are all legible against it, no element blends into the background; repeat with device in Dark mode — same check. Confirm on both passes that sheet content (labels, inputs, buttons) has visible horizontal margin from the screen's left/right edges (20px per Step 4/5) and the sheet's top edge (when expanded) sits below the status bar, never overlapping it.
5. Re-run 1–2 after Steps 4–7 are all applied (not incrementally) since Step 7's `useColorScheme()` reachability is a hard prerequisite for step 3/4's manual checks to be meaningful at all.

## Assumptions & contingencies

- **Scope includes `ConnectionSheet.tsx`**: the literal ask says "new session" but `ConnectionSheet` has the byte-identical defect. Included by default since AGENTS.md's "clean cutover" convention argues against leaving a visibly inconsistent second sheet pattern beside the new one. If the user wants `AddSessionFAB`-only, drop Step 5 and Step 6's rationale still holds (provider is needed for the one sheet either way).
- **`@callstack/liquid-glass` excluded**: per user decision (asked and answered this session) — it's iOS-26/Xcode-26-only, unsupported in Expo Go, and wouldn't touch the Android bug at all. `expo-blur` approximates the aesthetic cross-platform. If a future request specifically wants the literal native iOS effect, that requires a separate decision to drop Expo Go support project-wide — out of scope here, do not add speculative iOS-only branching now.
- **`userInterfaceStyle: "automatic"` changes app-wide theme behavior**, not just the sheets — this is required for the light-mode acceptance criterion to be reachable at all (today the app is hardcoded dark, so "both light and dark theme" is currently impossible to demonstrate). If the user wants theming scoped only to when the sheet is open (app otherwise force-dark), that's not a coherent option — `useColorScheme()` is global; flag this as the correct interpretation of the ask rather than an open question, since the alternative (force-dark everywhere but pretend the sheet supports light mode) can't be verified per the stated acceptance criteria.
- **Contrast literal for light-mode accent (`#0E8A96`)**: chosen without a designer review; if this looks off in practice, it's a paint-only follow-up (change the one hex literal in the `palette` object in `AddSessionFAB.tsx`/`ConnectionSheet.tsx`), not a structural change.
- **If `bun install` in Step 1 pulls a `@gorhom/bottom-sheet` version incompatible with `react-native-reanimated@4.5.0`** (peer range is `>=3.16.0 || >=4.0.0-`, confirmed compatible with 4.5.0) or with `react-native-gesture-handler@2.32.0` (peer range `>=2.16.1`, confirmed compatible) — no fallback needed, versions are confirmed compatible as of this session; if `bun install` still reports a peer-dependency conflict, that indicates a version drift since this plan was written — re-check `@gorhom/bottom-sheet`'s current peer ranges before pinning a different version, don't silently `--force`.
</content>
<parameter name="i">Persist approved plan to repo per rule 1