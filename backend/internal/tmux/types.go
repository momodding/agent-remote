package tmux

import (
	"fmt"
	"time"
)

// Constants for tmux 3.4+ control protocol
const (
	BeginMarker     = "%begin"
	EndMarker       = "%end"
	ErrorMarker     = "%error"
	OutputMarker    = "%output"
	SessionsChanged = "%sessions-changed"
	SessionChanged  = "%session-changed"
	WindowAdd       = "%window-add"
	WindowDel       = "%window-del"
	WindowChanged   = "%window-changed"
	LayoutChanged   = "%layout-changed"
	PauseMarker     = "%pause"
	ExitMarker      = "%exit"
	CommandTimeout  = 5 * time.Second
)

// ControlCommand in FIFO queue
type ControlCommand struct {
	Command    string
	ID         string // Unique command ID from timestamp+counter
	Result     *CommandResult
	resultChan chan *CommandResult // channel to deliver result
}

type CommandResult struct {
	CommandID string
	Lines     []string // Each line from %begin...%end block
	Output    []byte   // Concatenated output
	Sequence  uint64   // parser line sequence when this command completed
	Error     *ControlError
}

type paneOutput struct {
	sequence uint64
	payload  []byte
}

// TopologySnapshot holds tmux state
type TopologySnapshot struct {
	Sessions  map[string]*SessionInfo
	Windows   map[string]*WindowInfo
	Panes     map[string]*PaneInfo
	Timestamp time.Time
}

type SessionInfo struct {
	SessionID string
	Name      string
	Path      string
	Created   time.Time
	Updated   time.Time
	Windows   []string
}

type WindowInfo struct {
	WindowID  string
	SessionID string
	Index     int
	Name      string
	Active    bool
	Panes     []string
	Layout    string
}

type PaneInfo struct {
	PaneID    string
	WindowID  string
	SessionID string
	Index     int
	Active    bool
	Path      string
	Command   string
	Width     int
	Height    int
	TTY       string
}

type NotificationEvent struct {
	Type      string
	SessionID string
	WindowID  string
	PaneID    string
	Timestamp time.Time
}

type ControlError struct {
	Code      string
	Message   string
	Timestamp time.Time
}

func (e *ControlError) Error() string {
	return fmt.Sprintf("tmux control: %s: %s", e.Code, e.Message)
}

// PaneOutputEvent carries decoded pane output
type PaneOutputEvent struct {
	PaneID  string
	Payload []byte
}

// PaneOutputSubscriber receives pane output
type PaneOutputSubscriber struct {
	paneID string
	ch     chan []byte
}

func (ps *PaneOutputSubscriber) Read(p []byte) (int, error) {
	select {
	case data := <-ps.ch:
		return copy(p, data), nil
	}
}

func (ps *PaneOutputSubscriber) Close() error {
	close(ps.ch)
	return nil
}
