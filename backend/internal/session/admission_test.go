package session

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/protocol"
	"github.com/agenticremote/agenticremote/backend/internal/tmux"
)

// Scenario A: MaxSessions=1, create A (200), create B (fails with ErrTooManySessions), terminate A, create B (success).
func TestAdmissionScenarioA_MaxSessionsTerminateRelease(t *testing.T) {
	tmpDir := t.TempDir()
	stateDir := filepath.Join(tmpDir, "state")
	manager, err := NewManager(tmpDir, stateDir, tmpDir, 1<<20, 256, nil)
	if err != nil {
		t.Fatalf("NewManager failed: %v", err)
	}
	defer manager.Shutdown()
	manager.SetMaxSessions(1)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	sA, err := manager.Create(ctx, protocol.CreateSessionRequest{
		Name:    "session-A",
		Command: "sh",
		Args:    []string{"-c", "sleep 100"},
		Backend: "pty",
	})
	if err != nil {
		t.Fatalf("Create A failed: %v", err)
	}

	if active := manager.ActiveSessions(); active != 1 {
		t.Fatalf("expected activeSessions=1, got %d", active)
	}

	_, err = manager.Create(ctx, protocol.CreateSessionRequest{
		Name:    "session-B",
		Command: "sh",
		Args:    []string{"-c", "sleep 100"},
		Backend: "pty",
	})
	if !errors.Is(err, ErrTooManySessions) {
		t.Fatalf("expected ErrTooManySessions, got %v", err)
	}

	if err := manager.Terminate(ctx, sA.ID); err != nil {
		t.Fatalf("Terminate A failed: %v", err)
	}

	if active := manager.ActiveSessions(); active != 0 {
		t.Fatalf("expected activeSessions=0 after terminate, got %d", active)
	}

	sB, err := manager.Create(ctx, protocol.CreateSessionRequest{
		Name:    "session-B",
		Command: "sh",
		Args:    []string{"-c", "sleep 100"},
		Backend: "pty",
	})
	if err != nil {
		t.Fatalf("Create B after terminating A failed: %v", err)
	}

	_ = manager.Terminate(ctx, sB.ID)
}

// Scenario B: Natural exit: MaxSessions=1, create short-lived command, wait for exit, create B (success).
func TestAdmissionScenarioB_NaturalExitRelease(t *testing.T) {
	tmpDir := t.TempDir()
	stateDir := filepath.Join(tmpDir, "state")
	manager, err := NewManager(tmpDir, stateDir, tmpDir, 1<<20, 256, nil)
	if err != nil {
		t.Fatalf("NewManager failed: %v", err)
	}
	defer manager.Shutdown()
	manager.SetMaxSessions(1)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	sA, err := manager.Create(ctx, protocol.CreateSessionRequest{
		Name:    "session-short",
		Command: "sh",
		Args:    []string{"-c", "exit 0"},
		Backend: "pty",
	})
	if err != nil {
		t.Fatalf("Create short-lived A failed: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	var sB *protocol.SessionSummary
	for time.Now().Before(deadline) {
		sB, err = manager.Create(ctx, protocol.CreateSessionRequest{
			Name:    "session-B",
			Command: "sh",
			Args:    []string{"-c", "sleep 100"},
			Backend: "pty",
		})
		if err == nil {
			break
		}
		if !errors.Is(err, ErrTooManySessions) {
			t.Fatalf("unexpected create error: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if sB == nil {
		t.Fatalf("Create B failed after natural exit of A: %v", err)
	}

	_ = manager.Close(sA.ID)
	_ = manager.Terminate(ctx, sB.ID)
}

// Scenario C: Restored historical EXITED session: restart manager with exited row -> consumes 0 slots, create succeeds up to max.
func TestAdmissionScenarioC_RestoredExitedConsumesZeroSlots(t *testing.T) {
	tmpDir := t.TempDir()
	stateDir := filepath.Join(tmpDir, "state")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Step 1: Create manager 1, create and exit a session
	m1, err := NewManager(tmpDir, stateDir, tmpDir, 1<<20, 256, nil)
	if err != nil {
		t.Fatalf("NewManager 1 failed: %v", err)
	}
	m1.SetMaxSessions(1)

	s1, err := m1.Create(ctx, protocol.CreateSessionRequest{
		Name:    "historical-1",
		Command: "sh",
		Args:    []string{"-c", "echo hello"},
		Backend: "pty",
	})
	if err != nil {
		t.Fatalf("Create s1 failed: %v", err)
	}

	// Wait for s1 to finish and shutdown m1
	time.Sleep(200 * time.Millisecond)
	if err := m1.Shutdown(); err != nil {
		t.Fatalf("m1 Shutdown failed: %v", err)
	}

	// Step 2: Start manager 2 against same stateDir
	m2, err := NewManager(tmpDir, stateDir, tmpDir, 1<<20, 256, nil)
	if err != nil {
		t.Fatalf("NewManager 2 failed: %v", err)
	}
	defer m2.Shutdown()
	m2.SetMaxSessions(1)

	// Restored session must consume 0 slots
	if active := m2.ActiveSessions(); active != 0 {
		t.Fatalf("expected activeSessions=0 for restored exited sessions, got %d", active)
	}

	// Closing/terminating historical session must not drive counter negative
	if err := m2.Close(s1.ID); err != nil {
		t.Fatalf("Close restored session failed: %v", err)
	}
	if active := m2.ActiveSessions(); active != 0 {
		t.Fatalf("expected activeSessions=0 after closing restored session, got %d", active)
	}

	// Creating a new session must succeed up to maxSessions=1
	s2, err := m2.Create(ctx, protocol.CreateSessionRequest{
		Name:    "session-new",
		Command: "sh",
		Args:    []string{"-c", "sleep 100"},
		Backend: "pty",
	})
	if err != nil {
		t.Fatalf("Create new session failed: %v", err)
	}
	if active := m2.ActiveSessions(); active != 1 {
		t.Fatalf("expected activeSessions=1, got %d", active)
	}

	_ = m2.Terminate(ctx, s2.ID)
}

// Scenario D & E: Restored tmux ACTIVE session: MaxSessions=1, create tmux session A,
// simulate daemon restart / ReconcileTmux reattaches A -> create B fails with ErrTooManySessions.
// Following D, explicitly terminate A -> create B succeeds (Scenario E).
func TestAdmissionScenarioDAndE_RestoredTmuxActiveCapacityAndRelease(t *testing.T) {
	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux not found in PATH")
	}

	tmpDir := t.TempDir()
	stateDir := filepath.Join(tmpDir, "state")
	tmuxDir := filepath.Join(stateDir, "tmux")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	// Manager 1
	m1, err := NewManager(tmpDir, stateDir, tmpDir, 1<<20, 256, nil)
	if err != nil {
		t.Fatalf("NewManager 1 failed: %v", err)
	}
	m1.SetMaxSessions(1)

	client1 := tmux.NewControlClient(tmuxDir, tmuxPath)
	if err := client1.Start(ctx); err != nil {
		t.Fatalf("client1 Start: %v", err)
	}
	m1.SetTmux(client1)

	sA, err := m1.Create(ctx, protocol.CreateSessionRequest{
		Name:    "tmux-A",
		Command: "sh",
		Args:    []string{"-c", "sleep 100"},
		Backend: "tmux",
	})
	if err != nil {
		t.Fatalf("Create tmux A failed: %v", err)
	}

	if active := m1.ActiveSessions(); active != 1 {
		t.Fatalf("m1 activeSessions expected 1, got %d", active)
	}

	// Simulate daemon exit without killing tmux server:
	// Do NOT call client1.Close() (which would terminate tmux server if last client);
	// m1.Shutdown closes manager runtime store and internal workers.
	_ = m1.Shutdown()

	// Manager 2 (daemon restart)
	m2, err := NewManager(tmpDir, stateDir, tmpDir, 1<<20, 256, nil)
	if err != nil {
		t.Fatalf("NewManager 2 failed: %v", err)
	}
	defer m2.Shutdown()

	// Configure maxSessions BEFORE ReconcileTmux
	m2.SetMaxSessions(1)

	client2 := tmux.NewControlClient(tmuxDir, tmuxPath)
	if err := client2.Start(ctx); err != nil {
		t.Fatalf("client2 Start: %v", err)
	}
	defer client2.Close()
	m2.SetTmux(client2)

	if err := m2.ReconcileTmux(ctx); err != nil {
		t.Fatalf("ReconcileTmux failed: %v", err)
	}

	// Restored active tmux session must own 1 admission slot
	if active := m2.ActiveSessions(); active != 1 {
		t.Fatalf("m2 activeSessions expected 1 after ReconcileTmux, got %d", active)
	}

	// Scenario D: Creating B must fail with ErrTooManySessions
	_, err = m2.Create(ctx, protocol.CreateSessionRequest{
		Name:    "tmux-B",
		Command: "sh",
		Args:    []string{"-c", "sleep 100"},
		Backend: "tmux",
	})
	if !errors.Is(err, ErrTooManySessions) {
		t.Fatalf("expected ErrTooManySessions when maxSessions=1 and tmux restored, got %v", err)
	}

	// Scenario E: Explicitly terminate restored session A -> creates B succeeds
	if err := m2.Terminate(ctx, sA.ID); err != nil {
		t.Fatalf("Terminate restored sA failed: %v", err)
	}

	if active := m2.ActiveSessions(); active != 0 {
		t.Fatalf("expected activeSessions=0 after terminating restored sA, got %d", active)
	}

	sB, err := m2.Create(ctx, protocol.CreateSessionRequest{
		Name:    "tmux-B",
		Command: "sh",
		Args:    []string{"-c", "sleep 100"},
		Backend: "tmux",
	})
	if err != nil {
		t.Fatalf("Create B failed after terminating A: %v", err)
	}
	if active := m2.ActiveSessions(); active != 1 {
		t.Fatalf("expected activeSessions=1 after creating B, got %d", active)
	}

	_ = m2.Terminate(ctx, sB.ID)
}

// Scenario F: No negative accounting under concurrent Close, Terminate, markExited, Shutdown.
func TestAdmissionScenarioF_NoNegativeAccounting(t *testing.T) {
	tmpDir := t.TempDir()
	stateDir := filepath.Join(tmpDir, "state")
	manager, err := NewManager(tmpDir, stateDir, tmpDir, 1<<20, 256, nil)
	if err != nil {
		t.Fatalf("NewManager failed: %v", err)
	}
	defer manager.Shutdown()
	manager.SetMaxSessions(5)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Create 5 sessions
	var sessions []*protocol.SessionSummary
	for i := 0; i < 5; i++ {
		s, err := manager.Create(ctx, protocol.CreateSessionRequest{
			Name:    "concurrent-sess",
			Command: "sh",
			Args:    []string{"-c", "sleep 100"},
			Backend: "pty",
		})
		if err != nil {
			t.Fatalf("create session %d: %v", i, err)
		}
		sessions = append(sessions, s)
	}

	// Concurrently hammer Close, Terminate, markExited, releaseAdmission
	var wg sync.WaitGroup
	for _, s := range sessions {
		sessID := s.ID
		manager.mu.Lock()
		rt := manager.sessions[sessID]
		manager.mu.Unlock()

		for j := 0; j < 5; j++ {
			wg.Add(4)
			go func() {
				defer wg.Done()
				_ = manager.Close(sessID)
			}()
			go func() {
				defer wg.Done()
				_ = manager.Terminate(ctx, sessID)
			}()
			go func() {
				defer wg.Done()
				if rt != nil {
					manager.markExited(rt)
				}
			}()
			go func() {
				defer wg.Done()
				if rt != nil {
					manager.releaseAdmission(rt)
				}
			}()
		}
	}

	// Also call releaseAdmission on unadmitted dummy runtimes
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			dummy := &TerminalRuntime{}
			manager.releaseAdmission(dummy)
		}()
	}

	wg.Wait()

	if active := manager.activeSessions.Load(); active < 0 {
		t.Fatalf("activeSessions became negative: %d", active)
	}
	if active := manager.ActiveSessions(); active != 0 {
		t.Fatalf("expected 0 active sessions after all terminated, got %d", active)
	}
}
