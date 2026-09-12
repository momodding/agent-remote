package session

import (
	"context"
	"errors"
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
