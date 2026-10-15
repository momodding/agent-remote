package fs

import (
	"bytes"
	"mime/multipart"
	"os"
	"path/filepath"
	"testing"
)

func TestUploadGeneratesDistinctOpaqueTargetsForSameBasename(t *testing.T) {
	root := t.TempDir()
	svc, err := NewService(root, filepath.Join(root, "uploads"), false)
	if err != nil {
		t.Fatal(err)
	}
	upload := func(content string) string {
		t.Helper()
		file := &memoryMultipartFile{Reader: *bytes.NewReader([]byte(content))}
		path, err := svc.Upload("", file, &multipart.FileHeader{Filename: "same.txt"})
		if err != nil {
			t.Fatal(err)
		}
		return path
	}
	first, second := upload("one"), upload("two")
	if first == second {
		t.Fatalf("collision: %q", first)
	}
	for _, path := range []string{first, second} {
		if filepath.Base(path) == "same.txt" {
			t.Fatalf("basename leaked into opaque target %q", path)
		}
		if _, err := os.Stat(filepath.Join(root, path)); err != nil {
			t.Fatal(err)
		}
	}
}

type memoryMultipartFile struct{ bytes.Reader }

func (m *memoryMultipartFile) Close() error { return nil }
