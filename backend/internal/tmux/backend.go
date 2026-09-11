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
	outputCh   <-chan []byte // subscribed after baseline capture
	done       chan struct{}
	copyBuffer []byte // baseline + live output buffered for Read caller
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

// Subscribe starts listening to pane output after baseline is injected into copyBuffer.
// baseline is the captured history before subscription; live events come after.
func (b *TmuxBackend) Subscribe(baseline []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return fmt.Errorf("backend already closed")
	}
	if b.outputCh != nil {
		return fmt.Errorf("backend already subscribed")
	}
	b.copyBuffer = baseline
	ch := b.client.SubscribePaneOutput(b.paneID)
	b.outputCh = ch
	return nil
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
	case data, ok := <-outputCh:
		if !ok {
			return 0, fmt.Errorf("pane output closed")
		}
		b.mu.Lock()
		if b.closed {
			b.mu.Unlock()
			return 0, fmt.Errorf("backend closed")
		}
		n := copy(p, data)
		b.copyBuffer = append(b.copyBuffer[:0], data[n:]...)
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
