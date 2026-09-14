package session

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/protocol"
	"github.com/agenticremote/agenticremote/backend/internal/tmux"
)

// TestManagerEmptyCWDUsesDefaultCWD verifies that empty request CWD uses injected default home.
func TestManagerEmptyCWDUsesDefaultCWD(t *testing.T) {
	tmpDir := t.TempDir()
	defaultHome := filepath.Join(tmpDir, "home")
	if err := os.MkdirAll(defaultHome, 0o755); err != nil {
		t.Fatal(err)
	}

	stateDir := filepath.Join(tmpDir, "state")
	workspaceRoot := filepath.Join(tmpDir, "workspace")

	manager, err := NewManager(defaultHome, stateDir, workspaceRoot, 1<<20, 256, nil)
	if err != nil {
		t.Fatalf("NewManager failed: %v", err)
	}
	defer manager.Shutdown()

	summary, err := manager.Create(context.Background(), protocol.CreateSessionRequest{
		Name:    "test",
		Command: "sh",
		Args:    []string{"-c", "echo $PWD"},
		CWD:     "", // empty CWD should use defaultHome
	})
	if err != nil {
		t.Fatalf("Create with empty CWD failed: %v", err)
	}
	defer manager.Close(summary.ID)

	if summary.CWD != defaultHome {
		t.Errorf("expected CWD %s, got %s", defaultHome, summary.CWD)
	}
}

// TestManagerExplicitCWDWins verifies that explicit CWD is used even when defaultCWD is set.
func TestManagerExplicitCWDWins(t *testing.T) {
	tmpDir := t.TempDir()
	defaultHome := filepath.Join(tmpDir, "home")
	if err := os.MkdirAll(defaultHome, 0o755); err != nil {
		t.Fatal(err)
	}

	explicitCWD := filepath.Join(tmpDir, "explicit")
	if err := os.MkdirAll(explicitCWD, 0o755); err != nil {
		t.Fatal(err)
	}

	stateDir := filepath.Join(tmpDir, "state")
	workspaceRoot := filepath.Join(tmpDir, "workspace")

	manager, err := NewManager(defaultHome, stateDir, workspaceRoot, 1<<20, 256, nil)
	if err != nil {
		t.Fatalf("NewManager failed: %v", err)
	}
	defer manager.Shutdown()

	summary, err := manager.Create(context.Background(), protocol.CreateSessionRequest{
		Name:    "test",
		Command: "sh",
		Args:    []string{"-c", "pwd"},
		CWD:     explicitCWD,
	})
	if err != nil {
		t.Fatalf("Create with explicit CWD failed: %v", err)
	}
	defer manager.Close(summary.ID)

	if summary.CWD != explicitCWD {
		t.Errorf("expected CWD %s, got %s", explicitCWD, summary.CWD)
	}
}

// TestManagerInvalidDefaultHomeDeterministicError verifies that invalid default home produces deterministic error.
func TestManagerInvalidDefaultHomeDeterministicError(t *testing.T) {
	tmpDir := t.TempDir()
	nonExistentHome := filepath.Join(tmpDir, "nonexistent")

	stateDir := filepath.Join(tmpDir, "state")
	workspaceRoot := filepath.Join(tmpDir, "workspace")

	manager, err := NewManager(nonExistentHome, stateDir, workspaceRoot, 1<<20, 256, nil)
	if err != nil {
		t.Logf("NewManager with invalid home returned error as expected: %v", err)
		return
	}
	defer manager.Shutdown()

	// If NewManager succeeds (with nonexistent home), Create with empty CWD must fail consistently
	_, createErr := manager.Create(context.Background(), protocol.CreateSessionRequest{
		Name:    "test",
		Command: "sh",
		CWD:     "",
	})
	if createErr == nil {
		t.Error("expected Create to fail with invalid default home, got nil")
	}
}

// TestManagerEmptyCommandUsesDefaultShell verifies that empty request Command
// resolves via defaultShell() (honoring $SHELL) instead of being left empty
// or silently defaulting to bash.
func TestManagerEmptyCommandUsesDefaultShell(t *testing.T) {
	tmpDir := t.TempDir()
	defaultHome := filepath.Join(tmpDir, "home")
	if err := os.MkdirAll(defaultHome, 0o755); err != nil {
		t.Fatal(err)
	}

	fakeShell := filepath.Join(tmpDir, "fake-shell")
	if err := os.WriteFile(fakeShell, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHELL", fakeShell)

	stateDir := filepath.Join(tmpDir, "state")
	workspaceRoot := filepath.Join(tmpDir, "workspace")

	manager, err := NewManager(defaultHome, stateDir, workspaceRoot, 1<<20, 256, nil)
	if err != nil {
		t.Fatalf("NewManager failed: %v", err)
	}
	defer manager.Shutdown()

	summary, err := manager.Create(context.Background(), protocol.CreateSessionRequest{
		Name:    "test",
		Command: "",
		CWD:     defaultHome,
	})
	if err != nil {
		t.Fatalf("Create with empty Command failed: %v", err)
	}
	defer manager.Close(summary.ID)

	if summary.Command != fakeShell {
		t.Errorf("expected Command %s (from $SHELL), got %s", fakeShell, summary.Command)
	}
}

func TestAvailableShellsNonEmpty(t *testing.T) {
	shells := AvailableShells()
	if len(shells) == 0 {
		t.Fatal("AvailableShells returned empty list")
	}
	for i, shell := range shells {
		if shell == "" {
			t.Errorf("shell at index %d is empty string", i)
		}
	}
}

// TestManagerCreateSetsTermAndPreservesEnv verifies the child PTY receives a
// real TERM capability plus the full inherited daemon environment, guarding
// against a regression that replaces os.Environ() with a TERM-only slice.
func TestManagerCreateSetsTermAndPreservesEnv(t *testing.T) {
	tmpDir := t.TempDir()
	defaultHome := filepath.Join(tmpDir, "home")
	if err := os.MkdirAll(defaultHome, 0o755); err != nil {
		t.Fatal(err)
	}
	stateDir := filepath.Join(tmpDir, "state")
	workspaceRoot := filepath.Join(tmpDir, "workspace")

	t.Setenv("AGENTIC_REMOTE_TEST_SENTINEL", "sentinel-value-123")

	manager, err := NewManager(defaultHome, stateDir, workspaceRoot, 1<<20, 256, nil)
	if err != nil {
		t.Fatalf("NewManager failed: %v", err)
	}
	defer manager.Shutdown()

	summary, err := manager.Create(context.Background(), protocol.CreateSessionRequest{
		Name:    "test",
		Command: "sh",
		Args:    []string{"-c", "echo TERM=$TERM SENTINEL=$AGENTIC_REMOTE_TEST_SENTINEL"},
		CWD:     defaultHome,
	})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	defer manager.Close(summary.ID)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for ctx.Err() == nil {
		preview := strings.Join(manager.List(context.Background())[0].Preview, "\n")
		if strings.Contains(preview, "SENTINEL=") {
			if !strings.Contains(preview, "TERM=xterm-256color") {
				t.Fatalf("expected TERM=xterm-256color in preview, got %q", preview)
			}
			if !strings.Contains(preview, "SENTINEL=sentinel-value-123") {
				t.Fatalf("expected inherited sentinel env var in preview, got %q", preview)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal(ctx.Err())
}

func TestManagerRestoresPreviewFromScrollback(t *testing.T) {
	tmpDir := t.TempDir()
	defaultHome := filepath.Join(tmpDir, "home")
	if err := os.MkdirAll(defaultHome, 0o755); err != nil {
		t.Fatal(err)
	}
	stateDir := filepath.Join(tmpDir, "state")

	manager, err := NewManager(defaultHome, stateDir, filepath.Join(tmpDir, "workspace"), 1<<20, 256, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Shutdown()
	created, err := manager.Create(context.Background(), protocol.CreateSessionRequest{
		Name: "persisted", Command: "sh", Args: []string{"-c", "printf 'preview survives restart\\n'"}, CWD: defaultHome,
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for ctx.Err() == nil {
		current := manager.List(context.Background())[0]
		if current.State == string(StateExited) && strings.Contains(strings.Join(current.Preview, "\n"), "preview survives restart") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if ctx.Err() != nil {
		t.Fatal(ctx.Err())
	}

	restored, err := NewManager(defaultHome, stateDir, filepath.Join(tmpDir, "workspace"), 1<<20, 256, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Shutdown()
	sessions := restored.List(context.Background())
	if len(sessions) != 1 || sessions[0].ID != created.ID {
		t.Fatalf("expected restored session %q, got %+v", created.ID, sessions)
	}
	if preview := strings.Join(sessions[0].Preview, "\n"); !strings.Contains(preview, "preview survives restart") {
		t.Fatalf("expected restored preview, got %q", preview)
	}
}

func TestManagerCloseRestoredSession(t *testing.T) {
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	stateDir := filepath.Join(dir, "state")
	manager, err := NewManager(home, stateDir, home, 1<<20, 256, nil)
	if err != nil {
		t.Fatal(err)
	}
	created, err := manager.Create(context.Background(), protocol.CreateSessionRequest{Name: "restored", Command: "sh", Args: []string{"-c", "true"}, CWD: home})
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Shutdown(); err != nil {
		t.Fatal(err)
	}
	restored, err := NewManager(home, stateDir, home, 1<<20, 256, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Shutdown()
	if err := restored.Close(created.ID); err != nil {
		t.Fatal(err)
	}
}

func TestManagerCreateRollsBackTerminalWhenTopologyPersistenceFails(t *testing.T) {
	tmpDir := t.TempDir()
	manager, err := NewManager(tmpDir, filepath.Join(tmpDir, "state"), tmpDir, 1<<20, 16, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Shutdown()
	manager.recordTopology = func() error { return errors.New("topology unavailable") }
	if _, err := manager.Create(context.Background(), protocol.CreateSessionRequest{Name: "test", Command: "sh", Args: []string{"-c", "sleep 60"}}); err == nil {
		t.Fatal("Create succeeded despite topology persistence failure")
	}
	snapshot, err := manager.RuntimeSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Terminals) != 0 {
		t.Fatalf("terminal projection survived rollback: %+v", snapshot.Terminals)
	}
}

func TestManagerMarksTmuxRuntimesLostWithoutRecreating(t *testing.T) {
	tmpDir := t.TempDir()
	manager, err := NewManager(tmpDir, filepath.Join(tmpDir, "state"), tmpDir, 1<<20, 16, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Shutdown()
	client := tmux.NewControlClient(tmpDir, "tmux")
	backend := tmux.NewTmuxBackend(client, "%0", "$0", "@0")
	now := time.Now().UTC()
	runtime := &TerminalRuntime{meta: Session{ID: "session-1", Name: "tmux-term", State: StateRunning, CreatedAt: now, UpdatedAt: now}, backend: backend, scrollback: filepath.Join(tmpDir, "session-1.scrollback"), outbound: make(chan outboundMessage, 16)}
	manager.sessions["session-1"] = runtime
	manager.SetTmux(client)
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	// Close by client does not signal Lost; simulate unexpected server loss
	manager.markTmuxRuntimesLost()
	summary := manager.List(context.Background())
	if len(summary) != 1 || summary[0].State != string(StateExited) {
		t.Fatalf("unexpected summary state: %+v", summary)
	}
}

// TestManagerReconcileTmuxSurvivesDaemonRestart proves the Phase 3 acceptance
// path: killing the daemon process leaves the tmux pane alive, and a fresh
// Manager pointed at the same private tmux socket recovers a running,
// readable backend for the persisted terminal without recreating the pane.
func TestManagerReconcileTmuxSurvivesDaemonRestart(t *testing.T) {
	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux not found in PATH")
	}
	tmpDir := t.TempDir()
	stateDir := filepath.Join(tmpDir, "state")
	tmuxStateDir := filepath.Join(stateDir, "tmux")

	manager1, err := NewManager(tmpDir, stateDir, tmpDir, 1<<20, 16, nil)
	if err != nil {
		t.Fatal(err)
	}
	client1 := tmux.NewControlClient(tmuxStateDir, tmuxPath)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := client1.Start(ctx); err != nil {
		t.Fatal(err)
	}
	manager1.SetTmux(client1)

	summary, err := manager1.Create(ctx, protocol.CreateSessionRequest{Name: "restart-test", Command: "sh", Args: []string{"-c", "printf alive; sleep 100"}})
	if err != nil {
		t.Fatalf("create tmux session: %v", err)
	}

	// Simulate the daemon process exiting: close only the local control
	// connection, not the tmux server, and drop the manager without Shutdown
	// so the tmux pane is never killed.
	if err := client1.Close(); err != nil {
		t.Fatal(err)
	}

	manager2, err := NewManager(tmpDir, stateDir, tmpDir, 1<<20, 16, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer manager2.Shutdown()
	client2 := tmux.NewControlClient(tmuxStateDir, tmuxPath)
	if err := client2.Start(ctx); err != nil {
		t.Fatal(err)
	}
	manager2.SetTmux(client2)
	if err := manager2.ReconcileTmux(ctx); err != nil {
		t.Fatalf("reconcile: %v", err)
	}

	summaries := manager2.List(ctx)
	var restored *TerminalRuntime
	manager2.mu.Lock()
	restored = manager2.sessions[summary.ID]
	manager2.mu.Unlock()
	if restored == nil || restored.backend == nil || !restored.backend.Alive() {
		t.Fatalf("session not reconciled to a live backend: %+v", summaries)
	}
	found := false
	for _, s := range summaries {
		if s.ID == summary.ID && s.State == string(StateRunning) {
			found = true
		}
	}
	if !found {
		t.Fatalf("reconciled session not running: %+v", summaries)
	}
}

func TestRecordOutputDoesNotPersistEveryChunk(t *testing.T) {
	stateDir := t.TempDir()
	manager, err := NewManager(stateDir, stateDir, stateDir, 1<<20, 128, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Shutdown()

	runtime := &TerminalRuntime{
		meta:       Session{ID: "high-output", State: StateRunning},
		scrollback: filepath.Join(stateDir, "sessions", "high-output.scrollback"),
		outbound:   make(chan outboundMessage, 128),
	}
	manager.mu.Lock()
	manager.sessions[runtime.meta.ID] = runtime
	manager.mu.Unlock()
	before, cursor, err := manager.RuntimeEvents(0, 200)
	if err != nil {
		t.Fatal(err)
	}
	for range 100 {
		manager.recordOutput(runtime, []byte("output\n"))
	}
	after, next, err := manager.RuntimeEvents(0, 200)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) || next != cursor {
		t.Fatalf("output created runtime events: before=%d/%d after=%d/%d", len(before), cursor, len(after), next)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "sessions", "sessions.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("output chunks persisted metadata: %v", err)
	}
}

func TestManagerCreateBackendPreference(t *testing.T) {
	tmpDir := t.TempDir()
	stateDir := filepath.Join(tmpDir, "state")
	manager, err := NewManager(tmpDir, stateDir, tmpDir, 1<<20, 16, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Shutdown()

	// Invalid backend returns an error
	_, err = manager.Create(context.Background(), protocol.CreateSessionRequest{
		Name:    "invalid",
		Command: "sh",
		Args:    []string{"-c", "true"},
		Backend: "unknown-backend",
	})
	if err == nil {
		t.Fatal("expected error for invalid backend, got nil")
	}

	// Explicit tmux backend when tmux is unavailable returns an error
	_, err = manager.Create(context.Background(), protocol.CreateSessionRequest{
		Name:    "tmux-unavail",
		Command: "sh",
		Args:    []string{"-c", "true"},
		Backend: "tmux",
	})
	if err == nil {
		t.Fatal("expected error for tmux backend when unavailable, got nil")
	}

	// Explicit pty backend creates direct PTY
	summary, err := manager.Create(context.Background(), protocol.CreateSessionRequest{
		Name:    "pty-session",
		Command: "sh",
		Args:    []string{"-c", "sleep 10"},
		Backend: "pty",
	})
	if err != nil {
		t.Fatalf("Create with Backend=pty failed: %v", err)
	}
	defer manager.Close(summary.ID)

	manager.mu.Lock()
	rt := manager.sessions[summary.ID]
	manager.mu.Unlock()
	if _, ok := rt.backend.(*PtyBackend); !ok {
		t.Fatalf("expected *PtyBackend, got %T", rt.backend)
	}
}

func TestManagerCreatePtyPreferenceWithTmuxEnabled(t *testing.T) {
	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux not found in PATH")
	}
	tmpDir := t.TempDir()
	stateDir := filepath.Join(tmpDir, "state")
	tmuxStateDir := filepath.Join(stateDir, "tmux")
	manager, err := NewManager(tmpDir, stateDir, tmpDir, 1<<20, 16, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Shutdown()

	client := tmux.NewControlClient(tmuxStateDir, tmuxPath)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := client.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	manager.SetTmux(client)

	// Requesting pty explicitly must create PtyBackend even though tmux is active
	ptySummary, err := manager.Create(ctx, protocol.CreateSessionRequest{
		Name:    "explicit-pty",
		Command: "sh",
		Args:    []string{"-c", "sleep 10"},
		Backend: "pty",
	})
	if err != nil {
		t.Fatalf("create explicit pty failed: %v", err)
	}
	defer manager.Close(ptySummary.ID)

	manager.mu.Lock()
	ptyRt := manager.sessions[ptySummary.ID]
	manager.mu.Unlock()
	if _, ok := ptyRt.backend.(*PtyBackend); !ok {
		t.Fatalf("expected *PtyBackend for explicit pty request, got %T", ptyRt.backend)
	}

	// Requesting default or auto uses tmux
	tmuxSummary, err := manager.Create(ctx, protocol.CreateSessionRequest{
		Name:    "default-tmux",
		Command: "sh",
		Args:    []string{"-c", "sleep 10"},
		Backend: "auto",
	})
	if err != nil {
		t.Fatalf("create default tmux failed: %v", err)
	}
	defer manager.Close(tmuxSummary.ID)

	manager.mu.Lock()
	tmuxRt := manager.sessions[tmuxSummary.ID]
	manager.mu.Unlock()
	if _, ok := tmuxRt.backend.(*tmux.TmuxBackend); !ok {
		t.Fatalf("expected *TmuxBackend for auto request, got %T", tmuxRt.backend)
	}
}

func TestManagerReconcileTmuxPersistsAndEmitsRunningStateAndReplacesScrollback(t *testing.T) {
	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux not found in PATH")
	}
	tmpDir := t.TempDir()
	stateDir := filepath.Join(tmpDir, "state")
	tmuxStateDir := filepath.Join(stateDir, "tmux")
	manager1, err := NewManager(tmpDir, stateDir, tmpDir, 1<<20, 16, nil)
	if err != nil {
		t.Fatal(err)
	}
	client1 := tmux.NewControlClient(tmuxStateDir, tmuxPath)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := client1.Start(ctx); err != nil {
		t.Fatal(err)
	}
	manager1.SetTmux(client1)
	summary, err := manager1.Create(ctx, protocol.CreateSessionRequest{
		Name:    "reconcile-state-test",
		Command: "sh",
		Args:    []string{"-c", "printf 'fresh-pane-output'; sleep 100"},
	})
	if err != nil {
		t.Fatalf("create tmux session: %v", err)
	}

	// Write fake stale data to the scrollback file on disk to simulate old scrollback before restart
	scrollbackPath := filepath.Join(stateDir, "sessions", summary.ID+".scrollback")
	if err := os.WriteFile(scrollbackPath, []byte("stale-old-scrollback-content-that-should-be-replaced\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Close control client without killing tmux server
	if err := client1.Close(); err != nil {
		t.Fatal(err)
	}

	manager2, err := NewManager(tmpDir, stateDir, tmpDir, 1<<20, 16, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer manager2.Shutdown()

	// Before ReconcileTmux, the session in manager2 is StateExited (from restore)
	manager2.mu.Lock()
	restoredBefore := manager2.sessions[summary.ID]
	manager2.mu.Unlock()
	if restoredBefore.meta.State != StateExited {
		t.Fatalf("expected StateExited before reconcile, got %s", restoredBefore.meta.State)
	}

	client2 := tmux.NewControlClient(tmuxStateDir, tmuxPath)
	if err := client2.Start(ctx); err != nil {
		t.Fatal(err)
	}
	manager2.SetTmux(client2)

	if err := manager2.ReconcileTmux(ctx); err != nil {
		t.Fatalf("ReconcileTmux failed: %v", err)
	}

	// Verify in-memory state is running
	manager2.mu.Lock()
	restoredAfter := manager2.sessions[summary.ID]
	seqAfter := restoredAfter.seq
	manager2.mu.Unlock()
	if restoredAfter.meta.State != StateRunning {
		t.Fatalf("expected StateRunning after reconcile, got %s", restoredAfter.meta.State)
	}
	if seqAfter == 0 {
		t.Fatal("expected seq > 0 after reattach")
	}

	// Verify runtime store snapshot shows terminal is NOT exited
	snapshot, err := manager2.RuntimeSnapshot()
	if err != nil {
		t.Fatalf("RuntimeSnapshot failed: %v", err)
	}
	foundRunningInSnapshot := false
	for _, term := range snapshot.Terminals {
		if term.ID == summary.ID {
			if term.Exited {
				t.Fatal("terminal marked exited in SQLite snapshot after reattach")
			}
			foundRunningInSnapshot = true
		}
	}
	if !foundRunningInSnapshot {
		t.Fatalf("session %s not found in SQLite snapshot", summary.ID)
	}

	// Verify scrollback file was REPLACED with capture baseline, not appended to stale old content
	scrollbackData, err := os.ReadFile(scrollbackPath)
	if err != nil {
		t.Fatalf("read scrollback failed: %v", err)
	}
	if strings.Contains(string(scrollbackData), "stale-old-scrollback-content-that-should-be-replaced") {
		t.Fatalf("scrollback still contains stale data; capture baseline did not replace old scrollback: %q", string(scrollbackData))
	}
	if !strings.Contains(string(scrollbackData), "fresh-pane-output") {
		t.Fatalf("scrollback does not contain fresh-pane-output: %q", string(scrollbackData))
	}
}

func TestManagerTmuxAvailable(t *testing.T) {
	tmpDir := t.TempDir()
	manager, err := NewManager(tmpDir, filepath.Join(tmpDir, "state"), tmpDir, 1<<20, 16, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Shutdown()

	if manager.TmuxAvailable() {
		t.Fatal("expected TmuxAvailable false before SetTmux")
	}

	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux not found in PATH")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client := tmux.NewControlClient(filepath.Join(tmpDir, "state", "tmux"), tmuxPath)
	if err := client.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	manager.SetTmux(client)

	if !manager.TmuxAvailable() {
		t.Fatal("expected TmuxAvailable true after SetTmux with a live control client")
	}

	manager.markTmuxRuntimesLost()
	if manager.TmuxAvailable() {
		t.Fatal("expected TmuxAvailable false after control client loss")
	}
}
func TestManagerSessionCapacityAndLifecycle(t *testing.T) {
	tmpDir := t.TempDir()
	manager, err := NewManager(tmpDir, filepath.Join(tmpDir, "state"), tmpDir, 1<<20, 256, nil)
	if err != nil {
		t.Fatalf("NewManager failed: %v", err)
	}
	defer manager.Shutdown()
	maxSess := 3
	manager.SetMaxSessions(maxSess)

	for i := 0; i < maxSess*2; i++ {
		summary, err := manager.Create(context.Background(), protocol.CreateSessionRequest{
			Name:    fmt.Sprintf("sess-%d", i),
			Command: "sh",
			Args:    []string{"-c", "echo hello"},
		})
		if err != nil {
			t.Fatalf("iteration %d: Create failed: %v", i, err)
		}
		if err := manager.Close(summary.ID); err != nil {
			t.Fatalf("iteration %d: Close failed: %v", i, err)
		}
	}

	for i := 0; i < maxSess; i++ {
		_, err := manager.Create(context.Background(), protocol.CreateSessionRequest{
			Name:    fmt.Sprintf("active-%d", i),
			Command: "sleep",
			Args:    []string{"10"},
		})
		if err != nil {
			t.Fatalf("active create %d failed: %v", i, err)
		}
	}
	_, err = manager.Create(context.Background(), protocol.CreateSessionRequest{
		Name:    "overflow",
		Command: "sh",
		Args:    []string{"-c", "echo overflow"},
	})
	if !errors.Is(err, ErrTooManySessions) {
		t.Fatalf("expected ErrTooManySessions, got %v", err)
	}
	for _, s := range manager.List(context.Background()) {
		_ = manager.Close(s.ID)
	}
}

func TestManagerNaturalExitReleasesCapacity(t *testing.T) {
	tmpDir := t.TempDir()
	manager, err := NewManager(tmpDir, filepath.Join(tmpDir, "state"), tmpDir, 1<<20, 256, nil)
	if err != nil {
		t.Fatalf("NewManager failed: %v", err)
	}
	defer manager.Shutdown()
	manager.SetMaxSessions(1)

	summary, err := manager.Create(context.Background(), protocol.CreateSessionRequest{
		Name:    "quick",
		Command: "sh",
		Args:    []string{"-c", "exit 0"},
	})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		s2, err := manager.Create(context.Background(), protocol.CreateSessionRequest{
			Name:    "second",
			Command: "sh",
			Args:    []string{"-c", "exit 0"},
		})
		if err == nil {
			_ = manager.Close(s2.ID)
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("capacity not released after natural exit: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	_ = manager.Close(summary.ID)
}
