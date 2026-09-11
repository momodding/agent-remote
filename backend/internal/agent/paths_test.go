package agent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTerminalIDFromTTY(t *testing.T) {
	if got := TerminalIDFromTTY("/dev/pts/3"); got != "pts-3" {
		t.Fatalf("expected pts-3, got %q", got)
	}
	if got := TerminalIDFromTTY("/dev/pts/12"); got != "pts-12" {
		t.Fatalf("expected pts-12, got %q", got)
	}
	if got := TerminalIDFromTTY(""); got != "" {
		t.Fatalf("expected empty, got %q", got)
	}
}

func TestReadTerminalBreadcrumb(t *testing.T) {
	tmp := t.TempDir()
	crumbDir := filepath.Join(tmp, "terminal-sessions")
	if err := os.MkdirAll(crumbDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Case 1: normal breadcrumb
	crumbPath := filepath.Join(crumbDir, "pts-5")
	if err := os.WriteFile(crumbPath, []byte("/workspace\n/path/to/session.jsonl\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cwd, file, fresh, err := ReadTerminalBreadcrumb(tmp, "pts-5")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cwd != "/workspace" || file != "/path/to/session.jsonl" || fresh {
		t.Fatalf("unexpected result: cwd=%q file=%q fresh=%v", cwd, file, fresh)
	}

	// Case 2: fresh breadcrumb
	crumbFresh := filepath.Join(crumbDir, "pts-6")
	if err := os.WriteFile(crumbFresh, []byte("/workspace2\n/path/to/session2.jsonl\nfresh\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cwd, file, fresh, err = ReadTerminalBreadcrumb(tmp, "pts-6")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cwd != "/workspace2" || file != "/path/to/session2.jsonl" || !fresh {
		t.Fatalf("unexpected result: cwd=%q file=%q fresh=%v", cwd, file, fresh)
	}
}

func TestFindLatestSessionFile(t *testing.T) {
	tmp := t.TempDir()
	if _, err := FindLatestSessionFile(tmp); err == nil {
		t.Fatal("expected error on empty dir")
	}

	f1 := filepath.Join(tmp, "2026-09-10_a.jsonl")
	_ = os.WriteFile(f1, []byte("line1\n"), 0o644)
	f2 := filepath.Join(tmp, "2026-09-11_b.jsonl")
	_ = os.WriteFile(f2, []byte("line2\n"), 0o644)

	latest, err := FindLatestSessionFile(tmp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if latest != f2 {
		t.Fatalf("expected %q, got %q", f2, latest)
	}
}
