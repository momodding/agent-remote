package tmux

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// TmuxBackend implements TerminalBackend using tmux pane.
type TmuxBackend struct {
	mu         sync.RWMutex
	client     *ControlClient
	paneID     string
	sessionID  string
	windowID   string
	closed     bool
	outputCh   <-chan paneOutput // subscribed before baseline capture
	done       chan struct{}
	baseline   []byte
	copyBuffer []byte // pending + live output buffered for Read caller
}

// NewTmuxBackend creates backend for a pane without subscribing.
// Call Subscribe after obtaining the baseline to ensure no output duplication.
func NewTmuxBackend(client *ControlClient, paneID, sessionID, windowID string) *TmuxBackend {
	return &TmuxBackend{
		client:     client,
		paneID:     paneID,
		sessionID:  sessionID,
		windowID:   windowID,
		closed:     false,
		outputCh:   nil, // subscribed later via Subscribe()
		done:       make(chan struct{}),
		copyBuffer: make([]byte, 0, 64*1024),
	}
}

// Subscribe connects a pre-registered channel after capturePane has returned.
// pending holds only output sequenced after the capture response, so baseline
// plus pending is exactly-once at the live/capture handoff.
func (b *TmuxBackend) Subscribe(ch <-chan paneOutput, baseline, pending []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return fmt.Errorf("backend already closed")
	}
	if b.outputCh != nil {
		return fmt.Errorf("backend already subscribed")
	}
	b.baseline = append([]byte(nil), baseline...)
	b.copyBuffer = append([]byte(nil), pending...)
	b.outputCh = ch
	return nil
}

// Baseline returns the captured baseline output from the pane capture.
func (b *TmuxBackend) Baseline() []byte {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return append([]byte(nil), b.baseline...)
}

// TakeBaseline returns and clears the captured baseline output.
func (b *TmuxBackend) TakeBaseline() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	base := b.baseline
	b.baseline = nil
	return base
}

// Read implements io.Reader and preserves chunks larger than the caller buffer.
func (b *TmuxBackend) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return 0, fmt.Errorf("backend closed")
	}
	if len(b.baseline) > 0 {
		n := copy(p, b.baseline)
		b.baseline = b.baseline[n:]
		b.mu.Unlock()
		return n, nil
	}
	if len(b.copyBuffer) > 0 {
		n := copy(p, b.copyBuffer)
		b.copyBuffer = b.copyBuffer[n:]
		b.mu.Unlock()
		return n, nil
	}
	outputCh := b.outputCh
	b.mu.Unlock()

	if outputCh == nil {
		return 0, fmt.Errorf("tmux output subscription unavailable")
	}
	select {
	case <-b.done:
		return 0, fmt.Errorf("backend closed")
	case event, ok := <-outputCh:
		if !ok {
			return 0, fmt.Errorf("pane output closed")
		}
		b.mu.Lock()
		if b.closed {
			b.mu.Unlock()
			return 0, fmt.Errorf("backend closed")
		}
		n := copy(p, event.payload)
		b.copyBuffer = append(b.copyBuffer[:0], event.payload[n:]...)
		b.mu.Unlock()
		return n, nil
	}
}

// Write sends data to pane stdin.
func (b *TmuxBackend) Write(data []byte) (int, error) {
	b.mu.RLock()
	defer b.mu.RUnlock()

	if b.closed {
		return 0, fmt.Errorf("backend closed")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Send via SendKeys command
	return b.client.SendKey(ctx, b.paneID, data)
}

// Resize sets pane dimensions (cols, rows int to match TerminalBackend).
func (b *TmuxBackend) Resize(cols, rows int) error {
	b.mu.RLock()
	defer b.mu.RUnlock()

	if b.closed {
		return fmt.Errorf("backend closed")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	return b.client.ResizePane(ctx, b.paneID, cols, rows)
}

// Close detaches from pane (does not kill it).
func (b *TmuxBackend) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.closed {
		return nil
	}

	b.closed = true
	close(b.done)
	return nil
}

// Terminate explicitly kills the tmux session/pane and marks the backend closed.
func (b *TmuxBackend) Terminate(ctx context.Context) error {
	b.mu.Lock()
	alreadyClosed := b.closed
	b.closed = true
	if !alreadyClosed {
		close(b.done)
	}
	client := b.client
	sessionID := b.sessionID
	paneID := b.paneID
	b.mu.Unlock()

	if client == nil {
		return nil
	}
	var killErr error
	if sessionID != "" {
		killErr = client.KillSession(ctx, sessionID)
	} else if paneID != "" {
		killErr = client.KillPane(ctx, paneID)
	}
	_ = client.RefreshTopology(ctx)
	return killErr
}

// Alive reports if pane is still active.
func (b *TmuxBackend) Alive() bool {
	b.mu.RLock()
	defer b.mu.RUnlock()

	if b.closed {
		return false
	}

	snapshot := b.client.GetTopology()
	if snapshot == nil {
		return false
	}

	_, exists := snapshot.Panes[b.paneID]
	return exists
}

// Identity returns stable pane identity for logging.
func (b *TmuxBackend) Identity() string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return fmt.Sprintf("tmux:%s:%s:%s", b.sessionID, b.windowID, b.paneID)
}

// GetPaneID returns pane ID.
func (b *TmuxBackend) GetPaneID() string {
	return b.paneID
}
