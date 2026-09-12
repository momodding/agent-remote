package tmux

import (
	"strings"
	"testing"
	"time"
)

func TestBackendIdentity(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	backend := NewTmuxBackend(client, "%0", "$0", "@0")

	identity := backend.Identity()
	expected := "tmux:$0:@0:%0"
	if identity != expected {
		t.Errorf("Identity() = %q, want %q", identity, expected)
	}
}

func TestBackendGetPaneID(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	backend := NewTmuxBackend(client, "%5", "$1", "@2")

	paneID := backend.GetPaneID()
	if paneID != "%5" {
		t.Errorf("GetPaneID() = %q, want %q", paneID, "%5")
	}
}

func TestLiteralSendKeysCommand(t *testing.T) {
	got := literalSendKeysCommand("%12", []byte{'A', '$', 0x1b, '\n'})
	want := `send-keys -l -t %12 \101 \044 \033 \012`
	if got != want {
		t.Fatalf("literalSendKeysCommand() = %q, want %q", got, want)
	}
}

func TestBackendReadClosed(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	backend := NewTmuxBackend(client, "%0", "$0", "@0")

	_ = backend.Close()

	buf := make([]byte, 1024)
	_, err := backend.Read(buf)
	if err == nil {
		t.Fatal("Read on closed backend should fail")
	}
}

func TestBackendClosedTwice(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	backend := NewTmuxBackend(client, "%0", "$0", "@0")

	err := backend.Close()
	if err != nil {
		t.Fatalf("first Close failed: %v", err)
	}

	err = backend.Close()
	if err != nil {
		t.Fatalf("second Close failed: %v", err)
	}
}

func TestBackendAliveWhenClosed(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	backend := NewTmuxBackend(client, "%0", "$0", "@0")

	_ = backend.Close()

	if backend.Alive() {
		t.Fatal("Alive should return false after Close")
	}
}

func TestBackendNew(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	backend := NewTmuxBackend(client, "%0", "$0", "@0")

	if backend == nil {
		t.Fatal("backend is nil")
	}

	if !backend.Alive() {
		// Without topology, Alive may return false; that's expected
		// ponytail: Alive depends on topology being populated
	}
}

func TestBackendReadPreservesOutputRemainder(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	backend := NewTmuxBackend(client, "%0", "$0", "@0")
	// Subscribe with baseline data "abcdef"
	ch := make(chan paneOutput)
	err := backend.Subscribe(ch, []byte("abcdef"), nil)
	if err != nil {
		t.Fatalf("Subscribe failed: %v", err)
	}
	// Read baseline in chunks
	buf := make([]byte, 3)
	if n, err := backend.Read(buf); err != nil || string(buf[:n]) != "abc" {
		t.Fatalf("first Read() = %q, %v", buf[:n], err)
	}
	if n, err := backend.Read(buf); err != nil || string(buf[:n]) != "def" {
		t.Fatalf("second Read() = %q, %v", buf[:n], err)
	}
}

func TestBackendCloseUnblocksRead(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	client.parser = NewParser(strings.NewReader(""))
	backend := NewTmuxBackend(client, "%0", "$0", "@0")
	result := make(chan error, 1)
	go func() { _, err := backend.Read(make([]byte, 1)); result <- err }()
	if err := backend.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("Read should fail after Close")
		}
	case <-time.After(time.Second):
		t.Fatal("Close did not unblock Read")
	}
}

func TestBackendReadEmptyBufferReturnsImmediately(t *testing.T) {
	client := NewControlClient("/tmp/test", "tmux")
	client.parser = NewParser(strings.NewReader(""))
	backend := NewTmuxBackend(client, "%0", "$0", "@0")
	result := make(chan error, 1)
	go func() { _, err := backend.Read(nil); result <- err }()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("zero-length Read blocked")
	}
}
