<!-- source-branch: main -->
<!-- work-branch: omp/android-app-plan -->

## Context
Build the Flutter client as an Android app version of agenticRemote, using the existing `client/android` scaffold instead of creating a second client. The current repo already contains Android platform files, Flutter mobile-only dependencies (`mobile_scanner`, `image_picker`), and standard Flutter build targets, but no Android-specific execution path is documented or verified. The end state is a decision-complete execution plan that produces a runnable Android debug build, fixes any Android-only blockers in the existing client, and verifies the pairing/dashboard flow on an Android emulator.

## Approach
### 1. Prove the current Android scaffold can be built
- From `client/`, run the existing Flutter mobile toolchain against the checked-in Android scaffold under `client/android` rather than generating a new platform project.
- Use the available Android emulator IDs reported by `flutter emulators` (`byobudash-api35-arm64` first, `byobudash-api35` fallback) to verify the app can launch on Android; this avoids inventing device setup work that the workstation already has.
- If `flutter build apk` or `flutter run -d <emulator>` fails before Dart code runs, fix only the concrete Android packaging/config blocker that the command reports. Reuse the existing Flutter defaults in `client/android/app/build.gradle.kts` unless the failure proves they are insufficient.
- Scope boundary: do not add release signing, Play Store metadata, flavors, CI, or a separate native app shell; the ask is an Android app build of the existing client.

### 2. Fix Android-specific runtime blockers in the existing Flutter client
- Audit the current mobile-only paths already present in the client and keep the existing cross-platform pattern: `kIsWeb` gates in `client/lib/src/features/dashboard/session_dashboard.dart` and `client/lib/src/services/agentic_remote_api.dart` show the app is meant to stay one codepath with small platform branches, not per-platform feature forks.
- Keep QR pairing on Android through the existing `MobileScanner` widget in `_PairingPanel` (`client/lib/src/features/dashboard/session_dashboard.dart`); do not replace it with file/manual-only pairing on mobile unless emulator testing proves the camera path is unusable.
- If Android build or runtime errors stem from plugin integration, add the minimum required Android manifest/Gradle changes in the existing scaffold. Current manifest anchor: `client/android/app/src/main/AndroidManifest.xml` `application` + `MainActivity`; current Gradle anchor: `client/android/app/build.gradle.kts` `defaultConfig` and `buildTypes`.
- If the Android path needs permissions for scanner or picker plugins, declare only the permissions required by the code paths already in use. Confirm the exact plugin requirement from the existing dependency’s generated failure or manifest merge output before editing; unverified — confirm first.
- Preserve the current app entrypoint (`client/lib/main.dart` → `SessionDashboard(state: AppState())`). No Android-only alternate home screen, routing layer, or state container.

### 3. Verify the Android app actually runs the requested product behavior
- Launch the emulator and run the app with `flutter run -d <resolved-emulator-id>` from `client/`.
- Verify the observable Android behaviors that define “Android app version”: app launches into the existing dashboard UI, the pairing card renders, the Connect button is present, and the Scan QR button is visible on Android because `_PairingPanel` only hides it on web (`if (!kIsWeb)`).
- Exercise at least one Android-specific path end to end: open the QR scanner panel and confirm the `MobileScanner` preview renders without crashing the app. If the emulator lacks a usable virtual camera, the fallback acceptance is that the scanner panel opens and the app stays stable; note the camera limitation in the implementation result, not in code.
- Run `flutter build apk --debug` after the runtime smoke test so the final proof includes a concrete APK artifact path under `client/build/app/outputs/flutter-apk/`.

### 4. Keep the repo’s documented build surface aligned with the Android capability
- Update the root `Makefile` only if Android build proof requires a stable shortcut beyond existing Flutter commands. Current targets include `client-build-web` but no Android target.
- Preferred change if needed: add one boring target such as `client-build-android-debug` that runs `cd client && flutter build apk --debug`; avoid wrappers, env detection, or multiple flavor targets.
- Update `client/README.md` only for the exact commands needed to build/run Android locally, replacing the Flutter starter text if it remains untouched by the time implementation finishes. Keep it short: prerequisites already implied by Flutter tooling, exact emulator/build commands, and where the APK lands.
- If the Android build succeeds without needing a Makefile helper, documentation alone is sufficient; do not add command aliases just to mirror web.

## Critical files & anchors
- `client/android/app/build.gradle.kts` — `android { defaultConfig ... buildTypes ... }`; first place to fix Android package/build configuration reported by Flutter.
- `client/android/app/src/main/AndroidManifest.xml` — `application` / `activity` manifest and any required plugin permissions.
- `client/lib/src/features/dashboard/session_dashboard.dart` — `_PairingPanel.build`; defines whether Android exposes QR scanning and the exact acceptance surface to smoke test.
- `client/lib/main.dart` — app entrypoint proving Android should boot the same dashboard UI instead of a separate mobile shell.
- `Makefile` — only touch if a dedicated Android build command is needed after verification.

## Verification
1. Working directory: `client/`.
2. Environment check: `flutter --version` and `flutter emulators` to confirm Flutter SDK and available Android emulator IDs.
3. Launch emulator: `flutter emulators --launch byobudash-api35-arm64` (fallback `byobudash-api35` if the first fails to boot).
4. Runtime smoke test: `flutter run -d <booted-emulator-id>`.
   - Expected: app installs and opens to the dashboard screen.
   - Expected: pairing card shows `Device name`, payload input, `Connect`, and `Scan QR` controls.
   - Expected: tapping `Scan QR` opens the scanner area and does not crash.
5. Build proof: `flutter build apk --debug`.
   - Expected: successful APK build with output under `client/build/app/outputs/flutter-apk/app-debug.apk`.
6. Regression proof for non-Android Dart changes, only if Dart code was edited: `flutter test` from `client/`.

## Assumptions & contingencies
- Assume the user wants the existing Flutter client packaged for Android, not a separate native Android rewrite. If implementation evidence contradicts that, stop and report rather than splitting the app.
- Assume a debug APK satisfies “build android app version” unless the user later asks for store-ready signing; if they do, add release signing as separate work because the checked-in Gradle file currently signs release with debug keys.
- If the preferred emulator fails to boot for host-specific reasons, use `byobudash-api35` and continue; emulator choice is not load-bearing.
- If scanner preview cannot function in the emulator because no virtual camera is exposed, accept stability + visible scanner UI as the Android-specific smoke test and keep manual payload paste as the pairing fallback already present in `_PairingPanel`.
- If Android build errors come from upstream plugin/toolchain incompatibility rather than app code, pin or adjust only the minimum version/config already in this repo to restore `flutter build apk --debug`; do not introduce new packages or rebuild the platform scaffold.
