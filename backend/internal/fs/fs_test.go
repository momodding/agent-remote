package fs

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestPathTraversalRejected(t *testing.T) {
	svc, err := NewService(t.TempDir(), t.TempDir(), false)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join("..", "etc", "passwd")
	if _, _, _, err := svc.Resolve(target); err == nil {
		t.Fatal("expected traversal to fail")
	}
}

func TestAbsolutePathListingUsesAbsolutePaths(t *testing.T) {
	workspace := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "host.txt"), []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc, err := NewService(workspace, t.TempDir(), false)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := svc.List(outside)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected one entry, got %d", len(entries))
	}
	want := filepath.ToSlash(filepath.Join(outside, "host.txt"))
	if entries[0].Path != want {
		t.Fatalf("path = %q, want %q", entries[0].Path, want)
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
