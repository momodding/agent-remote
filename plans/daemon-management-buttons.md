<!-- omp-source-branch: main -->
<!-- omp-work-branch: omp/daemon-management-buttons -->

## Context

Daemon management is broken: opening "Daemons" from the dashboard shows no sheet at all, so add/edit/delete are all unreachable. Root cause, confirmed by reproduction: `client/src/components/ConnectionSheet.tsx` presents through `GlassBottomSheet` (`client/src/components/GlassBottomSheet.tsx`), a wrapper around `@gorhom/bottom-sheet`'s `BottomSheetModal`. Calling `sheetRef.current?.present()` produces **zero DOM change** — reproduced by seeding `client/src/lib/connection.ts`'s storage key with a connection, loading the dashboard, and clicking the "Daemons" action (`client/app/index.tsx:149`, `setDaemonsOpen(true)`): no new node appears anywhere in `document.body`, confirmed by diffing full body HTML and enumerating `body > div` children before/after the click.

## Approach

1. Rewrite `client/src/components/ConnectionSheet.tsx` to present through core React Native `Modal` instead of `GlassBottomSheet`, mirroring the exact structure already working in `client/src/components/PairingSheet.tsx` (`Modal` → `SafeAreaView` (from `react-native-safe-area-context`) → `KeyboardAvoidingView` (`behavior={Platform.OS === 'ios' ? 'padding' : undefined}`) → `ScrollView` (`keyboardShouldPersistTaps="handled"`)). Concretely:
   - Imports: from `'react-native'` take `Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, useColorScheme, View, ActivityIndicator`; keep `SafeAreaView` from `'react-native-safe-area-context'`; keep `Feather` from `'@expo/vector-icons/Feather'`. Delete the `GlassBottomSheet`/`GlassBottomSheetHandle` import, the `Switch` import from `'react-native-gesture-handler'`, and the `BottomSheetScrollView`/`BottomSheetTextInput`/`BottomSheetView`/`TouchableOpacity` import from `'@gorhom/bottom-sheet'`.
   - Delete `sheetRef` (`useRef<GlassBottomSheetHandle>`) and its `useEffect` that calls `present()`/`dismiss()` — `Modal`'s own `visible` prop replaces both.
   - Top-level return becomes `<Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}><SafeAreaView style={[styles.sheet, { backgroundColor: ... }]}><KeyboardAvoidingView style={styles.sheet} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView contentContainerStyle={...} keyboardShouldPersistTaps="handled">...</ScrollView></KeyboardAvoidingView></SafeAreaView></Modal>`. Add an explicit header row with a `Text` title "Daemon connections" (previously supplied to `GlassBottomSheet`'s `title` prop, which no longer exists) plus the `Done` control, matching `PairingSheet`'s `titleRow` pattern.
   - Replace every `BottomSheetScrollView` with `ScrollView`, every `BottomSheetTextInput` with `TextInput`, every `BottomSheetView` with `View`, and every gorhom `TouchableOpacity` with core `Pressable` (7 total: `Done`, per-row `Select <endpoint>`/`Edit <endpoint>`/`Delete <endpoint>`, `Add daemon`, `Cancel edit`, `Save`). Replace the RNGH `Switch` with core `Switch` from `'react-native'` for `Skip fingerprint verification`.
   - Preserve exactly: all current accessibility labels, `disabled={saving}` on Save, the `ActivityIndicator`/`Feather name="save"` conditional inside Save, all Feather icon names/sizes/colors, the `remove()` confirmation `Alert.alert` (unchanged), and the `Editor` component's field prefill/onSave/error-alert logic (unchanged) — only the presentation and control primitives change. Do not touch `client/app/index.tsx` or `client/src/lib/connection.ts`; their handler signatures (`onSelect(endpoint)`, `onSave(originalEndpoint, replacement)`, `onDelete(endpoint)`, `onAdd()`) already match this component's `Props` and stay unchanged.
   - Explicitly out of scope: `client/src/components/AddSessionFAB.tsx` also renders through `GlassBottomSheet` and likely has the same non-presenting-sheet defect, but the user's ask is limited to daemon connection management; leave it and `GlassBottomSheet.tsx` untouched.

2. Update `client/src/components/ConnectionSheet.test.tsx` so the suite exercises the new `Modal`-based tree and asserts native control ownership, not just callback wiring:
   - Change the safe-area mock from `jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({...}) }))` to `jest.mock("react-native-safe-area-context", () => ({ SafeAreaView: jest.requireActual("react-native").View }))`, matching `client/src/components/PairingSheet.test.tsx:4-6` exactly (the component no longer calls the hook; it renders the `SafeAreaView` component).
   - Import `Modal, Pressable, Switch` from `'react-native'` in the test file. Add one assertion per existing `describe` block's first test confirming `tree.root.findAllByType(Modal).length` is `1`, and that each located action node's `.type === Pressable` (for `Select`, `Edit`, `Delete`, `Add daemon`, `Cancel edit`, `Save`, `Done`) and the `Skip fingerprint verification` control's `.type === Switch`. This makes any reintroduction of `@gorhom/bottom-sheet`/`react-native-gesture-handler` controls fail the suite even if `onPress`/`onValueChange` wiring is technically intact.
   - Keep all existing behavioral assertions (`onSelect`/`onSave`/`onDelete`/`onAdd` call args, delete confirmation via `Alert.alert`, field prefill, masked token, rejected-save alert) unchanged; they exercise the same callback contract regardless of presentation.

## Critical files & anchors

- `client/src/components/ConnectionSheet.tsx` — full rewrite target; current imports at lines 1–9, list actions at lines 49–87, `Editor` at lines 91–131, styles at 133–152.
- `client/src/components/PairingSheet.tsx:1-10,157-189` — exact working `Modal`/`SafeAreaView`/`KeyboardAvoidingView`/`ScrollView` structure and header/title-row pattern to copy.
- `client/src/components/PairingSheet.test.tsx:1-6` — exact safe-area-context mock shape to copy into `ConnectionSheet.test.tsx`.
- `client/src/components/ConnectionSheet.test.tsx` — `makeProps`/`renderSheet`/`actionFor` helpers and existing suites; extend, do not replace, the callback assertions.
- `plans/android-touch-apk.md` ("Result (native pairing modal revision)", near end of file) — prior diagnosis and fix of this identical `GlassBottomSheet`-does-not-present failure for `PairingSheet`; do not re-derive, apply the same fix to `ConnectionSheet`.

## Verification

Run from repository root:

1. `make client-test` — must pass `bun run typecheck` and the full Jest suite, including the new `Modal`/`Pressable`/`Switch` type assertions in `ConnectionSheet.test.tsx` and all existing callback-behavior assertions (Select/Edit/Delete/Add/Save/Cancel/Done, delete confirmation, field prefill, masked token, rejected-save alert).
2. `make client-build-web` — must complete the Expo web export with the new imports.
3. `make lint` — must pass backend `go vet ./...` and client typecheck.
4. New-behavior reproduction (exercises the actual reported defect, not just unit assertions): start the app on web (`cd client && BROWSER=none npx expo start --web --port 8081`), seed one connection into `localStorage` key `agenticremote.connection` with a valid `Connection` JSON matching the shape in `client/src/lib/connection.ts` (`name`, `endpoint` as an `https://` origin, `fingerprint`, `skipFingerprintVerification`, `token`, `clientName`), reload, click the `Daemons` action (`accessibilityLabel="Daemons"`). Expected: the "Daemon connections" modal now appears in the DOM (it did not before this fix) with the seeded row and its `Select`/`Edit`/`Delete` controls, `Add daemon` opens the pairing flow, `Edit` opens the field editor prefilled from the seeded row, `Save` persists, `Delete` confirms and removes, `Done` closes the modal.

## Assumptions & contingencies

- `AddSessionFAB.tsx` and its `GlassBottomSheet` presentation are left unmodified; if it turns out to share the identical non-presenting-modal defect, that is a separate follow-up outside this daemon-management-only request.
- `GlassBottomSheet.tsx` itself is left unmodified (still used by `AddSessionFAB`); this plan does not investigate or fix why `BottomSheetModal.present()` produces no DOM node — it routes `ConnectionSheet` around that broken path entirely, matching the fix already applied to `PairingSheet`.
