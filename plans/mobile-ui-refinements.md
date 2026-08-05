# Mobile UI Refinements: Safe Area Fix + Sticky Keyboard Accessory

<!-- source-branch: main -->
<!-- work-branch: omp/mobile-ui-refinements -->

## Context

The agenticRemote Expo client has two UI issues on mobile devices: (1) modal screens (`PairingSheet`, `ConnectionSheet`) lack safe area insets on Android where `presentationStyle="pageSheet"` is ignored, causing headers/buttons to collide with the system status bar; and (2) the `ShortcutKeyboard` panel renders inline in the flex layout rather than docking above the native keyboard, forcing users to dismiss the keyboard to access shortcuts. The goal is to apply safe area padding to all modal views on all platforms, and to make `ShortcutKeyboard` act as a sticky keyboard accessory that slides up with the native keyboard.

## Approach

### Step 1: Fix modal safe area insets (independent of Step 2)

**Problem**: `PairingSheet` (line 139, `styles.sheet` = `padding: 20`) and `ConnectionSheet` (line 30, `styles.sheet` = `padding: 20`) use `presentationStyle="pageSheet"` which provides safe areas on iOS but is silently ignored on Android. On Android, modal content starts at the very top of the screen behind the status bar. `AddSessionFAB` already handles this correctly with `paddingTop: insets.top`.

**Edits**:

1. **`client/src/components/PairingSheet.tsx`** — Import `useSafeAreaInsets` from `react-native-safe-area-context`. In `PairingSheet`, call `const insets = useSafeAreaInsets()`. On the root `<View style={styles.sheet}>` (line 139), add `paddingTop: Math.max(insets.top, 20)` as an inline style override. This replaces only the top padding; the static `padding: 20` in the stylesheet still covers left/right/bottom. On iOS with `pageSheet`, `insets.top` is typically 0, so `Math.max(insets.top, 20)` preserves the existing 20px. On Android, it pushes content below the status bar.

2. **`client/src/components/ConnectionSheet.tsx`** — Same pattern: import `useSafeAreaInsets`, call it in `ConnectionSheet`, add `paddingTop: Math.max(insets.top, 20)` inline on the root `<View style={styles.sheet}>` (line 30). The `Editor` sub-component lives inside this same View, so it inherits the padding — no separate fix needed.

No changes to `index.tsx`, `terminal/[id].tsx`, `files.tsx`, or `AddSessionFAB.tsx` — these already apply `useSafeAreaInsets()` correctly.

### Step 2: Sticky keyboard accessory panel (depends on Step 1 only for testing context)

**Problem**: `ShortcutKeyboard` renders as an inline sibling below the terminal in the flex layout. On iOS, `KeyboardAvoidingView` with `behavior="padding"` pushes the layout up so the shortcut panel is visible above the keyboard. On Android, no `KeyboardAvoidingView` is used — the keyboard covers the bottom of the screen and the shortcut panel is hidden behind it.

**Strategy**: Use `KeyboardAvoidingView` on both iOS and Android (web uses plain `View`). On Android, `behavior="height"` shrinks the container height, which triggers the WebView's `ResizeObserver` → `FitAddon.fit()` → PTY reflow.

**Summary of actual file changes**:
- `client/src/components/PairingSheet.tsx` — add `useSafeAreaInsets` + `paddingTop: Math.max(insets.top, 20)`
- `client/src/components/ConnectionSheet.tsx` — add `useSafeAreaInsets` + `paddingTop: Math.max(insets.top, 20)`
- `client/app/terminal/[id].tsx` — change `Wrapper` to use `KeyboardAvoidingView` on Android too (not just iOS), with `behavior: 'height'`

Three files, three edits. No new dependencies.
