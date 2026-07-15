package session

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestScrollbackCapTruncatesFront(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scrollback")
	if err := appendScrollback(path, bytes.Repeat([]byte("a"), 8), 10); err != nil {
		t.Fatal(err)
	}
	if err := appendScrollback(path, []byte("bcdef"), 10); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) == 0 {
		t.Fatal("expected latest bytes preserved")
	}
	if len(data) > 10 {
		t.Fatalf("expected stored scrollback to stay within cap, got %d bytes", len(data))
	}
}
