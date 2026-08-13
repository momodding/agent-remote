<!-- source-branch: main -->
<!-- work-branch: omp/novnc-file-manager -->

## Context

The user asked for two changes: make current Makefile client builds include the noVNC desktop button by default while still allowing a disable value, and expand the authenticated file manager so it can switch to host directories outside the workspace-root view and perform copy, cut, paste, download, rename, and “open with” actions. The existing noVNC UI is gated by `process.env.EXPO_PUBLIC_ENABLE_NOVNC === 'true'` in `client/app/index.tsx`, but `Makefile` never sets that env var. The existing file manager route is `client/app/files.tsx`; backend filesystem APIs already require auth, but `backend/internal/fs.Service.Resolve` currently rejects paths outside `WorkspaceRoot`, and the client exposes only list/search/read/write.

## Approach

### 1. Enable noVNC by default in Makefile client builds
- In `Makefile`, add `ENABLE_NOVNC ?= true` next to the other build variables. Do not rename the client env var; reuse the existing `EXPO_PUBLIC_ENABLE_NOVNC` checked in `client/app/index.tsx`.
- In the `client-build` target cases, prefix every Expo client build command with `EXPO_PUBLIC_ENABLE_NOVNC=$(ENABLE_NOVNC)`:
  - web case: `cd client && bun install && EXPO_PUBLIC_ENABLE_NOVNC=$(ENABLE_NOVNC) bun run build:web && cd ..`
  - android case: keep the Android SDK guard and existing EAS flags, then run `EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP=1 EXPO_PUBLIC_ENABLE_NOVNC=$(ENABLE_NOVNC) bunx eas-cli build ...`
  - ios case: keep the EAS flags and run `EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP=1 EXPO_PUBLIC_ENABLE_NOVNC=$(ENABLE_NOVNC) bunx eas-cli build ...`
- In `Makefile help`, add one line under the client target descriptions: `ENABLE_NOVNC=false disables the Desktop/noVNC button in client builds`. `ENABLE_NOVNC=0` also disables because the client only enables on the exact string `'true'`; no Make-side boolean parser is needed.

### 2. Let backend filesystem APIs accept absolute host paths without removing auth
- In `backend/internal/fs/fs.go`, change `Service.Resolve` to return `(abs string, display string, absolute bool, err error)` and accept both current workspace-relative paths and OS-absolute host paths:
  - Convert request input with `filepath.FromSlash` and `filepath.Clean`.
  - If `filepath.IsAbs(cleaned)` is true, resolve `abs` from that cleaned value, return `display=filepath.ToSlash(abs)` and `absolute=true`; do not apply the workspaceRoot prefix check.
  - If input is relative, keep today’s workspaceRoot anchoring and escape rejection; normalize the workspace root display path from `.` to `''`, return slash paths, and `absolute=false`.
  - Empty input remains the workspace root view, so existing callers/tests using `''`, `docs`, and `docs/file.txt` continue to work.
- Update every fs service caller in the same file for the new `Resolve` signature: `List`, `Search`, `ReadText`, `WriteText`, `Delete`, `Rename`, `GitStatus`, and new methods below. Ignore the `absolute` return where behavior does not need it.
- In `List`, use the canonical `display` from `Resolve` when constructing child `FileEntry.Path`, not the raw request string. For a workspace-relative listing, child paths stay like `docs/readme.txt`; for an absolute listing, child paths are absolute slash-normalized paths like `/home/user/readme.txt`.
- In `Search`, return workspace-relative paths when the search root was workspace-relative and absolute paths when the search root was absolute. Keep the existing 200-result cap and case-insensitive name matching.
- Keep `resolveUpload` rooted at `UploadRoot`; uploads are not requested here and must not become a host-root write primitive.

### 3. Add minimal backend file operations for copy and download
- In `backend/internal/protocol/protocol.go`, add:
  - Add `CopyFileRequest` with fields `Path string \`json:"path"\`` and `NewPath string \`json:"newPath"\``.
  - Reuse existing `RenameFileRequest` for rename and cut-paste; do not add a separate cut endpoint.
- In `backend/internal/fs/fs.go`, add `var ErrDestinationExists = errors.New("destination exists")` beside `ErrDestructiveDisabled`.
- Change `Service.Rename(oldRel, newRel string)` to reject overwrites before `os.Rename`: after resolving both paths, if `os.Lstat(newAbs)` returns nil, return `ErrDestinationExists`; if it returns an error other than `os.ErrNotExist`, return that error. Keep the existing `AllowDestructiveFiles` guard, so rename and cut-paste still return forbidden unless `allowDestructiveFiles` is true.
- Add `func (s *Service) Copy(oldRel, newRel string) error`:
  - Resolve source and destination with `Resolve`.
  - Reject destination existence with `ErrDestinationExists` using `os.Lstat` before creating anything.
  - Use `os.Lstat` on the source and reject symlink sources with `errors.New("symlink copy is not allowed")`.
  - If source is a regular file, copy with `os.Open`, `os.OpenFile(newAbs, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())`, and `io.Copy`.
  - If source is a directory, walk with `filepath.WalkDir`, reject symlink entries, create directories with `MkdirAll(..., mode.Perm())`, and copy regular files with `O_EXCL`. Do not preserve owner, times, xattrs, or special files; return `errors.New("unsupported file type")` for non-regular, non-directory entries.
- Add `func (s *Service) OpenDownload(rel string) (*os.File, os.FileInfo, string, error)`:
  - Resolve the path, open it with `os.Open`, stat it, reject directories with `errors.New("path is a directory")`, and return the open file, file info, and `filepath.Base(abs)` as the download filename. The caller owns closing the file.
- In `backend/internal/server/server.go`:
  - Register `mux.HandleFunc("/v1/fs/copy", s.withAuth(s.handleFSCopy))` and `mux.HandleFunc("/v1/fs/download", s.withAuth(s.handleFSDownload))` next to existing fs routes.
  - Add `handleFSCopy`: require `POST`, decode `protocol.CopyFileRequest`, call `s.fs.Copy(req.Path, req.NewPath)`, return `204`, map `ErrDestinationExists` to `409`, and use JSON error code `fs_copy_failed` for failures.
  - Add `handleFSDownload`: require `GET`, call `OpenDownload(r.URL.Query().Get("path"))`, set `Content-Type` from `mime.TypeByExtension(filename)` or fallback to `application/octet-stream`, set `Content-Disposition: attachment; filename="<sanitized basename>"`, set `Content-Length` from `info.Size()`, and `io.Copy(w, file)`. Use `strconv.Quote` or an equivalent stdlib-safe quote for the filename parameter; strip `/`, `\`, CR, and LF by using only `filepath.Base` from `OpenDownload`.
  - In existing `handleFSRename`, map `ErrDestinationExists` to `409 Conflict` with code `fs_rename_failed`; keep `ErrDestructiveDisabled` mapped to `403`.
- Do not add unauthenticated download URLs. The client can supply the existing bearer token as an Authorization header; this avoids leaking tokens in URLs.

### 4. Add client API methods and Expo file-sharing dependencies
- In `client/`, install official Expo managed modules with `bun expo install expo-file-system expo-sharing`; keep the resulting `client/package.json` and `client/bun.lock` changes. These are required for native download/open-with; no custom native code or new non-Expo dependency is needed.
- In `client/src/lib/api.ts`, add public methods to `AgenticRemoteAPI`:
  - `renameFile(path: string, newPath: string): Promise<void>` -> `POST /v1/fs/rename` with `{ path, newPath }`.
  - `copyFile(path: string, newPath: string): Promise<void>` -> `POST /v1/fs/copy` with `{ path, newPath }`.
  - `downloadRequest(path: string): { url: string; headers: Record<string, string> }` -> returns `apiURL(this.connection.endpoint, "/v1/fs/download?path=" + encodeURIComponent(path))` and `{ Authorization: "Bearer " + this.connection.token }`.
- In `client/src/protocol.ts`, mirror the new request shapes so wire-contract types stay in the protocol file: `export type RenameFileRequest = { path: string; newPath: string };` and `export type CopyFileRequest = { path: string; newPath: string };`. Import and use these request types in `client/src/lib/api.ts` request bodies.

### 5. Expand `client/app/files.tsx` navigation outside workspace root
- Keep `FilesScreen` as the only file-manager route. Reuse existing `AgenticRemoteAPI.files`, `searchFiles`, `gitStatus`, `readFile`, and `writeFile`; add only the API methods from Step 4.
- Add state for a direct path entry and file-action state:
  - `pathText` mirrors the current `path` and is editable.
  - `clipboard: null | { mode: 'copy' | 'cut'; entry: FileEntry }` stores the pending copy/cut source.
  - `renameTarget: FileEntry | null` and `renameText: string` drive a small rename modal.
- Add a path switch row below search or above breadcrumbs: `TextInput` labeled/placeholder `Path`, value `pathText`, no autocorrect/capitalization, and a `Go` button. Submitting or pressing `Go` calls `navigate(pathText.trim())`. Add a `Host root` button that calls `navigate('/')`. This is the explicit way to browse outside the workspace-root view without relying on `..` traversal.
- Update `navigate(location)` to set both `path` and `pathText`, clear search, and reload. When reload fails, keep the previous `path`, `pathText`, and entries; show the existing alert.
- Update breadcrumb rendering:
  - For `path === ''`, root label remains `Workspace` and targets `''`.
  - For `path` starting with `/`, root label is `/` and targets `/`; each following segment targets its absolute prefix (`/home`, `/home/user`, ...). Parent of `/home` is `/`; parent of `/` is disabled.
  - For other paths, keep current workspace-relative `Workspace > segment` behavior.
- Keep file tap behavior: directories navigate to `entry.path`; regular files open the existing text editor. If opening fails for binary/large files, keep the existing alert.

### 6. Add copy, cut, paste, rename, download, and open-with UI in `client/app/files.tsx`
- Add row action buttons to each `FileEntry` row without changing row tap behavior:
  - Copy button: accessibility label `Copy <name>`, icon `copy`, sets `clipboard={ mode: 'copy', entry }`.
  - Cut button: accessibility label `Cut <name>`, icon `scissors`, sets `clipboard={ mode: 'cut', entry }`.
  - Rename button: accessibility label `Rename <name>`, icon `edit-2`, sets rename state with the current name.
  - For files only, Download button: accessibility label `Download <name>`, icon `download`, calls `download(entry, 'download')`.
  - For files only, Open with button: accessibility label `Open with <name>`, icon `external-link`, calls `download(entry, 'open')`.
- Add a paste bar visible when `clipboard` is non-null: text `Copy <name>` or `Cut <name>`, a Paste button with accessibility label `Paste into current directory`, and a Cancel button. Paste destination is `joinRemotePath(path, clipboard.entry.name)`; implement `joinRemotePath` in `files.tsx` with slash strings only: `'' + name` for workspace root, `'/' + name` for host root, `base.replace(/\/$/, '') + '/' + name` otherwise.
- Paste behavior:
  - Copy mode calls `api.copyFile(source, destination)`.
  - Cut mode calls `api.renameFile(source, destination)`.
  - On success, clear clipboard and reload the current directory.
  - On `409`/destination-exists or any API error, leave clipboard intact and show `Alert.alert('Could not paste file', message)`.
- Rename behavior:
  - Use a `Modal` matching existing `ConnectionSheet`/`PairingSheet` patterns: `Modal`, `SafeAreaView`, `KeyboardAvoidingView`, `TextInput`, Cancel, Save.
  - Save computes `newPath = joinRemotePath(parentRemotePath(renameTarget.path), renameText.trim())`; reject empty names and names containing `/` or `\` client-side with `Alert.alert('Invalid name')`.
  - Call `api.renameFile(renameTarget.path, newPath)`, close modal and reload on success; keep modal open and show `Alert.alert('Could not rename file', message)` on failure.
- Download/open-with behavior:
  - Implement one helper `download(entry, mode)` in `files.tsx`. It calls `api.downloadRequest(entry.path)`.
  - On native (`Platform.OS !== 'web'`), create/cache `new Directory(Paths.cache, 'agenticremote-downloads')` from `expo-file-system` with idempotent creation, then use `File.downloadFileAsync(url, directory, { headers, idempotent: true })`. If `Sharing.isAvailableAsync()` is true, pass the returned file URI to `Sharing.shareAsync(file.uri, { dialogTitle: mode === 'open' ? 'Open with…' : 'Download file', mimeType: 'application/octet-stream' })`; otherwise alert with the cached file URI.
  - On web, fetch the URL with the Authorization header, create a Blob URL, and click an `<a download={entry.name}>` for Download. For Open with on web, open the Blob URL in a new tab because browsers do not expose a general native app chooser to JavaScript.
  - Always revoke web Blob URLs after use with a short timeout. Alert `Could not download file` or `Could not open file` on errors.
- Keep `allowDestructiveFiles` behavior server-driven. The client should show Cut/Rename/Paste actions even when disabled; a daemon with `allowDestructiveFiles:false` returns `403`, and the UI displays the backend message. Do not add a new config fetch endpoint just to hide buttons.

## Critical files & anchors

- `Makefile:3-18` and `Makefile:163-180` — build variables and client build cases that must pass `EXPO_PUBLIC_ENABLE_NOVNC`.
- `client/app/index.tsx:154-164` — existing Desktop/noVNC button gate already uses `process.env.EXPO_PUBLIC_ENABLE_NOVNC === 'true'`; do not change this gate.
- `backend/internal/fs/fs.go:40-74` and `backend/internal/fs/fs.go:162-185` — path resolution/listing and existing destructive rename guard are the root of workspace-only browsing and cut/rename semantics.
- `backend/internal/server/server.go:71-78` and `backend/internal/server/server.go:242-315` — authenticated fs routes and handlers to extend with copy/download.
- `client/app/files.tsx:22-120` — current file manager loading/navigation/list rendering; all new UI actions should stay in this route.

## Verification

- Makefile proof from repo root:
  - `make -n client-build-web` must print the web build command with `EXPO_PUBLIC_ENABLE_NOVNC=true bun run build:web`.
  - `make -n client-build-web ENABLE_NOVNC=false` must print the web build command with `EXPO_PUBLIC_ENABLE_NOVNC=false bun run build:web`.
- Backend proof from repo root:
  - Add/extend `backend/internal/fs/fs_test.go` tests for: absolute path listing outside workspace returns absolute slash-normalized `FileEntry.Path`; relative traversal like `../outside` is still rejected; `Rename` rejects an existing destination; `Copy` copies a file and a nested directory; `Copy` rejects symlink sources.
  - Add/extend `backend/internal/server/server_test.go` tests for authenticated `POST /v1/fs/copy` returning `204` and creating the destination, authenticated copy conflict returning `409`, and authenticated `GET /v1/fs/download?path=<file>` returning file bytes plus `Content-Disposition`.
  - Run `cd backend && go test ./internal/fs ./internal/server`.
- Client proof from repo root after installing the Expo modules:
  - Extend `client/src/files-route.test.tsx` mocks for `renameFile`, `copyFile`, and `downloadRequest`, plus Jest mocks for `expo-file-system` and `expo-sharing`.
  - Add tests proving: typing `/tmp/other` in the Path field and pressing Go calls `api.files('/tmp/other')`; `Host root` calls `api.files('/')`; absolute breadcrumbs and parent navigation produce `/`, `/tmp`, etc.; Copy then Paste calls `copyFile(source, joinRemotePath(currentPath, name))`; Cut then Paste calls `renameFile(source, destination)`; Rename validates names and calls `renameFile(oldPath, siblingNewPath)`; Download and Open with call the native download/share helper on native mocks or web fetch/blob path on web mocks.
  - Run `cd client && bun test src/files-route.test.tsx --runInBand`.
  - Run `cd client && bun run typecheck`.
- Manual smoke check against a paired daemon:
  - Build web with default Makefile command and confirm the dashboard Desktop button is visible; rebuild with `ENABLE_NOVNC=false` and confirm it is absent.
  - In Files, press `Host root`, navigate into `/home` or type an absolute path outside the configured workspace root and press Go; the list must change to that host directory.
  - Copy a small file, paste into another directory, and verify it appears. With `allowDestructiveFiles:true`, cut a small file into another directory and rename it; with `allowDestructiveFiles:false`, cut/rename must show the backend forbidden message rather than silently succeeding.
  - Download a small text file and open it with another app from the OS share sheet.

## Assumptions & contingencies

- “Not limited to root directory” means the file manager must be able to browse absolute host paths outside the daemon `workspaceRoot`; authenticated access and CIDR restrictions remain the security boundary. Relative paths stay workspace-rooted to avoid accidental `..` escapes; users switch outside the workspace by typing an absolute path or pressing `Host root`.
- “Open with” means Android/iOS app selection through the OS share sheet after downloading the file into app cache. Web cannot present a generic installed-app chooser; web Open with opens the downloaded Blob URL in a new browser tab.
- Destination name conflicts fail with `409 destination exists`; the implementation must not auto-overwrite or invent “copy 2” names. This is the shortest safe behavior and avoids data loss.
- Directory copy does not preserve ownership, timestamps, xattrs, symlinks, or special files. If users later need archival fidelity, add an archive/download feature instead of complicating file-manager copy.
