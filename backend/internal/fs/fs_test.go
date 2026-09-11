package fs

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestResolveRejectsEscapes(t *testing.T) {
	parent := t.TempDir()
	workspace := filepath.Join(parent, "workspace")
	outside := filepath.Join(parent, "outside")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(workspace, "escape")); err != nil {
		t.Fatal(err)
	}
	svc, err := NewService(workspace, t.TempDir(), false)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"..", "../outside", outside, "escape/file.txt"} {
		if _, _, err := svc.Resolve(path); err == nil {
			t.Errorf("Resolve(%q) succeeded", path)
		}
	}
}

func TestResolveAllowsNestedWorkspacePath(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	svc, err := NewService(root, t.TempDir(), false)
	if err != nil {
		t.Fatal(err)
	}
	abs, display, err := svc.Resolve("nested/file.txt")
	if err != nil {
		t.Fatal(err)
	}
	if abs != filepath.Join(root, "nested", "file.txt") || display != "nested/file.txt" {
		t.Fatalf("Resolve returned %q, %q", abs, display)
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

func TestRenameRejectsExistingDestination(t *testing.T) {
	root := t.TempDir()
	svc, _ := NewService(root, root, true)
	if err := os.WriteFile(filepath.Join(root, "old.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "new.txt"), []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := svc.Rename("old.txt", "new.txt"); !errors.Is(err, ErrDestinationExists) {
		t.Fatalf("expected destination exists, got %v", err)
	}
}

func TestCopyCopiesFile(t *testing.T) {
	root := t.TempDir()
	svc, _ := NewService(root, root, false)
	if err := os.WriteFile(filepath.Join(root, "src.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := svc.Copy("src.txt", "dst.txt"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "dst.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello" {
		t.Fatalf("copied data = %q", data)
	}
}

func TestCopyCopiesNestedDirectory(t *testing.T) {
	root := t.TempDir()
	svc, _ := NewService(root, root, false)
	if err := os.MkdirAll(filepath.Join(root, "src", "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "src", "nested", "file.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := svc.Copy("src", "dst"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "dst", "nested", "file.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello" {
		t.Fatalf("copied data = %q", data)
	}
}

func TestCopyRejectsSymlinkSource(t *testing.T) {
	root := t.TempDir()
	svc, _ := NewService(root, root, false)
	if err := os.WriteFile(filepath.Join(root, "target.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("target.txt", filepath.Join(root, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if err := svc.Copy("link.txt", "dst.txt"); err == nil {
		t.Fatal("expected symlink copy to fail")
	}
}
