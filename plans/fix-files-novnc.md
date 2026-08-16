<!-- source-branch: main -->
# Fix: Android file manager actions and noVNC disconnect

## Bug 1 — Android file manager error "destructive file system actions disable" when performing cut action

**Root cause**: Backend default config for `AllowDestructiveFiles` is false.
```go
func Default() Config {
	return Config{
		...
		AllowDestructiveFiles:       false,
		...
	}
}
```
This restricts operations like delete, rename, and cut.

**Fix**: Change `AllowDestructiveFiles: false` to `true` in `backend/internal/config/config.go` `Default()` so that default local dev usage permits file actions.

## Bug 2 — Add option to delete files/directories

**Root cause**: Missing UI action in `client/app/files.tsx`.

**Fix**: Add an action sheet or direct entry swipe/long press option in `FilesScreen` to call the `api.deleteFile()` endpoint. The backend endpoint already exists `DELETE /fs`.

## Bug 3 — Add cancel button to deselect files/folders in the Android file manager

**Root cause**: Once you select a file (e.g. for cut/copy), the UI enters a selection state but lacks a visible "Cancel" escape hatch aside from completing the action or backing out entirely.

**Fix**: Add a "Cancel" button to the bottom action bar (or top header) in `client/app/files.tsx` that clears the `clipboard` or `selectedEntry` state.

## Bug 4 — Fix noVNC client error "desktop disconnected unexpectedly" on Android

**Root cause**: The previous fix (`omp/fix-vnc-selection-shell`) changed `<script src="data...` to an inline `<script>${noVNCScript}</script>`. While it fixed the loading, Android WebView or `noVNC` logic might hit a hard disconnect early due to missing URL param parsing for token, WebSocket keepalives, or protocol strictness that terminates the connection. Needs investigation in `client/app/desktop.tsx` or backend VNC WebSocket handshakes. The backend logs might reveal if it's EOF or bad handshake.

**Fix**: Will investigate backend `vnc` handler and frontend WebSocket init.

## Files touched
- `backend/internal/config/config.go`
- `client/app/files.tsx`
- `client/app/desktop.tsx` (maybe)
