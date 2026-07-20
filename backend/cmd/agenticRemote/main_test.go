package main

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
	stdout, restoreStdout := captureOutput(t, os.Stdout)
	stdoutDone := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, stdout)
		close(stdoutDone)
	}()
	stderr, restoreStderr := captureOutput(t, os.Stderr)
	stderrDone := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, stderr)
		close(stderrDone)
	}()
	oldArgs := os.Args
	defer func() { os.Args = oldArgs }()
	os.Args = []string{"agenticRemote", "serve", "--config", configPath}
	if err := run([]string{"serve", "--config", configPath}); err == nil || !strings.Contains(err.Error(), "daemon exited") {
		t.Fatalf("expected daemon exit sentinel, got %v", err)
	}
	restoreStdout()
	restoreStderr()
	<-stdoutDone
	<-stderrDone
}

func TestServeListenerAcceptsPlainHTTP(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	httpServer := server.ServerTimeouts(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}), listener.Addr().String())
	errCh := make(chan error, 1)
	go func() {
		errCh <- httpServer.Serve(&sniffListener{Listener: listener})
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
		t.Fatalf("unexpected serve error: %v", err)
	}
}

func TestServeListenerAcceptsTLS(t *testing.T) {
	tlsMaterial := mustTLSMaterial(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	httpServer := server.ServerTimeouts(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}), listener.Addr().String())
	tlsConfig := &tls.Config{Certificates: []tls.Certificate{mustLoadCertificate(t, tlsMaterial)}, NextProtos: []string{"h2", "http/1.1"}}
	httpServer.TLSConfig = tlsConfig
	errCh := make(chan error, 1)
	go func() {
		errCh <- httpServer.Serve(&sniffListener{Listener: listener, tlsConfig: tlsConfig})
	}()
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	resp, err := client.Get("https://" + listener.Addr().String())
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
		t.Fatalf("unexpected serve error: %v", err)
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
	  "skipFingerprintVerification": false,
	  "expoPushEndpoint": "https://exp.host/--/api/v2/push/send",
	  "pairingRotationSeconds": 45
	}`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func mustTLSMaterial(t *testing.T) *security.TLSMaterial {
	t.Helper()
	stateDir := t.TempDir()
	material, err := security.EnsureTLS(stateDir, "127.0.0.1:0", "https://127.0.0.1:8765")
	if err != nil {
		t.Fatal(err)
	}
	return material
}

func mustLoadCertificate(t *testing.T, material *security.TLSMaterial) tls.Certificate {
	t.Helper()
	certificate, err := tls.LoadX509KeyPair(material.CertPath, material.KeyPath)
	if err != nil {
		t.Fatal(err)
	}
	return certificate
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
