package main

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunRejectsPairCommand(t *testing.T) {
	if err := run([]string{"pair", "--config", "test.json"}); err == nil || !strings.Contains(err.Error(), "pairing starts with serve") {
		t.Fatalf("expected pair rejection, got %v", err)
	}
}

func TestRunServeRequiresConfig(t *testing.T) {
	if err := run([]string{"serve"}); err == nil || !strings.Contains(err.Error(), "serve requires --config") {
		t.Fatalf("expected missing config error, got %v", err)
	}
}

func TestRunServeStartsDaemon(t *testing.T) {
	configPath := writeConfig(t)
	stdout, restoreStdout := captureOutput(t, os.Stdout)
	stderr, restoreStderr := captureOutput(t, os.Stderr)
	defer restoreStdout()
	defer restoreStderr()
	oldArgs := os.Args
	defer func() { os.Args = oldArgs }()
	os.Args = []string{"agenticRemote", "serve", "--config", configPath}
	if err := run([]string{"serve", "--config", configPath}); err == nil || !strings.Contains(err.Error(), "daemon exited") {
		t.Fatalf("expected daemon exit sentinel, got %v", err)
	}
	_ = stdout.Close()
	_ = stderr.Close()
	if data, err := os.ReadFile(filepath.Join(filepath.Dir(configPath), ".agenticremote", "auth", "pairings.json")); err != nil || len(data) == 0 {
		t.Fatalf("expected pairings store written, err=%v len=%d", err, len(data))
	}
}

func writeConfig(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	content := `{
  "listenAddr": "127.0.0.1:0",
  "publicEndpoint": "https://127.0.0.1:8765",
  "stateDir": ".agenticremote",
  "workspaceRoot": ".",
  "uploadDir": "uploads",
  "allowedCidrs": ["127.0.0.0/8", "::1/128"],
  "maxConnections": 8,
  "maxSessions": 16,
  "channelBufferSize": 256,
  "maxScrollbackBytes": 10485760,
  "allowDestructiveFiles": false,
  "expoPushEndpoint": "https://exp.host/--/api/v2/push/send"
}`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func captureOutput(t *testing.T, target *os.File) (*os.File, func()) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	if target == os.Stdout {
		old := os.Stdout
		os.Stdout = w
		return r, func() {
			_ = w.Close()
			_, _ = io.ReadAll(r)
			os.Stdout = old
		}
	}
	old := os.Stderr
	os.Stderr = w
	return r, func() {
		_ = w.Close()
		_, _ = io.ReadAll(r)
		os.Stderr = old
	}
}
