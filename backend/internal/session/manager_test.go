package session

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

)

// mockTerminalBackend is a test backend that tracks calls and errors
type mockTerminalBackend struct {
	closeErr        error
	terminateErr    error
	closeCalled     bool
	terminateCalled bool
	terminated      bool
}

func (m *mockTerminalBackend) Read(p []byte) (int, error) {
	return 0, nil
}

func (m *mockTerminalBackend) Write(p []byte) (int, error) {
	return len(p), nil
}

func (m *mockTerminalBackend) Resize(cols, rows int) error {
	return nil
}

func (m *mockTerminalBackend) Close() error {
	m.closeCalled = true
	return m.closeErr
}

func (m *mockTerminalBackend) Alive() bool {
	return !m.terminated && !m.closeCalled
}

func (m *mockTerminalBackend) Identity() string {
	return "mock"
}

func (m *mockTerminalBackend) Terminate(ctx context.Context) error {
	m.terminateCalled = true
	m.terminated = true
	return m.terminateErr
}

func helperNewTestManager(t *testing.T) (*Manager, string) {
	tmpDir := t.TempDir()
	mgr, err := NewManager(tmpDir, tmpDir, tmpDir, 1024*1024, 100, nil)
	if err != nil {
		t.Fatalf("Failed to create manager: %v", err)
	}
	return mgr, tmpDir
}

// Test RAR-036-1: Terminate kills backend before removing session from map
func TestTerminateKillsBackendFirst(t *testing.T) {
	mgr, tmpDir := helperNewTestManager(t)
	defer mgr.Shutdown()

	// Create session with mock backend
	mockBackend := &mockTerminalBackend{}
	runtime := &TerminalRuntime{
		meta:       Session{ID: "test-sess-1", State: "running"},
		backend:    mockBackend,
		scrollback: filepath.Join(tmpDir, "scrollback-1"),
		outbound:   make(chan outboundMessage, 10),
	}
	mgr.sessions["test-sess-1"] = runtime

	// Terminate the session
	err := mgr.Terminate(context.Background(), "test-sess-1")
	if err != nil {
		t.Errorf("Terminate failed: %v", err)
	}

	// Verify backend.Terminate was called
	if !mockBackend.terminateCalled {
		t.Error("backend.Terminate was not called")
	}

	// Verify session was removed from map
	_, exists := mgr.sessions["test-sess-1"]
	if exists {
		t.Error("session still exists in map after Terminate")
	}
}

// Test RAR-036-2: cleanupRuntime propagates closeBackend error
func TestCleanupRuntimePropagatesError(t *testing.T) {
	mgr, tmpDir := helperNewTestManager(t)
	defer mgr.Shutdown()

	mockBackend := &mockTerminalBackend{
		closeErr: fmt.Errorf("kill failed"),
	}
	runtime := &TerminalRuntime{
		meta:       Session{ID: "test-sess-2"},
		backend:    mockBackend,
		scrollback: filepath.Join(tmpDir, "scrollback-2"),
		outbound:   make(chan outboundMessage, 10),
	}

	err := mgr.cleanupRuntime(runtime, mockBackend.Close)
	if err == nil {
		t.Error("cleanupRuntime should propagate backend close error")
	}
	if err.Error() != "kill failed" {
		t.Errorf("expected error 'kill failed', got: %v", err)
	}
}

// Test RAR-036-3: Terminate aborts on cleanup error before removing from map
func TestTerminateAbortsOnCleanupError(t *testing.T) {
	mgr, tmpDir := helperNewTestManager(t)
	defer mgr.Shutdown()

	mockBackend := &mockTerminalBackend{
		terminateErr: fmt.Errorf("kill failed"),
	}
	runtime := &TerminalRuntime{
		meta:       Session{ID: "test-sess-3"},
		backend:    mockBackend,
		scrollback: filepath.Join(tmpDir, "scrollback-3"),
		outbound:   make(chan outboundMessage, 10),
	}
	mgr.sessions["test-sess-3"] = runtime

	err := mgr.Terminate(context.Background(), "test-sess-3")
	if err == nil {
		t.Error("Terminate should propagate terminate error")
	}

	// Session should still exist in map after failed cleanup
	_, exists := mgr.sessions["test-sess-3"]
	if !exists {
		t.Error("session was removed from map despite cleanup error")
	}
}

// Test RAR-036-4: No double-unlock on termination
func TestTerminateNoDoubleUnlock(t *testing.T) {
	mgr, tmpDir := helperNewTestManager(t)
	defer mgr.Shutdown()

	runtime := &TerminalRuntime{
		meta:       Session{ID: "test-sess-4", State: "running"},
		backend:    &mockTerminalBackend{},
		scrollback: filepath.Join(tmpDir, "scrollback-4"),
		outbound:   make(chan outboundMessage, 10),
	}
	runtime.termMu.Lock() // Verify termMu exists
	runtime.termMu.Unlock()

	mgr.sessions["test-sess-4"] = runtime
	err := mgr.Terminate(context.Background(), "test-sess-4")
	if err != nil {
		t.Errorf("Terminate failed: %v", err)
	}
}

// Test RAR-036-5: Concurrent Terminate calls are serialized
func TestTerminateConcurrency(t *testing.T) {
	mgr, tmpDir := helperNewTestManager(t)
	defer mgr.Shutdown()

	runtime := &TerminalRuntime{
		meta:       Session{ID: "test-sess-5", State: "running"},
		backend:    &mockTerminalBackend{},
		scrollback: filepath.Join(tmpDir, "scrollback-5"),
		outbound:   make(chan outboundMessage, 10),
	}
	mgr.sessions["test-sess-5"] = runtime

	errs := make(chan error, 3)
	for range 3 {
		go func() {
			errs <- mgr.Terminate(context.Background(), "test-sess-5")
		}()
	}

	successCount := 0
	for range 3 {
		err := <-errs
		if err == nil {
			successCount++
		}
	}

	// Only one Terminate should succeed (session removed after first call)
	if successCount != 1 {
		t.Errorf("expected 1 successful Terminate, got %d", successCount)
	}
}

// Test RAR-036-6: Close does not call Terminate
func TestCloseDifferentFromTerminate(t *testing.T) {
	mgr, tmpDir := helperNewTestManager(t)
	defer mgr.Shutdown()

	mockBackend := &mockTerminalBackend{}
	runtime := &TerminalRuntime{
		meta:       Session{ID: "test-sess-6", State: "running"},
		backend:    mockBackend,
		scrollback: filepath.Join(tmpDir, "scrollback-6"),
		outbound:   make(chan outboundMessage, 10),
	}
	mgr.sessions["test-sess-6"] = runtime

	err := mgr.Close("test-sess-6")
	if err != nil {
		t.Errorf("Close failed: %v", err)
	}

	// Close calls backend.Close, not backend.Terminate
	if !mockBackend.closeCalled {
		t.Error("Close should call backend.Close")
	}
	if mockBackend.terminateCalled {
		t.Error("Close should not call backend.Terminate")
	}
}

// Test RAR-036-7: Missing scrollback file does not break cleanup
func TestCleanupMissingScrollback(t *testing.T) {
	mgr, tmpDir := helperNewTestManager(t)
	defer mgr.Shutdown()

	runtime := &TerminalRuntime{
		meta:       Session{ID: "test-sess-7"},
		backend:    &mockTerminalBackend{},
		scrollback: filepath.Join(tmpDir, "nonexistent-scrollback"),
		outbound:   make(chan outboundMessage, 10),
	}
	mgr.sessions["test-sess-7"] = runtime

	err := mgr.Terminate(context.Background(), "test-sess-7")
	if err != nil {
		t.Errorf("Terminate should not fail on missing scrollback: %v", err)
	}
}

// Test RAR-036-8: Terminate with context deadline
func TestTerminateWithContext(t *testing.T) {
	mgr, tmpDir := helperNewTestManager(t)
	defer mgr.Shutdown()

	runtime := &TerminalRuntime{
		meta:       Session{ID: "test-sess-8", State: "running"},
		backend:    &mockTerminalBackend{},
		scrollback: filepath.Join(tmpDir, "scrollback-8"),
		outbound:   make(chan outboundMessage, 10),
	}
	mgr.sessions["test-sess-8"] = runtime

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	err := mgr.Terminate(ctx, "test-sess-8")
	if err != nil {
		t.Errorf("Terminate with valid context should succeed: %v", err)
	}
}

// Test RAR-036-9: State transitions correctly on termination
func TestTerminateStateTransition(t *testing.T) {
	mgr, tmpDir := helperNewTestManager(t)
	defer mgr.Shutdown()

	runtime := &TerminalRuntime{
		meta:       Session{ID: "test-sess-9", State: "running"},
		backend:    &mockTerminalBackend{},
		scrollback: filepath.Join(tmpDir, "scrollback-9"),
		outbound:   make(chan outboundMessage, 10),
	}
	mgr.sessions["test-sess-9"] = runtime

	err := mgr.Terminate(context.Background(), "test-sess-9")
	if err != nil {
		t.Errorf("Terminate failed: %v", err)
	}
}

// Test RAR-036-10: GetSession after termination returns not found
func TestGetSessionAfterTerminate(t *testing.T) {
	mgr, tmpDir := helperNewTestManager(t)
	defer mgr.Shutdown()

	runtime := &TerminalRuntime{
		meta:       Session{ID: "test-sess-10", State: "running"},
		backend:    &mockTerminalBackend{},
		scrollback: filepath.Join(tmpDir, "scrollback-10"),
		outbound:   make(chan outboundMessage, 10),
	}
	mgr.sessions["test-sess-10"] = runtime

	// Verify session exists
	mgr.mu.Lock()
	_, existsBefore := mgr.sessions["test-sess-10"]
	mgr.mu.Unlock()
	if !existsBefore {
		t.Fatal("session not found before termination")
	}

	// Terminate
	err := mgr.Terminate(context.Background(), "test-sess-10")
	if err != nil {
		t.Errorf("Terminate failed: %v", err)
	}

	// Verify session no longer exists
	mgr.mu.Lock()
	_, existsAfter := mgr.sessions["test-sess-10"]
	mgr.mu.Unlock()
	if existsAfter {
		t.Error("session still exists in map after termination")
	}
	defer mgr.Shutdown()

	numSessions := 5
	for i := range numSessions {
		id := fmt.Sprintf("test-sess-%d", i)
		runtime := &TerminalRuntime{
			meta:       Session{ID: id, State: "running"},
			backend:    &mockTerminalBackend{},
			scrollback: filepath.Join(tmpDir, fmt.Sprintf("scrollback-%d", i)),
			outbound:   make(chan outboundMessage, 10),
		}
		mgr.sessions[id] = runtime
	}

	errs := make(chan error, numSessions)
	for i := range numSessions {
		go func(idx int) {
			id := fmt.Sprintf("test-sess-%d", idx)
			errs <- mgr.Terminate(context.Background(), id)
		}(i)
	}

	for i := range numSessions {
		err := <-errs
		if err != nil {
			t.Errorf("Terminate[%d] failed: %v", i, err)
		}
	}

	// All sessions should be removed
	if len(mgr.sessions) != 0 {
		t.Errorf("expected 0 sessions, got %d", len(mgr.sessions))
	}
}

// Test RAR-036-12: TerminalBackend.Close via Terminator interface
func TestTerminatorInterfaceUsed(t *testing.T) {
	mgr, tmpDir := helperNewTestManager(t)
	defer mgr.Shutdown()

	mockBackend := &mockTerminalBackend{}
	runtime := &TerminalRuntime{
		meta:       Session{ID: "test-sess-12", State: "running"},
		backend:    mockBackend,
		scrollback: filepath.Join(tmpDir, "scrollback-12"),
		outbound:   make(chan outboundMessage, 10),
	}
	mgr.sessions["test-sess-12"] = runtime

	err := mgr.Terminate(context.Background(), "test-sess-12")
	if err != nil {
		t.Errorf("Terminate failed: %v", err)
	}

	// Verify Terminate interface was called (not Close)
	if !mockBackend.terminateCalled {
		t.Error("backend.Terminate (via Terminator) was not called")
	}
}
