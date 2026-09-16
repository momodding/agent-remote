package session

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/agenticremote/agenticremote/backend/internal/protocol"
)

func TestWorkspaceEmptyCWDDefaultsToWorkspaceRoot(t *testing.T) {
	daemonHome := t.TempDir()
	stateDir := t.TempDir()
	workspaceRoot := t.TempDir()

	mgr, err := NewManager(daemonHome, stateDir, workspaceRoot, 1024*1024, 100, nil)
	if err != nil {
		t.Fatalf("NewManager failed: %v", err)
	}
	defer mgr.Shutdown()

	session, err := mgr.Create(context.Background(), protocol.CreateSessionRequest{
		Name:    "Test Session",
		Command: defaultShell(),
		CWD:     "",
	})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	wsAbs, _ := filepath.EvalSymlinks(workspaceRoot)
	if session.CWD != wsAbs {
		t.Fatalf("expected internal CWD %q (workspace root), got %q", wsAbs, session.CWD)
	}
	if session.CWD == daemonHome {
		t.Fatalf("session CWD launched in daemonHome %q instead of workspaceRoot", daemonHome)
	}
}

func TestWorkspaceNestedPathResolutionAndRelativeConversion(t *testing.T) {
	daemonHome := t.TempDir()
	stateDir := t.TempDir()
	workspaceRoot := t.TempDir()

	nestedDir := filepath.Join(workspaceRoot, "nested", "sub")
	if err := os.MkdirAll(nestedDir, 0o755); err != nil {
		t.Fatalf("failed to create nested dir: %v", err)
	}

	mgr, err := NewManager(daemonHome, stateDir, workspaceRoot, 1024*1024, 100, nil)
	if err != nil {
		t.Fatalf("NewManager failed: %v", err)
	}
	defer mgr.Shutdown()

	session, err := mgr.Create(context.Background(), protocol.CreateSessionRequest{
		Name:    "Nested Session",
		Command: defaultShell(),
		CWD:     "nested/sub",
	})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	nestedAbs, _ := filepath.EvalSymlinks(nestedDir)
	if session.CWD != nestedAbs {
		t.Fatalf("expected internal CWD %q, got %q", nestedAbs, session.CWD)
	}

	rel := mgr.ToWorkspaceRelative(session.CWD)
	if rel != "nested/sub" {
		t.Fatalf("expected relative path %q, got %q", "nested/sub", rel)
	}

	rootRel := mgr.ToWorkspaceRelative(mgr.WorkspaceRoot())
	if rootRel != "" {
		t.Fatalf("expected empty string for root relative path, got %q", rootRel)
	}
}

func TestWorkspaceEscapeRejections(t *testing.T) {
	daemonHome := t.TempDir()
	stateDir := t.TempDir()
	workspaceRoot := t.TempDir()

	mgr, err := NewManager(daemonHome, stateDir, workspaceRoot, 1024*1024, 100, nil)
	if err != nil {
		t.Fatalf("NewManager failed: %v", err)
	}
	defer mgr.Shutdown()

	// 1. .. traversal
	_, err = mgr.Create(context.Background(), protocol.CreateSessionRequest{
		Command: defaultShell(),
		CWD:     "../outside",
	})
	if !errors.Is(err, ErrWorkspaceEscape) {
		t.Fatalf("expected ErrWorkspaceEscape for '..', got: %v", err)
	}

	// 2. Absolute path outside workspace
	outsideDir := t.TempDir()
	_, err = mgr.Create(context.Background(), protocol.CreateSessionRequest{
		Command: defaultShell(),
		CWD:     outsideDir,
	})
	if !errors.Is(err, ErrWorkspaceEscape) {
		t.Fatalf("expected ErrWorkspaceEscape for outside absolute path, got: %v", err)
	}

	// 3. Symlink escape
	escapeTarget := t.TempDir()
	symlinkPath := filepath.Join(workspaceRoot, "symlink_escape")
	if err := os.Symlink(escapeTarget, symlinkPath); err == nil {
		_, err = mgr.Create(context.Background(), protocol.CreateSessionRequest{
			Command: defaultShell(),
			CWD:     "symlink_escape",
		})
		if !errors.Is(err, ErrWorkspaceEscape) {
			t.Fatalf("expected ErrWorkspaceEscape for symlink escaping workspace, got: %v", err)
		}
	}
}
