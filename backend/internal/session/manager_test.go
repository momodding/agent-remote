package session

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/protocol"
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
	sessions := restored.List(context.Background())
	if len(sessions) != 1 || sessions[0].ID != created.ID {
		t.Fatalf("expected restored session %q, got %+v", created.ID, sessions)
	}
	if preview := strings.Join(sessions[0].Preview, "\n"); !strings.Contains(preview, "preview survives restart") {
		t.Fatalf("expected restored preview, got %q", preview)
	}
}
