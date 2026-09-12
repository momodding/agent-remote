# SUPERSEDED

> This historical gap analysis is superseded by [the approved recovery architecture](plans/recover-agent-architecture.md). Do not use it for implementation decisions.

# agenticRemote Gap Remediation Plan

## Goal
To evolve the existing agenticRemote project into a unified, multi-daemon remote workspace with a generic terminal runtime, persistent agent/tmux backends, workspace/pane tabs, and half-open desktop VNC channel semantics. We will also enforce strict filesystem sandboxing, overriding the current permissive design.

## Diagnostics & Current Architecture

1. **Filesystem Sandbox Intent vs Policy Gap**:
   - `backend/internal/fs/fs.go` (lines 43-68) implements `Resolve()`. When a relative path traversing outside the root (`..`) is provided, it falls back to returning the path with the `isAbsolute` flag set to `true`, actively permitting the escape.
   - This design is explicitly verified by `TestRelativeParentCanLeaveWorkspace` (`backend/internal/fs/fs_test.go:10-34`).
   - **Remediation**: To meet the strict workspace-sandboxing requirement, this is a policy gap. We must update `fs.go` to reject out-of-bound traversals with `os.ErrPermission`, and intentionally invert the assertion in `TestRelativeParentCanLeaveWorkspace` to test for denial.

2. **Websocket & Goroutine Lifecycle (Half-Close Semantics)**:
   - `backend/internal/session/manager.go` (lines 260-262) acknowledges that the `outbound` channel is left open (a documented `ponytail` shortcut), relying on garbage collection rather than a coordinated shutdown.
   - `backend/internal/server/server.go` (`handlePTYWS`, lines 647-697) reads from the socket until an error occurs, but there is no explicit half-close tracking for the WebSocket when a session finishes.
   - **Remediation**: Introduce a `sync.WaitGroup` or context cancellation in `Manager`'s concurrent pumps to correctly close the outbound channels, stop the goroutines upon session exit, and send an explicit close frame.

3. **noVNC & WebView Bridge**:
   - `client/app/desktop.tsx` (and `desktop.web.tsx`) currently tunnels VNC data over string-based `postMessage` bridging and uses an artificial `setTimeout(() => { this.readyState = 1 })` delay. 
   - **Remediation**: We need to utilize noVNC's `_rawChannel` support (`rfb.js:137`) to implement direct authenticated WebSocket initialization within the WebView, removing the string-message overhead.

4. **Terminal Persistence**:
   - Sessions currently write scrollback to disk (`manager.go:417`, `appendScrollback`) and replay via a sequence number (`seq`). `runtime.seq++` (line 305) is not atomic.
   - `sessions.json` is used for metadata restore; there is no advanced SQL schema out-of-the-box.
   - **Remediation**: Introduce tmux Control Mode as the unified persistence and multiplexing backend, replacing manual PTY spawning and scrollback management. 

## Migration Phases

### Phase 1: Security & Stability
- Refactor `fs.Service.Resolve()` to strictly clamp relative resolutions to `WorkspaceRoot`.
- Update `TestRelativeParentCanLeaveWorkspace` in `fs_test.go` to assert that paths leaving the root return `os.ErrPermission`.
- Make `runtime.seq` an `atomic.Int64` in `manager` to fix the non-atomic increment in the concurrent pump.

### Phase 2: Muxing & Socket Lifecycle
- Refactor `session/manager.go` to explicitly close the `outbound` channel during `Close()`.
- Wait on the `forward` and `readOutput` goroutines using a `sync.WaitGroup` for clean teardown.
- Implement explicit half-close semantics in `server.go` `handlePTYWS` when the process exits.

### Phase 3: Tmux Backend Integration
- Replace `pty.StartWithSize` with a persistent `tmux -C` (Control Mode) backend.
- Route pane output via tmux's `%output` notifications and `%pause`/`%continue` flow control.

### Phase 4: Desktop UX & Raw VNC Bridge
- Refactor `client/app/desktop.tsx`.
- Wire `DaemonChannel` directly to noVNC's `_rawChannel` using ArrayBuffer bridging or a native WebSocket, eliminating the base64 `postMessage` hack.