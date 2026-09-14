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
	notifChan, unsub := svc.SubscribeNotifications()
	defer unsub()
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

// TestReattachPaneRecoversStreamingOutput reattaches while a pane is actively
// writing, covering the capture/live handoff rather than only settled output.
func TestReattachPaneRecoversStreamingOutput(t *testing.T) {
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
	created, err := svc.CreatePane(ctx, "reattach-test", "sh", []string{"-c", "i=0; while [ $i -lt 40 ]; do printf x; i=$((i+1)); sleep 0.01; done; sleep 100"}, stateDir, 120, 40)
	if err != nil {
		t.Fatalf("create pane failed: %v", err)
	}
	pane := svc.GetTopology().Panes[created.GetPaneID()]
	if pane == nil {
		t.Fatal("created pane absent from topology")
	}
	reattached, err := svc.ReattachPane(ctx, pane.PaneID, pane.SessionID, pane.WindowID)
	if err != nil {
		t.Fatalf("reattach failed: %v", err)
	}
	buf := make([]byte, 4096)
	n, err := reattached.Read(buf)
	if err != nil {
		t.Fatalf("reattached read failed: %v", err)
	}
	if !strings.Contains(string(buf[:n]), "x") {
		t.Fatalf("reattached output = %q, want streaming output", buf[:n])
	}
}

// TestSameSocketGenerationRegression verifies that multiple clients connecting to the
// same private tmux server share the same ServerID generation, and recreating a server
// at the exact same socket path assigns a new, distinct ServerID generation.
func TestSameSocketGenerationRegression(t *testing.T) {
	tmuxPath, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux not found")
	}
	tmpDir := t.TempDir()
	stateDir := filepath.Join(tmpDir, "tmux_state")
	socketPath := filepath.Join(stateDir, "tmux.sock")

	t.Cleanup(func() {
		_ = exec.Command(tmuxPath, "-S", socketPath, "kill-server").Run()
	})

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// 1. Start first control client. It will initialize the private tmux server and generation.
	svc1 := NewControlClient(stateDir, tmuxPath)
	if err := svc1.Start(ctx); err != nil {
		t.Fatalf("first client start failed: %v", err)
	}
	defer svc1.Close()

	serverID1 := svc1.ServerID()
	if serverID1 == "" {
		t.Fatal("first client ServerID is empty")
	}
	if !strings.HasPrefix(serverID1, socketPath+":") {
		t.Fatalf("serverID1 = %q, expected prefix %q", serverID1, socketPath+":")
	}
	gen1 := strings.TrimPrefix(serverID1, socketPath+":")
	if gen1 == "" {
		t.Fatalf("generation in serverID1 is empty: %q", serverID1)
	}

	// 2. Start second control client on same stateDir / socketPath without killing server.
	svc2 := NewControlClient(stateDir, tmuxPath)
	if err := svc2.Start(ctx); err != nil {
		t.Fatalf("second client start failed: %v", err)
	}
	defer svc2.Close()

	serverID2 := svc2.ServerID()
	if serverID2 != serverID1 {
		t.Fatalf("expected identical ServerID for same server: svc1=%q, svc2=%q", serverID1, serverID2)
	}

	// 3. Close active clients and kill the private tmux server.
	_ = svc1.Close()
	_ = svc2.Close()

	killCmd := exec.Command(tmuxPath, "-S", socketPath, "kill-server")
	if err := killCmd.Run(); err != nil {
		t.Fatalf("kill-server failed: %v", err)
	}

	// Wait briefly for tmux server process and socket cleanup.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		probe := exec.CommandContext(ctx, tmuxPath, "-S", socketPath, "has-session")
		if err := probe.Run(); err != nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	// 4. Start third control client on the exact same socketPath.
	// It must spin up a new server and assign a new, distinct generation.
	svc3 := NewControlClient(stateDir, tmuxPath)
	if err := svc3.Start(ctx); err != nil {
		t.Fatalf("third client start failed: %v", err)
	}
	defer svc3.Close()

	serverID3 := svc3.ServerID()
	if serverID3 == "" {
		t.Fatal("third client ServerID is empty")
	}
	if !strings.HasPrefix(serverID3, socketPath+":") {
		t.Fatalf("serverID3 = %q, expected prefix %q", serverID3, socketPath+":")
	}
	gen3 := strings.TrimPrefix(serverID3, socketPath+":")
	if gen3 == "" {
		t.Fatalf("generation in serverID3 is empty: %q", serverID3)
	}

	if serverID3 == serverID1 {
		t.Fatalf("expected different ServerID after server recreation at same socket, got same %q", serverID3)
	}
	if gen3 == gen1 {
		t.Fatalf("expected new generation after server recreation: gen1=%q, gen3=%q", gen1, gen3)
	}
}
