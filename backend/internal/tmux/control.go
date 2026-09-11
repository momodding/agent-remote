package tmux

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ControlClient manages tmux control-mode connection with FIFO command queue.
// Exposes pane output via SubscribePaneOutput for TerminalBackend.Read.
type ControlClient struct {
	socketPath       string
	stateDir         string
	tmuxPath         string
	cmd              *exec.Cmd
	parser           *Parser
	stdin            io.WriteCloser
	mu               sync.RWMutex
	topology         *TopologySnapshot
	closed           bool
	notificationsSub []chan<- NotificationEvent
	lastRefresh      time.Time
	lost             chan struct{}
	lostOnce         sync.Once
}

// NewControlClient creates a client for private socket
func NewControlClient(stateDir, tmuxPath string) *ControlClient {
	socketPath := filepath.Join(stateDir, "tmux.sock")
	return &ControlClient{
		socketPath:       socketPath,
		stateDir:         stateDir,
		tmuxPath:         tmuxPath,
		notificationsSub: []chan<- NotificationEvent{},
		lost:             make(chan struct{}),
		topology: &TopologySnapshot{
			Sessions:  make(map[string]*SessionInfo),
			Windows:   make(map[string]*WindowInfo),
			Panes:     make(map[string]*PaneInfo),
			Timestamp: time.Now(),
		},
	}
}

// Start connects to tmux control mode
func (c *ControlClient) Start(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.closed {
		return fmt.Errorf("client already closed")
	}

	if err := os.MkdirAll(c.stateDir, 0700); err != nil {
		return fmt.Errorf("create state dir: %w", err)
	}

	// Validate existing socket if present: must be a socket, owned by us, no symlinks
	if fi, err := os.Lstat(c.socketPath); err == nil {
		if fi.IsDir() || (fi.Mode()&os.ModeSocket) == 0 {
			return fmt.Errorf("socket path exists but is not a socket")
		}
		stat := fi.Sys().(*syscall.Stat_t)
		if stat.Uid != uint32(os.Getuid()) {
			return fmt.Errorf("socket exists but not owned by us")
		}
		// Socket exists and is ours; tmux will attach to it
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("check socket: %w", err)
	}
	// If socket doesn't exist, tmux will create new server
	// A control client cannot create a tmux server by itself. Keep one detached
	// anchor session so the private server survives control-client reconnects.
	probe := exec.CommandContext(ctx, c.tmuxPath, "-S", c.socketPath, "has-session")
	if err := probe.Run(); err != nil {
		anchor := exec.CommandContext(ctx, c.tmuxPath, "-S", c.socketPath, "new-session", "-d", "-s", "agenticremote")
		if output, createErr := anchor.CombinedOutput(); createErr != nil {
			return fmt.Errorf("start private tmux server: %w: %s", createErr, strings.TrimSpace(string(output)))
		}
	}

	c.cmd = exec.CommandContext(ctx, c.tmuxPath, "-S", c.socketPath, "-C")

	stdout, err := c.cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}

	stderr, err := c.cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("stderr pipe: %w", err)
	}

	stdin, err := c.cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("stdin pipe: %w", err)
	}

	if err := c.cmd.Start(); err != nil {
		return fmt.Errorf("start tmux: %w", err)
	}

	c.stdin = stdin
	c.parser = NewParser(stdout)

	// Start parser in background
	go func() {
		if err := c.parser.Start(); err != nil {
			// ponytail: log or store error; don't panic
		}
		c.handleServerLoss()
	}()
	select {
	case <-c.parser.Ready():
	case <-ctx.Done():
		c.abortStart()
		return fmt.Errorf("wait for tmux control startup: %w", ctx.Err())
	case <-time.After(2 * time.Second):
		c.abortStart()
		return fmt.Errorf("wait for tmux control startup: timeout")
	}
	if err := c.cmd.Process.Signal(syscall.Signal(0)); err != nil {
		return fmt.Errorf("tmux control process exited during startup: %w", err)
	}
	go c.forwardNotifications()

	// Forward stderr to logs (or discard)
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			// ponytail: could log stderr here
		}
	}()

	return nil
}

// abortStart releases the control process after startup failed; caller holds c.mu.
func (c *ControlClient) abortStart() {
	if c.stdin != nil {
		_ = c.stdin.Close()
		c.stdin = nil
	}
	if c.cmd != nil && c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
		_ = c.cmd.Wait()
	}
	c.closed = true
}

// SendCommand enqueues command via FIFO queue
func (c *ControlClient) SendCommand(ctx context.Context, tmuxCmd string) (<-chan error, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.closed {
		return nil, fmt.Errorf("control client closed")
	}

	if c.parser == nil {
		return nil, fmt.Errorf("parser not initialized")
	}

	resultCh, err := c.parser.SubmitCommand(tmuxCmd)
	if err != nil {
		return nil, err
	}
	errChan := make(chan error, 1)
	go func() {
		result, ok := <-resultCh
		if !ok || result == nil {
			errChan <- fmt.Errorf("tmux command ended without a result")
		} else if result.Error != nil {
			errChan <- result.Error
		} else {
			errChan <- nil
		}
		close(errChan)
	}()

	if _, err := fmt.Fprintf(c.stdin, "%s\n", tmuxCmd); err != nil {
		return nil, fmt.Errorf("send command: %w", err)
	}

	return errChan, nil
}

// RefreshTopology queries tmux state
func (c *ControlClient) RefreshTopology(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.parser == nil {
		return fmt.Errorf("parser not initialized")
	}

	// List sessions: session_id|session_name|session_path|session_created
	sesResultCh, err := c.parser.SubmitCommand("list-sessions -F '#{session_id}|#{session_name}|#{session_path}|#{session_created}'")
	if err != nil {
		return fmt.Errorf("submit list-sessions: %w", err)
	}

	if _, err := fmt.Fprintf(c.stdin, "list-sessions -F '#{session_id}|#{session_name}|#{session_path}|#{session_created}'\n"); err != nil {
		return err
	}

	sessions := make(map[string]*SessionInfo)

	// Wait for sessions result with timeout
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(5 * time.Second):
		return fmt.Errorf("list-sessions timeout")
	case sesResult := <-sesResultCh:
		if sesResult == nil {
			return fmt.Errorf("list-sessions returned nil")
		}
		if sesResult.Error != nil {
			return fmt.Errorf("list-sessions error: %v", sesResult.Error)
		}
		// Parse sessions
		for _, line := range sesResult.Lines {
			if line == "" {
				continue
			}
			parts := strings.Split(line, "|")
			if len(parts) >= 3 {
				sessions[parts[0]] = &SessionInfo{
					SessionID: parts[0],
					Name:      parts[1],
					Path:      parts[2],
				}
			}
		}
	}

	// List windows: window_id|session_id|window_index|window_name|window_active|window_layout
	winResultCh, err := c.parser.SubmitCommand("list-windows -a -F '#{window_id}|#{session_id}|#{window_index}|#{window_name}|#{window_active}|#{window_layout}'")
	if err != nil {
		return fmt.Errorf("submit list-windows: %w", err)
	}

	if _, err := fmt.Fprintf(c.stdin, "list-windows -a -F '#{window_id}|#{session_id}|#{window_index}|#{window_name}|#{window_active}|#{window_layout}'\n"); err != nil {
		return err
	}

	windows := make(map[string]*WindowInfo)

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(5 * time.Second):
		return fmt.Errorf("list-windows timeout")
	case winResult := <-winResultCh:
		if winResult == nil {
			return fmt.Errorf("list-windows returned nil")
		}
		if winResult.Error != nil {
			return fmt.Errorf("list-windows error: %v", winResult.Error)
		}
		for _, line := range winResult.Lines {
			if line == "" {
				continue
			}
			parts := strings.Split(line, "|")
			if len(parts) >= 6 {
				windows[parts[0]] = &WindowInfo{
					WindowID:  parts[0],
					SessionID: parts[1],
					Index:     toInt(parts[2]),
					Name:      parts[3],
					Active:    parts[4] == "1",
					Layout:    parts[5],
				}
			}
		}
	}
	for _, window := range windows {
		if session := sessions[window.SessionID]; session != nil {
			session.Windows = append(session.Windows, window.WindowID)
		}
	}

	// List panes: pane_id|window_id|session_id|pane_index|pane_active|pane_current_path|pane_current_command|pane_width|pane_height|pane_tty
	paneResultCh, err := c.parser.SubmitCommand("list-panes -a -F '#{pane_id}|#{window_id}|#{session_id}|#{pane_index}|#{pane_active}|#{pane_current_path}|#{pane_current_command}|#{pane_width}|#{pane_height}|#{pane_tty}'")
	if err != nil {
		return fmt.Errorf("submit list-panes: %w", err)
	}

	if _, err := fmt.Fprintf(c.stdin, "list-panes -a -F '#{pane_id}|#{window_id}|#{session_id}|#{pane_index}|#{pane_active}|#{pane_current_path}|#{pane_current_command}|#{pane_width}|#{pane_height}|#{pane_tty}'\n"); err != nil {
		return err
	}

	panes := make(map[string]*PaneInfo)

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(5 * time.Second):
		return fmt.Errorf("list-panes timeout")
	case paneResult := <-paneResultCh:
		if paneResult == nil {
			return fmt.Errorf("list-panes returned nil")
		}
		if paneResult.Error != nil {
			return fmt.Errorf("list-panes error: %v", paneResult.Error)
		}
		for _, line := range paneResult.Lines {
			if line == "" {
				continue
			}
			parts := strings.Split(line, "|")
			if len(parts) >= 10 {
				panes[parts[0]] = &PaneInfo{
					PaneID:    parts[0],
					WindowID:  parts[1],
					SessionID: parts[2],
					Index:     toInt(parts[3]),
					Active:    parts[4] == "1",
					Path:      parts[5],
					Command:   parts[6],
					Width:     toInt(parts[7]),
					Height:    toInt(parts[8]),
					TTY:       parts[9],
				}
			}
		}
	}
	for _, pane := range panes {
		if window := windows[pane.WindowID]; window != nil {
			window.Panes = append(window.Panes, pane.PaneID)
		}
	}

	c.topology = &TopologySnapshot{
		Sessions:  sessions,
		Windows:   windows,
		Panes:     panes,
		Timestamp: time.Now(),
	}

	return nil
}

// GetTopology returns current snapshot
func (c *ControlClient) GetTopology() *TopologySnapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.topology == nil {
		return &TopologySnapshot{
			Sessions:  make(map[string]*SessionInfo),
			Windows:   make(map[string]*WindowInfo),
			Panes:     make(map[string]*PaneInfo),
			Timestamp: time.Now(),
		}
	}
	return c.topology
}

func (c *ControlClient) BeginPaneCapture(paneID string) <-chan paneOutput {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.parser == nil {
		return nil
	}
	return c.parser.BeginPaneCapture(paneID)
}

func (c *ControlClient) FinishPaneCapture(paneID string, sequence uint64, attach func([]byte) error) error {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.parser == nil {
		return fmt.Errorf("tmux control client is not running")
	}
	return c.parser.FinishPaneCapture(paneID, sequence, attach)
}

func (c *ControlClient) AbortPaneCapture(paneID string) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.parser != nil {
		c.parser.AbortPaneCapture(paneID)
	}
}

// forwardNotifications routes notifications
func (c *ControlClient) forwardNotifications() {
	notifChan := c.parser.GetNotifications()
	if notifChan == nil {
		return
	}
	for notif := range notifChan {
		c.mu.RLock()
		subs := make([]chan<- NotificationEvent, len(c.notificationsSub))
		copy(subs, c.notificationsSub)
		c.mu.RUnlock()

		for _, sub := range subs {
			select {
			case sub <- notif:
			default:
			}
		}
	}
}

// SubscribeNotifications returns notification channel
func (c *ControlClient) SubscribeNotifications() <-chan NotificationEvent {
	ch := make(chan NotificationEvent, 16)
	c.mu.Lock()
	c.notificationsSub = append(c.notificationsSub, ch)
	c.mu.Unlock()
	return ch
}

// CreatePane starts one terminal command in its own persistent tmux session.
func (c *ControlClient) CreatePane(ctx context.Context, sessionName, command string, args []string, cwd string, cols, rows int) (*TmuxBackend, error) {
	words := []string{"new-session", "-d", "-x", strconv.Itoa(cols), "-y", strconv.Itoa(rows), "-s", sessionName, "-c", cwd, command}
	words = append(words, args...)
	for i, word := range words {
		words[i] = strconv.Quote(word)
	}
	errCh, err := c.SendCommand(ctx, strings.Join(words, " "))
	if err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case err := <-errCh:
		if err != nil {
			return nil, err
		}
	}
	if err := c.RefreshTopology(ctx); err != nil {
		return nil, err
	}
	topology := c.GetTopology()
	for _, session := range topology.Sessions {
		if session.Name != sessionName || len(session.Windows) == 0 {
			continue
		}
		window := topology.Windows[session.Windows[0]]
		if window == nil || len(window.Panes) == 0 {
			continue
		}
		pane := topology.Panes[window.Panes[0]]
		if pane != nil {
			backend := NewTmuxBackend(c, pane.PaneID, pane.SessionID, pane.WindowID)
			ch := c.BeginPaneCapture(pane.PaneID)
			if err := c.captureBaselineAndAttach(ctx, pane.PaneID, backend, ch); err != nil {
				backend.Close()
				return nil, err
			}
			return backend, nil
		}
	}
	return nil, fmt.Errorf("tmux did not create session %q", sessionName)
}

// captureBaselineAndAttach atomically snapshots history and activates the
// backend while parser output remains losslessly buffered. Output at or before
// the capture %end marker is in the baseline; later output is pending.
func (c *ControlClient) captureBaselineAndAttach(ctx context.Context, paneID string, backend *TmuxBackend, ch <-chan paneOutput) error {
	baseline, sequence, err := c.capturePane(ctx, paneID)
	if err != nil {
		c.AbortPaneCapture(paneID)
		return err
	}
	return c.FinishPaneCapture(paneID, sequence, func(pending []byte) error {
		return backend.Subscribe(ch, baseline, pending)
	})
}

func (c *ControlClient) capturePane(ctx context.Context, paneID string) ([]byte, uint64, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.parser == nil || c.stdin == nil {
		return nil, 0, fmt.Errorf("tmux control client is not running")
	}
	resultCh, err := c.parser.SubmitCommand("capture-pane")
	if err != nil {
		return nil, 0, err
	}
	if _, err := fmt.Fprintf(c.stdin, "capture-pane -p -e -S - -t %s\n", strconv.Quote(paneID)); err != nil {
		return nil, 0, err
	}
	select {
	case <-ctx.Done():
		return nil, 0, ctx.Err()
	case result := <-resultCh:
		if result == nil {
			return nil, 0, fmt.Errorf("capture-pane returned no result")
		}
		if result.Error != nil {
			return nil, 0, result.Error
		}
		return result.Output, result.Sequence, nil
	}
}

// ReattachPane rebuilds a backend for a pane that survived a daemon restart.
func (c *ControlClient) ReattachPane(ctx context.Context, paneID, sessionID, windowID string) (*TmuxBackend, error) {
	backend := NewTmuxBackend(c, paneID, sessionID, windowID)
	ch := c.BeginPaneCapture(paneID)
	if err := c.captureBaselineAndAttach(ctx, paneID, backend, ch); err != nil {
		_ = backend.Close()
		return nil, err
	}
	return backend, nil
}

// Lost closes when the tmux control connection or server is gone; callers
// must not recreate commands in response, only mark affected state lost.
func (c *ControlClient) Lost() <-chan struct{} { return c.lost }

// ServerID identifies this private tmux server in persisted topology.
func (c *ControlClient) ServerID() string { return c.socketPath }

// SendKey writes text through the correlated control command queue.
func (c *ControlClient) SendKey(ctx context.Context, paneID string, data []byte) (int, error) {
	errCh, err := c.SendCommand(ctx, fmt.Sprintf("send-keys -t %s %q", paneID, string(data)))
	if err != nil {
		return 0, err
	}
	select {
	case <-ctx.Done():
		return 0, ctx.Err()
	case err := <-errCh:
		if err != nil {
			return 0, err
		}
		return len(data), nil
	}
}

// ResizePane sets pane dimensions through the correlated control command queue.
func (c *ControlClient) ResizePane(ctx context.Context, paneID string, cols, rows int) error {
	errCh, err := c.SendCommand(ctx, fmt.Sprintf("resize-pane -t %s -x %d -y %d", paneID, cols, rows))
	if err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-errCh:
		return err
	}
}

// Close shuts down client
func (c *ControlClient) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.closed {
		return nil
	}

	c.closed = true

	if c.parser != nil {
		_ = c.parser.Close()
	}

	if c.stdin != nil {
		_ = c.stdin.Close()
	}

	if c.cmd != nil && c.cmd.Process != nil {
		_ = c.cmd.Wait()
	}

	return nil
}

// handleServerLoss marks the tmux connection lost when the control process or
// parser exits unexpectedly. It never recreates commands; callers observe
// Lost() and mark dependent runtimes exited without spawning replacements.
func (c *ControlClient) handleServerLoss() {
	c.mu.Lock()
	closedByUs := c.closed
	c.mu.Unlock()
	if closedByUs {
		return
	}
	c.lostOnce.Do(func() { close(c.lost) })
}

// Helper
func toInt(s string) int {
	if v, err := strconv.Atoi(s); err == nil {
		return v
	}
	return 0
}
