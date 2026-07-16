package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agenticremote/agenticremote/backend/internal/config"
	"github.com/agenticremote/agenticremote/backend/internal/security"
	"github.com/agenticremote/agenticremote/backend/internal/server"
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
	stdout, readStdout := captureOutput(t, os.Stdout)
	defer stdout.Close()
	_, readStderr := captureOutput(t, os.Stderr)
	defer readStderr().Close()
	oldArgs := os.Args
	defer func() { os.Args = oldArgs }()
	os.Args = []string{"agenticRemote", "serve", "--config", configPath}
	if err := run([]string{"serve", "--config", configPath}); err == nil || !strings.Contains(err.Error(), "daemon exited") {
		t.Fatalf("expected daemon exit sentinel, got %v", err)
	}
	stdoutData, _ := io.ReadAll(readStdout())
	if len(stdoutData) == 0 {
		t.Fatal("expected pairing output on stdout")
	}
	lines := strings.Split(strings.TrimSpace(string(stdoutData)), "\n")
	jsonLine := ""
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.HasPrefix(lines[i], "{") {
			jsonLine = lines[i]
			break
		}
	}
	if jsonLine == "" {
		t.Fatalf("expected pairing json line in output: %q", string(stdoutData))
	}
	var payload security.PairingPayload
	if err := json.Unmarshal([]byte(jsonLine), &payload); err != nil {
		t.Fatalf("expected pairing json line, got %q: %v", jsonLine, err)
	}
	if payload.Endpoint != "https://127.0.0.1:8765" {
		t.Fatalf("unexpected pairing endpoint: %s", payload.Endpoint)
	}
}

func TestServeListenerHTTPModeAcceptsPlainHealth(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.ListenScheme = "http"
	httpServer := server.ServerTimeouts(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}), listener.Addr().String())
	errCh := make(chan error, 1)
	go func() {
		errCh <- serveListener(httpServer, listener, cfg, nil)
	}()
	resp, err := http.Get("http://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if err := httpServer.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := <-errCh; err != nil && !errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("unexpected serveListener error: %v", err)
	}
}

func writeConfig(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	content := `{
	  "listenAddr": "127.0.0.1:0",
	  "listenScheme": "https",
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

func captureOutput(t *testing.T, target *os.File) (*os.File, func() *os.File) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	if target == os.Stdout {
		old := os.Stdout
		os.Stdout = w
		return r, func() *os.File {
			_ = w.Close()
			os.Stdout = old
			return r
		}
	}
	old := os.Stderr
	os.Stderr = w
	return r, func() *os.File {
		_ = w.Close()
		os.Stderr = old
		return r
	}
}
