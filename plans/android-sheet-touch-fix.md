# Android bottom-sheet controls unusable — fix plan

<!-- source-branch: main -->
<!-- work-branch: omp/android-sheet-touch-fix -->

## Context

"Connect daemon" (empty-state button that opens `PairingSheet`) and "Daemons"/daemon-list controls (`ConnectionSheet`) are unusable on Android. Root cause: `@gorhom/bottom-sheet` v5 wraps all sheet content in a `GestureDetector` Pan gesture (drag-to-dismiss) via `BottomSheetDraggableView` (`node_modules/@gorhom/bottom-sheet/src/components/bottomSheet/BottomSheetContent.tsx:236-238`). On Android that pan gesture wins the touch-arena race against plain RN `Pressable`/`Switch`, so taps barely register — this is the library's own documented Android defect (gorhom.dev/react-native-bottom-sheet/troubleshooting: "wrapping the content and handle with TapGestureHandler & PanGestureHandler, any gesture interaction would not function as expected... use touchables that this library provide"). `BottomSheetTextInput`/`BottomSheetScrollView` already dodge this (they're `NativeViewGestureHandler`-wrapped); raw `Pressable`/`Switch` from `react-native` are not.

Three files render interactive controls directly inside a `GlassBottomSheet` (which wraps `BottomSheetModal`) using plain RN `Pressable`/`Switch`: `client/src/components/PairingSheet.tsx` (Connect daemon flow — the reported bug), `client/src/components/ConnectionSheet.tsx` (Daemons list — the reported bug), and `client/src/components/AddSessionFAB.tsx` (New Session sheet — same defect, not yet reported but broken identically; fixed per root-cause rule since it shares the exact code pattern). End state: every `Pressable`/`Switch` rendered as sheet content in these three files participates correctly in Android's touch arena and responds to taps reliably.

## Approach

All three edits are independent (different files, no shared state) — apply in any order.

1. **`client/src/components/PairingSheet.tsx`**: swap the `Pressable`/`Switch` import source from `react-native` to `react-native-gesture-handler`.
   - Line 2 currently: `import { Alert, Linking, Platform, Pressable, StyleSheet, Switch, Text, useColorScheme, View } from 'react-native';`
   - Replace with two lines:
     ```
     import { Alert, Linking, Platform, StyleSheet, Text, useColorScheme, View } from 'react-native';
     import { Pressable, Switch } from 'react-native-gesture-handler';
     ```
   - No other line in the file changes — RNGH's `Pressable`/`Switch` are drop-in API-compatible (same prop names: `onPress`, `disabled`, `accessibilityLabel`, `style` array/function, `onValueChange`, `value` — verified against `node_modules/react-native-gesture-handler/src/components/Pressable/PressableProps.tsx` and `node_modules/react-native-gesture-handler/src/components/GestureComponents.tsx:75-79`). Every existing `<Pressable ...>` and `<Switch ...>` usage in this file (lines 110, 120, 133, 158, 162, 167, 171, 175) keeps its JSX unchanged.

2. **`client/src/components/ConnectionSheet.tsx`**: same import swap.
   - Line 2 currently: `import { Alert, Pressable, StyleSheet, Switch, Text, useColorScheme, View } from 'react-native';`
   - Replace with:
     ```
     import { Alert, StyleSheet, Text, useColorScheme, View } from 'react-native';
     import { Pressable, Switch } from 'react-native-gesture-handler';
     ```
   - No other line changes. Existing `<Pressable>`/`<Switch>` usages (lines 49, 75, 76, 77, 81, 121, 123, 124) keep their JSX unchanged.

3. **`client/src/components/AddSessionFAB.tsx`**: same import swap (root-cause fix, same defect pattern, not narrowly scoped to only the two named symptoms).
   - Line 2 currently: `import { Alert, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';`
   - Replace with:
     ```
     import { Alert, StyleSheet, Text, useColorScheme, View } from 'react-native';
     import { Pressable } from 'react-native-gesture-handler';
     ```
   - (This file has no `Switch`.) No other line changes. Existing `<Pressable>` usages (lines 47, 68, 77, 88) keep their JSX unchanged.

Edge/failure handling: none needed — this is a pure import-source swap with an already-vetted API-compatible replacement; no new runtime branches, no new error paths.

Do NOT touch `GlassBottomSheet.tsx` (structural only, no `Pressable`/`Switch`), `app/index.tsx`'s `SessionCard`/topbar `Pressable`s (not inside any bottom sheet — plain screen content, unaffected), or `ShortcutKeyboard.tsx` (not inside a bottom sheet).

## Critical files & anchors

- `client/src/components/PairingSheet.tsx:2` — import line to split.
- `client/src/components/ConnectionSheet.tsx:2` — import line to split.
- `client/src/components/AddSessionFAB.tsx:2` — import line to split.
- `client/app/_layout.tsx` — already wraps the app in `GestureHandlerRootView` + `BottomSheetModalProvider` (commit `3d5494b`); no change needed, confirms RNGH's gesture arena is already rooted app-wide.
- `client/node_modules/@gorhom/bottom-sheet/mock.js` — jest mock for `@gorhom/bottom-sheet` (wired via `client/jest.config.js` `moduleNameMapper`); confirms bottom-sheet's own mock does NOT stub `Pressable`/`Switch` — those come straight from whatever module the app imports them from, so the swap takes effect under jest too.

## Verification

1. `cd client && bunx jest --runInBand src/components/PairingSheet.test.tsx src/components/ConnectionSheet.test.tsx` — both suites (15 tests) must still pass unchanged. These tests call `.props.onPress()` / `.props.onValueChange()` directly on found elements (prop introspection, not simulated native touch), so they exercise the same callback wiring regardless of which module `Pressable`/`Switch` come from — confirms the swap didn't break existing behavior contracts.
2. `cd client && bun run typecheck` — confirms `react-native-gesture-handler`'s `Pressable`/`Switch` typings satisfy every existing prop usage (style arrays/functions, `disabled`, `accessibilityLabel`, `onValueChange`, `value`) with zero new type errors.
3. **Exercises the new behavior (the actual Android fix)**: no Android device/emulator is available in this environment (`adb devices` empty, no `ANDROID_HOME`/`ANDROID_SDK_ROOT`, no local Android build tooling installed) — physical on-device tap verification is not reachable here. In lieu of that, the fix's correctness rests on: (a) `react-native-gesture-handler`'s `Pressable`/`Switch` being built on `GestureDetector`/`Gesture.Native()` (see `node_modules/react-native-gesture-handler/src/components/Pressable/Pressable.tsx:384-405`, `node_modules/react-native-gesture-handler/src/components/GestureComponents.tsx:75-79`), which is the exact mechanism gorhom's own troubleshooting doc prescribes as the fix for "any gesture interaction" (including plain Touchables) inside a `BottomSheet`; and (b) `GestureHandlerRootView` already wraps the app root, satisfying the one prerequisite RNGH's gesture-based components need to function. State this gap explicitly rather than claiming on-device proof: **if a build/device becomes available, the concrete manual check is**: build+install the Android APK (`make client-build-android`, per `docs/android-daemon-connect.md`), open the app, tap "Connect daemon" then "Scan QR code"/"Connect" and confirm the tap registers on a single touch (not "barely clickable"/needing a hard press), and in "Daemons" tap "Select"/"Edit"/"Delete" and toggle "Skip fingerprint verification" confirming each responds to a single tap.

## Assumptions & contingencies

- Assumed the fix is exhaustive for "unusable" (single-tap not registering / feels dead) rather than a crash or blank sheet — nothing in the codebase (jest mock, GlassBottomSheet wiring, `_layout.tsx` provider setup) suggests a mount-time crash; the gorhom troubleshooting doc and GitHub issue #58 describe exactly "barely clickable"/needs a hard press, matching "unusable" as reported.
- No Android device/emulator/SDK is present in this environment, so step 3 of Verification cannot produce on-device proof this iteration — tests/typecheck confirm the code compiles and existing contracts hold; the manual on-device check is documented for whoever has device access next. If this is unacceptable ("must prove on-device before finishing"), the concrete unblock is provisioning `ANDROID_HOME`/an emulator or a physical device with `adb` — not a code change.

