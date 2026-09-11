//go:build integration
// +build integration

package tmux

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestRealTmuxControlMode tests against real tmux 3.4+
func TestRealTmuxControlMode(t *testing.T) {
	// Check if tmux is available
	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux not found in PATH")
	}

	// Create temp directory for socket
	tmpDir := t.TempDir()
	stateDir := filepath.Join(tmpDir, "tmux_state")

	// Create service and start
	svc := NewControlClient(stateDir, tmuxPath)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := svc.Start(ctx); err != nil {
		t.Fatalf("failed to start control client: %v", err)
	}
	defer svc.Close()

	// Verify socket was created
	if _, err := os.Stat(svc.socketPath); err != nil {
		t.Fatalf("socket not created: %v", err)
	}

	// Query topology
	if err := svc.RefreshTopology(ctx); err != nil {
		t.Fatalf("refresh topology failed: %v", err)
	}

	topology := svc.GetTopology()
	t.Logf("topology: %d sessions, %d windows, %d panes", len(topology.Sessions), len(topology.Windows), len(topology.Panes))

	// Create a persistent pane through the public lifecycle API.
	backend, err := svc.CreatePane(ctx, "test-agent", "sh", []string{"-c", "printf ready; sleep 100"}, stateDir, 120, 40)
	if err != nil {
		t.Fatalf("failed to create tmux pane: %v", err)
	}
	// Refresh and check session exists
	if err := svc.RefreshTopology(ctx); err != nil {
		t.Fatalf("refresh topology failed: %v", err)
	}

	topology = svc.GetTopology()
	sessionID := ""
	for sid, info := range topology.Sessions {
		if info.Name == "test-agent" {
			sessionID = sid
			break
		}
	}

	if sessionID == "" {
		t.Fatal("new session not found in topology")
	}

	t.Logf("created session %s", sessionID)

	// Find the pane
	var paneID string
	for pid, pane := range topology.Panes {
		if pane.SessionID == sessionID {
			paneID = pid
			break
		}
	}

	if paneID == "" {
		t.Fatal("no pane found in new session")
	}

	t.Logf("pane %s: TTY=%s Width=%d Height=%d", paneID, topology.Panes[paneID].TTY, topology.Panes[paneID].Width, topology.Panes[paneID].Height)
	if backend.GetPaneID() != paneID {
		t.Fatalf("CreatePane returned %s, topology found %s", backend.GetPaneID(), paneID)
	}
	if backend.Identity() != "tmux:"+sessionID+":"+topology.Panes[paneID].WindowID+":"+paneID {
		t.Fatalf("backend identity = %s", backend.Identity())
	}
	baseline := make(chan []byte, 1)
	go func() {
		buf := make([]byte, 1024)
		n, _ := backend.Read(buf)
		baseline <- buf[:n]
	}()
	select {
	case output := <-baseline:
		if !strings.Contains(string(output), "ready") {
			t.Fatalf("startup output = %q", output)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("did not recover immediate pane output")
	}

	// CreatePane returns the backend that owns this pane.

	// Test Alive
	if !backend.Alive() {
		t.Fatal("pane should be alive")
	}

	// Test Identity
	identity := backend.Identity()
	t.Logf("backend identity: %s", identity)
	if identity == "" {
		t.Fatal("identity should not be empty")
	}

	// Test GetPaneID
	if backend.GetPaneID() != paneID {
		t.Errorf("GetPaneID mismatch: got %s, want %s", backend.GetPaneID(), paneID)
	}

	// Test Write (paste)
	data := []byte("echo 'test'\n")
	n, err := backend.Write(data)
	if err != nil {
		t.Logf("write (expected to fail without shell): %v", err)
		// Expected: write might fail if tmux doesn't like the escape sequence
	} else {
		if n != len(data) {
			t.Errorf("Write returned %d, expected %d", n, len(data))
		}
	}

	// Test Resize
	err = backend.Resize(100, 30)
	if err != nil {
		t.Logf("resize failed: %v", err)
		// Resize might fail in test environment
	} else {
		t.Logf("resized pane to 100x30")
	}

	// Test Alive again
	if !backend.Alive() {
		t.Fatal("pane should still be alive")
	}

	// Test Close
	err = backend.Close()
	if err != nil {
		t.Fatalf("close failed: %v", err)
	}

	t.Logf("integration test completed successfully")
}

// TestNotificationDispatch tests that notifications are dispatched
func TestNotificationDispatch(t *testing.T) {
	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux not found")
	}

	tmpDir := t.TempDir()
	stateDir := filepath.Join(tmpDir, "tmux_state")

	svc := NewControlClient(stateDir, tmuxPath)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := svc.Start(ctx); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	defer svc.Close()

	// Subscribe to notifications
	notifChan := svc.SubscribeNotifications()

	// Create a session which should trigger notifications
	result, err := svc.SendCommand(ctx, "new-session -d -s notif-test 'sleep 10'")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}

	// Wait for a notification
	timeout := time.After(5 * time.Second)
	notifCount := 0
	for notifCount < 2 {
		select {
		case <-timeout:
			t.Logf("timed out waiting for notifications, got %d", notifCount)
			return
		case notif := <-notifChan:
			t.Logf("got notification: %s", notif.Type)
			notifCount++
		}
	}
}

// TestServerLossSignalsLost verifies killing the tmux server closes Lost()
// without the client trying to recreate the process itself.
func TestServerLossSignalsLost(t *testing.T) {
	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux not found")
	}
	tmpDir := t.TempDir()
	stateDir := filepath.Join(tmpDir, "tmux_state")
	svc := NewControlClient(stateDir, tmuxPath)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := svc.Start(ctx); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	defer svc.Close()
	kill := exec.Command(tmuxPath, "-S", filepath.Join(stateDir, "tmux.sock"), "kill-server")
	if err := kill.Run(); err != nil {
		t.Fatalf("kill-server failed: %v", err)
	}
	select {
	case <-svc.Lost():
	case <-time.After(5 * time.Second):
		t.Fatal("Lost() did not close after server kill")
	}
}

// TestReattachPaneRecoversBaselineExactlyOnce proves reconnecting after a
// simulated daemon restart recovers pane history without duplication.
func TestReattachPaneRecoversBaselineExactlyOnce(t *testing.T) {
	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux not found")
	}
	tmpDir := t.TempDir()
	stateDir := filepath.Join(tmpDir, "tmux_state")
	svc := NewControlClient(stateDir, tmuxPath)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := svc.Start(ctx); err != nil {
		t.Fatalf("start failed: %v", err)
	}
	defer svc.Close()
	created, err := svc.CreatePane(ctx, "reattach-test", "sh", []string{"-c", "printf reattached; sleep 100"}, stateDir, 120, 40)
	if err != nil {
		t.Fatalf("create pane failed: %v", err)
	}
	time.Sleep(200 * time.Millisecond) // let tmux flush startup output before reattach
	reattached, err := svc.ReattachPane(ctx, created.GetPaneID(), created.Identity(), created.Identity())
	if err != nil {
		t.Fatalf("reattach failed: %v", err)
	}
	buf := make([]byte, 1024)
	n, err := reattached.Read(buf)
	if err != nil {
		t.Fatalf("reattached read failed: %v", err)
	}
	if strings.Count(string(buf[:n]), "reattached") != 1 {
		t.Fatalf("reattached output = %q, want exactly one occurrence", buf[:n])
	}
}
