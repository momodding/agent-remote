<!-- source-branch: main -->
<!-- work-branch: omp/android-padding-fix -->
# android-padding-fix

## Context
Bug report (Moto G45): (1) buttons not clickable, (2) no padding on Android.

(1) already fixed, commit `202e9b8` (`android-sheet-touch-fix`): Pressable/Switch → `react-native-gesture-handler` variants in `PairingSheet.tsx`, `ConnectionSheet.tsx`, `AddSessionFAB.tsx`. No action needed.

(2) root cause: `useSafeAreaInsets()` (used in `client/app/index.tsx:145-148` and `client/app/terminal/[id].tsx`) resolves top/bottom/left/right to 0 on-device, so content sits flush under status bar / behind nav bar.

Installed: `react-native@0.86.0`, `expo@57.0.7`, `react-native-safe-area-context@5.7.0`.

- `edgeToEdgeEnabled` is gone from Expo config (Android 16 forces edge-to-edge always-on) — not a lever, confirmed via `@expo/prebuild-config`'s `withEdgeToEdge.js`.
- RN 0.86 (already installed) ships "comprehensive fixes for Android 15+ edge-to-edge mode ... including when it's enforced by the OS but not explicitly enabled" (official RN 0.86 blog), authored in large part by zoontek — the same maintainer of the community `react-native-edge-to-edge` package. Core absorbed that fix. Installing `react-native-edge-to-edge` or `expo-navigation-bar` on top would be redundant duplication of what core now does — rejected.
- `react-native-safe-area-context@5.7.0` predates that RN 0.86 core work and was never validated against it. `5.8.1` (2026-08-03 changelog) explicitly re-validates against newer RN core and fixes "skip Fabric SafeAreaView state updates while detached from window" — the exact bug class (stale/zero insets under New Architecture) matching this symptom.
- No bare `android/` — managed Expo workflow, so the fix is dependency-version-only, no native/config-plugin surface available anyway.

## Approach
1. `client/package.json`: bump `"react-native-safe-area-context": "~5.7.0"` → `"~5.8.1"`.
2. Reinstall (`npx expo install --fix` or `npm install` in `client/`).
3. No app.json/plugin changes. No new dependency. No code changes — `useSafeAreaInsets()` call sites are already correct; they pick up real insets once the native module matches RN 0.86.

## Files & anchors
- `client/package.json` — one dependency version line.

## Verification
- No adb/emulator in this environment — cannot reproduce on-device here.
- Run `make client-build-web` (or equivalent lint/typecheck) to confirm the bump doesn't break the build.
- User rebuilds dev client / EAS build and confirms on the Moto G45 that top/bottom/left/right padding now renders.

<!-- ponytail: ceiling — if 5.8.1 still reports 0 insets on that exact device/OS build, escalate by filing against upstream `react-native-safe-area-context` (RN 0.86 + 5.8.1 repro), not by adding a config-plugin path; that surface is already ruled out. -->
