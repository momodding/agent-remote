package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agenticremote/agenticremote/backend/internal/protocol"
)

func TestSnapshotAttachmentUsesWorkspaceRootForNestedAgent(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "diagram.png"), []byte("png"), 0o600); err != nil {
		t.Fatal(err)
	}
	ref, snapshot, err := snapshotAttachment(root, "agent-a", "diagram.png")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(snapshot)
	if !strings.HasPrefix(ref, ".agenticremote-attachments/agent-a/") {
		t.Fatalf("snapshot ref %q is not workspace-root-relative", ref)
	}
	if _, err := loadPromptImages(root, []protocol.AgentPromptImage{{Path: ref}}); err != nil {
		t.Fatalf("root-based snapshot image load: %v", err)
	}
}

func TestSnapshotAttachmentRejectsSymlinkAndLeavesNoSnapshot(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := snapshotAttachment(root, "agent-a", "escape"); err == nil {
		t.Fatal("symlink escape was accepted")
	}
}

func TestSnapshotAttachmentIsImmutableAcrossSourceReplacement(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "upload.bin")
	if err := os.WriteFile(source, []byte("before"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, snapshot, err := snapshotAttachment(root, "agent-a", "upload.bin")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(snapshot)
	if err := os.WriteFile(source, []byte("after"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "before" {
		t.Fatalf("snapshot mutated: %q", got)
	}
}

func TestRemoveSnapshotsCleansFailedDispatchAndLifecyclePaths(t *testing.T) {
	root := t.TempDir()
	paths := []string{filepath.Join(root, "failed"), filepath.Join(root, "terminated")}
	for _, path := range paths {
		if err := os.WriteFile(path, []byte("snapshot"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	removeSnapshots(paths)
	for _, path := range paths {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("snapshot %q remains after cleanup: %v", path, err)
		}
	}
}
