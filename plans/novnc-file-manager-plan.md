<!-- source-branch: main -->
## Context

The initial authenticated file-manager/noVNC feature is already merged on `main`; nine later files contain uncommitted corrections and UI changes that execution must preserve. Current `backend/internal/fs.Service.Resolve` accepts absolute paths and relative `..` traversal outside `WorkspaceRoot`, and `backend/internal/fs/fs_test.go` proves both behaviors. `WorkspaceRoot` now supplies the initial view and relative-path base only; it is no longer an authorization boundary. Authentication, bearer-token validation, HTTPS/WSS, CIDR controls, destructive-operation gating, and the upload-specific `UploadRoot` boundary remain unchanged.

Android noVNC still fails before constructing `RFB`: `client/app/desktop.tsx` dynamically imports nonexistent CDN paths ending in `/core/rfb.js`. Both current URLs fail. The verified browser bundle for the published `@novnc/novnc@1.5.0` package is jsDelivr's single-module endpoint `https://cdn.jsdelivr.net/npm/@novnc/novnc@1.5.0/+esm`, whose default export is `RFB`.

## Approach

### 1. Correct the noVNC module URL

- In `client/app/desktop.tsx`, replace the two broken `/core/rfb.js` dynamic imports with one import from `https://cdn.jsdelivr.net/npm/@novnc/novnc@1.5.0/+esm`.
- Keep the existing `new module.default(screen, wsURL)`, viewport settings, status events, WebView configuration, authenticated WSS URL, and bearer token handling unchanged.
- Do not add `@novnc/novnc`, a generated bundle, a build hook, or a second CDN fallback. The verified jsDelivr `+esm` artifact is already a browser-ready bundle; one corrected URL is the smallest fix and avoids retaining another unverified failure path.

### 2. Preserve and verify unrestricted authenticated filesystem navigation

- Keep the current uncommitted `backend/internal/fs/fs.go` behavior: absolute paths resolve directly, workspace-relative paths stay relative while inside `WorkspaceRoot`, and relative parent traversal that leaves the workspace resolves to an absolute display path instead of returning `path escapes workspaceRoot`.
- Keep all filesystem handlers behind the existing `withAuth` registration in `backend/internal/server/server.go`. Do not alter transport security, session tokens, pairing, CIDR checks, or `AllowDestructiveFiles`.
- Keep `resolveUpload` rooted at `UploadRoot` and the config requirement that `uploadDir` stay within `workspaceRoot`; these govern the dedicated upload destination, not authenticated file-manager browsing/read/write/copy/rename/delete/download locations.
- Preserve the existing uncommitted long-press action menu and terminal keyboard-inset changes; do not revert or rewrite unrelated dirty work.

### 3. Verification

- Run `cd backend && go test ./internal/fs ./internal/server`. Existing filesystem tests must continue to prove that `List("..")` can reach a workspace sibling and that absolute outside-workspace listings return absolute paths; server tests must continue to prove authenticated filesystem operations.
- Run `cd client && bunx jest --runInBand` and `cd client && bun run typecheck`.
- Fetch the exact jsDelivr `+esm` URL and confirm a successful JavaScript response rather than the current 404/failing module paths.
- Android smoke proof: open Remote Desktop from a paired connection, confirm the status reaches `Desktop connected`, and confirm framebuffer updates render through the existing authenticated `/v1/ws/vnc?token=...` connection without a dynamic-import error.
- File-manager smoke proof: from the configured workspace, use Parent directory repeatedly and Host root/direct absolute path navigation; list and open a file outside `WorkspaceRoot`. Confirm an unauthenticated filesystem request still returns unauthorized.

## Critical files

- `client/app/desktop.tsx:9-41` — embedded noVNC HTML and the broken import at line 30.
- `backend/internal/fs/fs.go:43-68` — current unrestricted path resolution behavior to preserve.
- `backend/internal/fs/fs_test.go:10-57` — relative-parent and absolute-outside-workspace regression coverage.
- `backend/internal/server/server.go` — authenticated filesystem and VNC route registrations; security behavior is intentionally unchanged.
- `client/app/files.tsx` — current host-root/direct-path navigation and long-press action menu to preserve.

## Assumptions

- Runtime internet access to jsDelivr is acceptable because the existing implementation already loads noVNC from public CDNs; this correction fixes the published path rather than introducing a new runtime model. If offline desktop use becomes a requirement, vendor a generated noVNC bundle in a separate change.
- Host-wide filesystem operations run with the daemon process account's OS permissions. Authentication remains the application boundary; OS permissions remain the host boundary.
