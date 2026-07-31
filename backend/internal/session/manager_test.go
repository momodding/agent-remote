package session

import (
	"context"
	"os"
	"path/filepath"
	"testing"

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
