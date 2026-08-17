# fix-files-novnc — remaining work

<!-- source-branch: main -->
<!-- work-branch: omp/fix-files-novnc-3 -->

Continuation of `plans/fix-files-novnc.md`. Backend/noVNC fixes, delete action,
cancel-selection action, and powerline font injection are already merged/done
on branch `omp/fix-files-novnc-3`. Two items remain:

## 1. Android SAF download / ACTION_VIEW open (`client/app/files.tsx`)

Current `download()` downloads to app cache then always calls
`Sharing.shareAsync` on mobile — this is the reported bug (share sheet
instead of direct save / direct open).

Change, Android only (`Platform.OS === 'android'`), after the existing
`File.downloadFileAsync` cache step:
- `mode === 'open'`: `FileSystem.getContentUriAsync(file.uri)` (legacy API)
  then `expo-intent-launcher` `startActivityAsync('android.intent.action.VIEW', { data, type: file.type ?? 'application/octet-stream', flags: 1 })`.
- `mode === 'download'`: `FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync()`
  → if denied, no-op; else `createFileAsync(directoryUri, entry.name, mimeType)`
  then `FileSystem.copyAsync({ from: file.uri, to: destination })` to stream
  bytes into the SAF-picked location without base64 in JS.

iOS/web keep existing `Sharing.shareAsync` / blob-link behavior unchanged.

`expo-intent-launcher` dependency already added to `client/package.json` /
`client/bun.lock` (uncommitted).

## 2. Test updates (`client/src/files-route.test.tsx`)

Existing test `'downloads and opens files with native sharing from the
long-press menu'` asserts iOS `Sharing.shareAsync` behavior — keep it as-is
(iOS still shares). Add an Android-specific case: set `Platform.OS =
'android'`, mock `expo-file-system/legacy` (`getContentUriAsync`,
`StorageAccessFramework.requestDirectoryPermissionsAsync`,
`StorageAccessFramework.createFileAsync`, `copyAsync`) and `expo-intent-launcher`
(`startActivityAsync`), then assert:
- Download path calls `requestDirectoryPermissionsAsync` → `createFileAsync`
  → `copyAsync`, and never calls `Sharing.shareAsync`.
- Open path calls `getContentUriAsync` → `startActivityAsync` with
  `action: 'android.intent.action.VIEW'`, and never calls `Sharing.shareAsync`.

## 3. Verification

- `make client-test` (Jest) for the updated file-manager suite.
- `make client-build-web` to confirm the Expo web export still works with
  the new native-only imports guarded correctly.

No other files touched by this increment.
