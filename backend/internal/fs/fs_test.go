package fs

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestPathTraversalRejected(t *testing.T) {
	svc, err := NewService(t.TempDir(), t.TempDir(), false)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join("..", "etc", "passwd")
	if _, _, err := svc.Resolve(target); err == nil {
		t.Fatal("expected traversal to fail")
	}
}

func TestWriteConflictOnSHAMismatch(t *testing.T) {
	root := t.TempDir()
	svc, _ := NewService(root, root, false)
	if _, err := svc.WriteText("file.txt", "hello", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.WriteText("file.txt", "goodbye", "wrong"); err == nil {
		t.Fatal("expected sha mismatch")
	}
}

func TestDeleteDisabledByDefault(t *testing.T) {
	svc, _ := NewService(t.TempDir(), t.TempDir(), false)
	if err := svc.Delete("file.txt"); !errors.Is(err, ErrDestructiveDisabled) {
		t.Fatalf("expected destructive disabled error, got %v", err)
	}
}
