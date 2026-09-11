// Package tmux provides Phase 3 control-mode core: parser, topology, and pane backend.
//
// # Architecture
//
// Parser: line-by-line tmux control-mode protocol handler.
//   - Correlates commands: %begin $id → %output/%extended-output → %end/%error
//   - Decodes octal-escaped %output bytes
//   - Routes notifications (%sessions-changed, %pause, etc.) outside blocks
//   - Serial queue; fails closed on protocol mismatch
//
// ControlClient: long-lived connection to tmux via isolated private socket.
//   - Validates socket ownership before connect (security gate)
//   - Sends commands via argv (no shell)
//   - Maintains stable topology snapshot: sessions, windows, panes by ID
//   - Refreshes topology via list-sessions/list-windows/list-panes
//   - Forwards notifications to subscribers
//   - Restart-safe via generation tracking
//
// TmuxBackend: implements TerminalBackend interface for a pane.
//   - Write: safe paste via load-buffer + paste-buffer (avoids shell quoting)
//   - Resize: resize-pane + refresh-client
//   - Close: idempotent (marks closed, does not kill session)
//   - Alive: queries topology
//   - Identity: stable "tmux:$session:@window:%pane" for recovery
//
// Service: manager for pane backends and control client lifecycle.
//   - Start: connects control client, initial topology refresh, monitors changes
//   - CreatePane: creates backend for existing pane (does not create pane in tmux)
//   - GetTopology: returns current snapshot
//
// # Usage
//
//	// Initialize service
//	svc := tmux.NewService("/path/to/tmux.sock", "/usr/bin/tmux")
//	if err := svc.Start(ctx); err != nil {
//		return err
//	}
//	defer svc.Close()
//
//	// Create backend for existing pane
//	backend, err := svc.CreatePane("%0", "$0", "@0")
//	if err != nil {
//		return err
//	}
//
//	// Use TerminalBackend interface
//	backend.Write([]byte("command\n"))
//	backend.Resize(120, 40)
//
// # Integration Points
//
// - Parent (session.Manager) provides TerminalBackend interface contract
// - Parser validates control-mode protocol; fails closed on mismatch
// - ControlClient isolated to daemon UID via socket ownership check
// - Topology snapshot enables restart recovery without full event replay
// - Notifications trigger topology refresh; decoupled from command flow
// - TmuxBackend does not poll; all I/O via control commands
//
// # Security
//
// - Socket ownership validated before connect (rejects symlinks, wrong owner)
// - No shell invocation; tmux spawned with argv only
// - Private socket isolated per daemon (no access to user's default server)
// - Session/pane IDs immutable; stable across restart for identity recovery
package tmux
