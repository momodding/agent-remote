# android-touch-apk
<!-- source-branch: main -->
<!-- work-branch: omp/android-touch-apk -->

## Context
Motorola Moto G45 report: every Android control ignores taps and content lacks system-bar padding. Prior changes already wrapped the Expo Router stack in `GestureHandlerRootView`, changed all app controls from React Native `Pressable`/`Switch` to react-native-gesture-handler variants, and upgraded `react-native-safe-area-context` to 5.8.1, but user reports the installed APK remains broken. End state: controls use the platform touch path unless a gesture-handler component is required by a gesture surface, each route owns explicit safe-area layout, and a newly built preview APK proves a real Android tap opens the pairing sheet while content stays outside system bars.

## Approach
1. Restore the correct touch implementation per surface instead of forcing one press primitive app-wide.
   - In `client/app/index.tsx`, `client/app/files.tsx`, `client/app/terminal/[id].tsx`, `client/src/components/MultiTerminal.tsx`, and `client/src/components/ShortcutKeyboard.tsx`, import `Pressable` from `react-native`. These controls are ordinary route content; React Native's responder is the shortest native path and avoids the documented RNGH `Pressable` failure mode where Android release builds can stop dispatching `onPress` app-wide.
   - In `client/src/components/AddSessionFAB.tsx`, keep the outer `Add session` FAB as React Native `Pressable`, but replace every control rendered inside `GlassBottomSheet` with `TouchableOpacity` imported from `@gorhom/bottom-sheet`: `Default shell`, each shell choice, and `Create`. In `client/src/components/PairingSheet.tsx` and `client/src/components/ConnectionSheet.tsx`, replace each sheet-contained `Pressable` with the same bottom-sheet `TouchableOpacity`; keep `Switch` from `react-native-gesture-handler`. This exactly follows @gorhom/bottom-sheet's Android rule that controls under its tap/pan handlers use the touchables it exports.
   - Preserve all current handlers, `disabled` values, accessibility labels, and visual styles. Add missing `accessibilityLabel="Connect daemon"` to the empty-state trigger and `accessibilityLabel="Connect"` to the pairing submit control so APK automation targets native accessibility nodes, not coordinates or visible-text heuristics. Use `activeOpacity={0.7}` on sheet touchables only where pressed-state feedback would otherwise disappear; do not introduce a wrapper component or dependency.
   - Update `client/src/components/MultiTerminal.test.tsx` by removing its now-unused `react-native-gesture-handler` `Pressable` mock. Existing route/sheet tests continue invoking the unchanged `onPress` contracts; add one dashboard case with `loadConnections()` returning `{ connections: [], selectedEndpoint: null }`, tap `Connect daemon`, and assert the captured `PairingSheet.visible` changes from `false` to `true`.

2. Move system-bar layout to native safe-area consumers and wire insets into components that need numeric values.
   - In `client/app/index.tsx` and `client/app/files.tsx`, import `SafeAreaView` from `react-native-safe-area-context` and use it as each full-screen container with default four-edge padding. Delete the matching `useSafeAreaInsets()` calls and inline `paddingTop`/`paddingBottom`/`paddingLeft`/`paddingRight` objects. Keep existing base styles such as `styles.empty.padding = 28`: native `SafeAreaView` uses additive padding, so design spacing remains and system insets are added rather than replacing it. Loading state also uses the four-edge `SafeAreaView`; no special failure behavior is needed because Expo Router already mounts the one app-level `SafeAreaProvider` in `ExpoRoot.js`.
   - In `client/app/terminal/[id].tsx`, keep `useSafeAreaInsets()` because `ShortcutKeyboard`, `MultiTerminal`, and the FAB need numeric bottom inset. Replace the route wrapper `View` with `SafeAreaView edges={['top', 'left', 'right']}` and remove computed top/left/right padding from `wrapperProps`; bottom remains owned by the absolute shortcut keyboard so it is not applied twice. Pass `bottomInset={insets.bottom}` to the existing optional `MultiTerminal` prop. Extend `AddSessionFAB`'s `Props` with required `bottomInset: number`, pass it from this sole callsite, and change FAB position to `bottom: 20 + bottomInset` so the 56dp target never sits behind Android navigation controls.
   - In `client/src/components/GlassBottomSheet.tsx`, pass `topInset={insets.top}` and `bottomInset={insets.bottom}` to `BottomSheetModal`, and calculate `maxDynamicContentSize={screenHeight - insets.top - insets.bottom - 24}`. This reuses the library's dedicated inset inputs and keeps the sheet body plus its touch targets out of both system bars.
   - Do not add another `SafeAreaProvider`, hard-code Moto G45/status-bar dimensions, or invent a nonzero inset fallback. Expo Router already provides the provider; Android gesture navigation may legitimately report a zero bottom inset. Keep `react-native-safe-area-context` at current latest `5.8.1`; npm metadata confirms no `5.9.x` exists.

3. Make the preview APK itself the behavioral proof.
   - Build from the fixed commit with existing `make client-build-android`; `Makefile` already produces release-like `builds/client-android.apk` through EAS profile `preview`, and `client/eas.json` fixes that profile to `android.buildType = "apk"`.
   - Install this newly built artifact with `adb install -r builds/client-android.apk` on the connected Motorola Moto G45, clear saved app data so dashboard starts in the unpaired empty state, launch package `com.paperplain.agenticremote`, and use `adb shell uiautomator` to verify actual native transitions: node `Connect daemon` exists and is clickable; a tap on its node produces sheet node `Connect`; a tap on sheet node `cancel-pairing` removes the sheet; reopening and tapping `Scan QR code` produces one of the camera permission/readiness nodes (`allow-camera`, `open-camera-settings`, camera surface, or `retry-camera`). Those state changes prove handlers fired—`clickable=true` alone is insufficient.
   - Capture a post-launch screenshot and UI hierarchy. Confirm dashboard content bounds begin below status-bar bounds; after opening the sheet, confirm its lowest clickable node ends above navigation-bar/gesture-region bounds. Use hierarchy bounds/system-bar insets, not visual judgment alone. Record `aapt dump badging` output and APK SHA-256 alongside results so the tested package/version/artifact is unambiguous.

## Critical files & anchors
- `client/app/index.tsx` — `Dashboard` empty-state trigger and three full-screen branches; primary real-tap APK probe and native safe-area migration.
- `client/src/components/PairingSheet.tsx` — all controls live inside `BottomSheetScrollView`; must use @gorhom/bottom-sheet touchables on Android.
- `client/src/components/GlassBottomSheet.tsx` — `BottomSheetModal` owns top/bottom inset constraints for all three sheets.
- `client/app/terminal/[id].tsx` — sole `MultiTerminal`/`AddSessionFAB` callsites and explicit split between top/side and bottom inset ownership.
- `Makefile` — `client-build-android` produces the exact preview APK later installed and tested.

## Verification
1. JS contracts, from repo root:
   - `cd client && bun run typecheck` — all changed import/prop contracts compile.
   - `cd client && bun run test -- --runInBand` — existing route, sheet, shortcut, and multi-terminal behavior remains green; new dashboard test proves tapping `Connect daemon` sets `PairingSheet.visible=true`.
2. APK creation and identity, from repo root with Java and Android SDK installed:
   - `ANDROID_HOME="$HOME/android-sdk" ANDROID_SDK_ROOT="$HOME/android-sdk" make client-build-android`
   - `$ANDROID_HOME/build-tools/36.0.0/aapt dump badging builds/client-android.apk | sed -n '1,8p'` must report package `com.paperplain.agenticremote`, `targetSdkVersion:'36'`, and an incremented EAS `versionCode` for the new build.
   - `sha256sum builds/client-android.apk` — save digest with test output.
3. Real Android touch/padding proof on Moto G45, with USB debugging enabled and exactly one `adb devices -l` entry:
   - `adb install -r builds/client-android.apk`; `adb shell pm clear com.paperplain.agenticremote`; `adb shell monkey -p com.paperplain.agenticremote -c android.intent.category.LAUNCHER 1`.
   - Dump hierarchy after each action with `adb shell uiautomator dump /sdcard/window.xml` and `adb pull /sdcard/window.xml builds/`. Locate nodes by exact accessibility text/content description (`Connect daemon`, `Connect`, `cancel-pairing`, `Scan QR code`), compute each node's center from its `[left,top][right,bottom]` bounds, then issue `adb shell input tap X Y`.
   - Expected sequence: empty dashboard → tap `Connect daemon` → pairing sheet with `Connect` and `cancel-pairing` nodes → tap `cancel-pairing` → sheet nodes absent → reopen → tap `Scan QR code` → camera permission/readiness UI changes. Any missing transition fails touch verification.
   - Capture `adb exec-out screencap -p > builds/moto-g45-android-touch.png` and `adb shell dumpsys window`/hierarchy bounds. Expected: dashboard's first content node is below status bar; pairing sheet's lowest clickable node is above navigation/gesture region. Test once with gesture navigation and, if device is configured for 3-button navigation, once in that current mode—never change user's navigation setting automatically.
4. If Moto G45 is unavailable, install and run the same APK/sequence on an API 36 emulator as provisional proof, but leave Moto G45 verification incomplete; emulator success must not be reported as device verification. Current workstation has `adb`, SDK platform/build-tools, and KVM but no emulator binary/system image, so execution must install those SDK packages before this fallback.

## Assumptions & contingencies
- Preview APK is the requested artifact; Expo Go and development-client behavior do not satisfy verification because reported failures can differ in Android release builds.
- Device starts unpaired after `pm clear`; if Android blocks clearing app data, uninstall/reinstall the new APK, then repeat. Do not reuse the existing `builds/client-android.apk`: its versionCode is 7 and it predates this plan's source changes.
- If the first fresh preview APK still shows no `Connect daemon` touch transition, temporarily instrument only that button with `onPressIn`/`onPressOut` logs, capture `adb logcat`, and classify before changing more code: no `onPressIn` means an overlay/native interception; `onPressIn` without `onPress` means responder cancellation. Remove instrumentation after diagnosis and rebuild/retest the APK.
- If `SafeAreaView` still receives zero top inset in the new APK, capture `adb shell dumpsys window` plus hierarchy/screenshot and treat it as an upstream RN/safe-area-context reproduction. Do not ship arbitrary fixed padding; the device may use gesture navigation where bottom inset zero is valid.


## Result (executed)
All code changes and JS verification complete; APK built and identity-checked. Device verification blocked: no physical Android device attached, and the software (`-accel off`) x86_64 emulator fallback proved impractical on this host — attempted for over 3 hours across two boot attempts (once under heavy build CPU contention, once with a clean host) and never reached `adb shell` responsiveness. Root cause: no `kvm` group membership for the invoking user (`sudo usermod -aG kvm` requires an interactive password unavailable in this session) forces TCG software virtualization; TCG additionally logs `CPUID.01H:ECX.avx`/`f16c` as unsupported on this host CPU, so Android's x86_64 system image runs far slower than the typical unaccelerated 20-40 min estimate. Per this plan's own provisional-fallback clause (`## Approach`, step 3, item 4), emulator unavailability is an explicitly allowed stopping point; Moto G45 physical-device verification (real tap dispatch, safe-area bounds vs status/nav bars) remains **incomplete** and requires either the physical device or `kvm` group access + re-login on this workstation.

Completed:
- Touch primitives restored per-surface (RN `Pressable` for routes, `@gorhom/bottom-sheet` `TouchableOpacity` inside sheets, `Switch` kept on `react-native-gesture-handler`).
- Safe-area layout wired per route/sheet as specified.
- `bun run typecheck` clean; `bun run test --runInBand` 114/114 passing across 12 suites.
- `make client-build-android` succeeded: `builds/client-android.apk`, package `com.paperplain.agenticremote`, `versionCode='7'`, `versionName='1.0.0'`, `targetSdkVersion='36'`, `minSdk='24'`.
- SHA-256: `e1cb5bd2ab6221d1d7abe7374ed841ed43dcfa66b4cdef83d8bc6f00b923632c`

Not completed (blocked, not skipped):
- `adb install`/`pm clear`/launch on a real device.
- `uiautomator` tap-sequence proof (`Connect daemon` → `Connect`/`cancel-pairing` → `Scan QR code`).
- Screenshot + hierarchy-bounds check against status/navigation bars.

## Result (native pairing modal revision)
User reported the first-page `Connect daemon` control still appeared inert with the prior APK. JS tracing showed the RN `Pressable` handler updates `pairingOpen`, but the dashboard test mocked `PairingSheet` to `null`, so it never exercised `BottomSheetModal.present()`. The first pairing surface now uses React Native's native `Modal`, `Pressable`, `ScrollView`, `TextInput`, and `Switch`, removing Reanimated, portal, and gesture-handler presentation from the only path needed to leave the first page. Existing `@gorhom/bottom-sheet` components remain unchanged for post-pairing flows.

Observed:
- `bun run typecheck` exits zero.
- `bunx jest src/dashboard-route.test.tsx --runInBand`: 8/8 passing, exit zero.
- `bunx jest src/components/PairingSheet.test.tsx --runInBand`: 11/11 passing, exit zero.
- Required full command `bun run test -- --runInBand`: 12/12 suites and 114/114 tests passing, exit zero. Jest setup installs a stable mocked `fetch` after `jest-expo` setup, preventing Expo's lazy native fetch getter from loading after suite teardown.
- Superseded pre-HTTPS-policy APK: SHA-256 `50de72d176b317c2b772e2f9b1a1bf530c63503568863985a63c579a2723f377`.

HTTPS-only correction:
- Removed Android cleartext manifest opt-in and all automatic HTTPS→HTTP / WSS→WS pairing downgrade behavior.
- Pairing and saved connections now require HTTPS; Android platform TLS trust remains mandatory even when `skipFingerprintVerification` is set.
- `bun run typecheck` exits zero; `bun run test -- --runInBand`: 12/12 suites and 82/82 tests passing, exit zero.
- Rebuilt final APK: `builds/client-android.apk`, timestamp `2026-08-10 11:47:34 +0700`, size `51606118`, package `com.paperplain.agenticremote`, `versionCode='8'`, `versionName='1.0.0'`, `minSdkVersion='24'`, `targetSdkVersion='36'`, SHA-256 `eb0e33736051be3220600c6594f667822fb54a88d1ff234153ed300369d2125c`.

Still blocked:
- No device appears in `adb devices -l`; install, `uiautomator` transition proof, and system-bar bounds verification remain incomplete.