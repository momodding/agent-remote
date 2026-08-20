package main

import (
	"context"
	"crypto/tls"
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

func TestConfigInitAcceptsDirectoryAndPreservesConfiguredValues(t *testing.T) {
	dir := t.TempDir()
	if err := run([]string{"config", "init", "--path", dir}); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "config.json")
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	var values map[string]json.RawMessage
	if err := json.Unmarshal(data, &values); err != nil {
		t.Fatal(err)
	}
	values["listenAddr"] = json.RawMessage(`"127.0.0.1:9999"`)
	delete(values, "vncPort")
	values["customExtension"] = json.RawMessage(`{"keep":true}`)
	data, err = json.Marshal(values)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{"tls/cert.pem", "auth/sessions.json", "sessions/sessions.json"} {
		full := filepath.Join(dir, ".agenticremote", file)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := run([]string{"config", "init", "--path", dir}); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &values); err != nil {
		t.Fatal(err)
	}
	if got := string(values["listenAddr"]); got != `"127.0.0.1:9999"` {
		t.Fatalf("listenAddr overwritten: %s", got)
	}
	if _, ok := values["vncPort"]; !ok {
		t.Fatal("vncPort was not added")
	}
	var keep struct{ Keep bool `json:"keep"` }
	if err := json.Unmarshal(values["customExtension"], &keep); err != nil || !keep.Keep {
		t.Fatalf("customExtension removed or corrupted: %s", string(values["customExtension"]))
	}
	for _, name := range []string{"tls", "auth", "sessions"} {
		if _, err := os.Stat(filepath.Join(dir, ".agenticremote", name)); !os.IsNotExist(err) {
			t.Fatalf("expected %s removed, got %v", name, err)
		}
	}
	if _, err := config.Load(configPath); err != nil {
		t.Fatal(err)
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

func TestResolveConfiguredPath(t *testing.T) {
	configDir := filepath.Join(t.TempDir(), "config")
	absolute := filepath.Join(t.TempDir(), "workspace")
	for _, test := range []struct {
		name       string
		configured string
		want       string
	}{
		{name: "relative", configured: "workspace", want: filepath.Join(configDir, "workspace")},
		{name: "clean relative", configured: "workspace/../project", want: filepath.Join(configDir, "project")},
		{name: "absolute", configured: absolute, want: absolute},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := resolveConfiguredPath(configDir, test.configured); got != test.want {
				t.Fatalf("resolveConfiguredPath(%q, %q) = %q, want %q", configDir, test.configured, got, test.want)
			}
		})
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
