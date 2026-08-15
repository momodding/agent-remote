<!-- source-branch: main -->
<!-- work-branch: omp/novnc-iife-fix -->
# noVNC IIFE fix + file-manager restriction verification

## Root causes (confirmed by direct experiment, not inference)

1. **`window.RFB is not a constructor`**: `client/scripts/build-novnc.ts` calls `Bun.build` with no `format`, which defaults to ESM. The generated bundle ends in `export default dU();` and is injected into the WebView via a classic `<script src="data:text/javascript;base64,...">` tag in `client/app/desktop.tsx`. A classic script cannot contain `export` — it throws a `SyntaxError` at parse time, the whole inline script (including the `window.RFB=NoVNC.default;` trailer and the try/catch below it) never runs, so `window.RFB` stays `undefined` and `new window.RFB(...)` fails with "is not a constructor". Verified: current `src/generated/novnc_base64.ts` decodes to a body containing `export default dU();`.
   - Verified fix: `Bun.build({ format: 'iife', entrypoints: ['<wrapper-entry>'] })` where the wrapper entry does `import RFB from '.../rfb.js'; globalThis.RFB = RFB;` produces a bundle with **zero** `export` statements and ends in `globalThis.RFB=n6.default;` (tested directly against this exact rfb.js in this repo).

2. **`path escape workspaceRoot` / `path escapes workspaceRoot`**: This string does not exist anywhere in the current `backend/internal/fs/fs.go` (grepped repo-wide). `Resolve` (fs.go:43-68) already returns absolute paths unrestricted for both absolute input and relative paths that traverse outside `WorkspaceRoot` — no error path exists for "escaping" the workspace in `List`/`Search`/`ReadText`/`WriteText`/`Delete`/`Rename`/`Copy`/`OpenDownload`/`GitStatus`. This was already fixed on `main` at commit `757d860` (2026-08-13) per the prior session. Only `resolveUpload` (fs.go:354-368, used solely by the dedicated multipart `Upload` endpoint) still enforces `UploadRoot` — by explicit prior design decision (upload destination boundary, not authenticated browsing).
   - The locally built daemon binary `backend/bin/agenticRemote` is dated 2026-07-21 13:55 — **before** the 757d860 fix (2026-08-13). Whoever is running that stale binary would still see the old "path escapes workspaceRoot" error even though the source is already fixed.
   - **No source change needed for the file-manager issue.** Action needed is a rebuild/redeploy of the daemon binary from current `main`, not a code edit.

## Change

- `client/scripts/build-novnc.ts`: write a temporary ES-module wrapper entry file that imports `RFB` from `@novnc/novnc/lib/rfb.js` and assigns it to `globalThis.RFB`; build that entry with `Bun.build({ format: 'iife', ... })` instead of bundling `rfb.js` directly; drop the now-redundant `window.RFB=NoVNC.default;` string-append step (the wrapper does the assignment inside the bundle); clean up the temp entry file after build.
- No backend code change.

## Verification

- Re-run `bun run scripts/build-novnc.ts`, decode `src/generated/novnc_base64.ts`, assert the decoded body contains no `export` token and ends with a `globalThis.RFB=...` assignment.
- Re-run full client test suite + `tsc --noEmit` (no behavioral surface changed beyond the build script).
- Rebuild the daemon binary (`make backend-build` or `go build ./cmd/agenticRemote`) so any local/deployed daemon reflects the already-fixed `fs.go`; confirm `backend/bin/agenticRemote` mtime advances past 757d860's commit time.
- Report to user: file-manager restriction is a stale-binary issue, not a source bug; instruct rebuild/redeploy.
