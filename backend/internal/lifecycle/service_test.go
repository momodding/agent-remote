package lifecycle

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type mockRunner struct {
	out []byte
	err error
}

func (m *mockRunner) Output() ([]byte, error) {
	return m.out, m.err
}

func (m *mockRunner) CombinedOutput() ([]byte, error) {
	return m.out, m.err
}

type mockProvider struct {
	failBinary bool
	commands   []string
}

func (p *mockProvider) Command(ctx context.Context, name string, args ...string) Runner {
	p.commands = append(p.commands, name+" "+strings.Join(args, " "))
	if strings.Contains(name, "agenticRemote") && len(args) > 0 && args[0] == "version" {
		if p.failBinary {
			return &mockRunner{err: errors.New("version failed")}
		}
		return &mockRunner{out: []byte("dev\n")}
	}
	return &mockRunner{}
}

func TestInstall_Success(t *testing.T) {
	tmpHome := t.TempDir()
	provider := &mockProvider{}
	svc := NewService(tmpHome, provider)

	err := svc.Install(context.Background(), InstallOptions{})
	if err != nil {
		t.Fatalf("Install failed: %v", err)
	}

	managed := filepath.Join(tmpHome, ".remote")
	if stat, err := os.Stat(filepath.Join(managed, "bin")); err != nil || !stat.IsDir() {
		t.Errorf("bin dir not created: %v", err)
	}

	if _, err := os.Stat(filepath.Join(managed, "bin", "agenticRemote")); err != nil {
		t.Errorf("binary not installed: %v", err)
	}

	if _, err := os.Stat(filepath.Join(managed, ".agenticremote-managed.json")); err != nil {
		t.Errorf("marker not written: %v", err)
	}

	if _, err := os.Stat(filepath.Join(managed, "config.json")); err != nil {
		t.Errorf("config not written: %v", err)
	}
}

func TestInstall_InvalidHome(t *testing.T) {
	invalidHome := filepath.Join(t.TempDir(), "nonexistent")
	svc := NewService(invalidHome, &mockProvider{})
	err := svc.Install(context.Background(), InstallOptions{})
	if err == nil || !strings.Contains(err.Error(), "not a valid directory") {
		t.Errorf("Install should fail for invalid home: %v", err)
	}
}

func TestInstall_VerifyBinaryFailure(t *testing.T) {
	tmpHome := t.TempDir()
	provider := &mockProvider{failBinary: true}
	svc := NewService(tmpHome, provider)

	err := svc.Install(context.Background(), InstallOptions{})
	if err == nil || !strings.Contains(err.Error(), "verify binary") {
		t.Errorf("Install should fail verification: %v", err)
	}

	stagePath := filepath.Join(tmpHome, ".remote", "bin", "agenticRemote.staging")
	if _, err := os.Stat(stagePath); err == nil {
		t.Error("staged binary should be cleaned up")
	}
}

func TestInstall_ExistingConfig(t *testing.T) {
	tmpHome := t.TempDir()
	provider := &mockProvider{}
	svc := NewService(tmpHome, provider)

	// First install.
	if err := svc.Install(context.Background(), InstallOptions{}); err != nil {
		t.Fatalf("first install failed: %v", err)
	}

	// Second install should not overwrite config.
	configPath := filepath.Join(tmpHome, ".remote", "config.json")
	data1, _ := os.ReadFile(configPath)

	if err := svc.Install(context.Background(), InstallOptions{}); err != nil {
		t.Fatalf("second install failed: %v", err)
	}

	data2, _ := os.ReadFile(configPath)
	if !bytes.Equal(data1, data2) {
		t.Error("config should not be overwritten on idempotent install")
	}
}

func TestUninstall_Success(t *testing.T) {
	tmpHome := t.TempDir()
	provider := &mockProvider{}
	svc := NewService(tmpHome, provider)

	if err := svc.Install(context.Background(), InstallOptions{}); err != nil {
		t.Fatalf("install failed: %v", err)
	}

	if err := svc.Uninstall(context.Background(), UninstallOptions{Purge: false}); err != nil {
		t.Fatalf("uninstall failed: %v", err)
	}

	managed := filepath.Join(tmpHome, ".remote")
	configPath := filepath.Join(managed, "config.json")
	if _, err := os.Stat(configPath); err != nil {
		t.Errorf("config should be preserved: %v", err)
	}

	markerPath := filepath.Join(managed, ".agenticremote-managed.json")
	if _, err := os.Stat(markerPath); err != nil {
		t.Errorf("marker should be preserved: %v", err)
	}
}

func TestUninstall_Purge(t *testing.T) {
	tmpHome := t.TempDir()
	provider := &mockProvider{}
	svc := NewService(tmpHome, provider)

	if err := svc.Install(context.Background(), InstallOptions{}); err != nil {
		t.Fatalf("install failed: %v", err)
	}

	if err := svc.Uninstall(context.Background(), UninstallOptions{Purge: true}); err != nil {
		t.Fatalf("uninstall purge failed: %v", err)
	}

	managed := filepath.Join(tmpHome, ".remote")
	if _, err := os.Stat(managed); err == nil {
		t.Error("managed root should be removed after purge")
	}
}

func TestUninstall_InvalidMarker(t *testing.T) {
	tmpHome := t.TempDir()
	managed := filepath.Join(tmpHome, ".remote")
	os.MkdirAll(managed, 0o700)

	// Write garbage marker.
	markerPath := filepath.Join(managed, ".agenticremote-managed.json")
	os.WriteFile(markerPath, []byte("invalid"), 0o600)

	svc := NewService(tmpHome, &mockProvider{})
	err := svc.Uninstall(context.Background(), UninstallOptions{})
	if err == nil || !strings.Contains(err.Error(), "invalid marker") {
		t.Errorf("Uninstall should fail with invalid marker: %v", err)
	}
}

func TestConfig_DefaultValues(t *testing.T) {
	cfg := newDefaultConfig("/tmp/test", Config{})

	if cfg["listenAddr"] != "127.0.0.1:8765" {
		t.Errorf("default listen = %v", cfg["listenAddr"])
	}
	if cfg["stateDir"] != "state" {
		t.Errorf("default stateDir = %v", cfg["stateDir"])
	}

	cidrs := cfg["allowedCidrs"].([]string)
	if len(cidrs) < 2 {
		t.Errorf("default CIDRs should include loopback: %v", cidrs)
	}
}

func TestConfig_CustomValues(t *testing.T) {
	custom := Config{
		Listen:       "0.0.0.0:9999",
		AllowedCIDRs: []string{"192.168.0.0/16"},
		StateDir:     "custom",
	}
	cfg := newDefaultConfig("/tmp/test", custom)

	if cfg["listenAddr"] != "0.0.0.0:9999" {
		t.Errorf("custom listen = %v", cfg["listenAddr"])
	}
	if cfg["stateDir"] != "custom" {
		t.Errorf("custom stateDir = %v", cfg["stateDir"])
	}
}

func TestMarker_ReadWrite(t *testing.T) {
	tmpDir := t.TempDir()
	marker := &Marker{
		SchemaVersion: 1,
		ManagedRoot:   "/home/user/.remote",
		BinaryPath:    "/home/user/.remote/bin/agenticRemote",
		ConfigPath:    "/home/user/.remote/config.json",
	}

	if err := writeMarker(tmpDir, marker); err != nil {
		t.Fatalf("writeMarker failed: %v", err)
	}

	read, err := readMarker(tmpDir)
	if err != nil {
		t.Fatalf("readMarker failed: %v", err)
	}

	if read.SchemaVersion != 1 || read.ManagedRoot != marker.ManagedRoot {
		t.Error("marker round-trip failed")
	}
}

func TestSystemdUnit_Rendering(t *testing.T) {
	marker := &Marker{
		BinaryPath: "/home/user/.remote/bin/agenticRemote",
		ConfigPath: "/home/user/.remote/config.json",
	}

	unit := renderUnit(marker)

	required := []string{"[Unit]", "[Service]", "[Install]", "ExecStart=", "Restart=on-failure", "WorkingDirectory="}
	for _, req := range required {
		if !strings.Contains(unit, req) {
			t.Errorf("unit missing %q", req)
		}
	}
}

func TestSystemdUnitPath_DefaultXDG(t *testing.T) {
	tmpHome := t.TempDir()
	oldXDG := os.Getenv("XDG_CONFIG_HOME")
	defer os.Setenv("XDG_CONFIG_HOME", oldXDG)
	os.Unsetenv("XDG_CONFIG_HOME")

	path := systemdUnitPath(tmpHome)
	expected := filepath.Join(tmpHome, ".config", "systemd", "user", "agenticremote.service")
	if path != expected {
		t.Errorf("unit path = %s, want %s", path, expected)
	}
}

func TestMarker_RoundTrip(t *testing.T) {
	tmpDir := t.TempDir()

	original := &Marker{
		SchemaVersion:    1,
		ManagedRoot:      "/home/user/.remote",
		BinaryPath:       "/home/user/.remote/bin/agenticRemote",
		ConfigPath:       "/home/user/.remote/config.json",
		StatePath:        "/home/user/.remote/state",
		UnitPath:         "/home/user/.config/systemd/user/agenticremote.service",
		InstalledVersion: "v1.0.0",
		BinaryHash:       "abc123",
		ConfigHash:       "def456",
		UnitHash:         "ghi789",
	}

	if err := writeMarker(tmpDir, original); err != nil {
		t.Fatalf("writeMarker failed: %v", err)
	}

	read, err := readMarker(tmpDir)
	if err != nil {
		t.Fatalf("readMarker failed: %v", err)
	}

	if read.SchemaVersion != original.SchemaVersion ||
		read.InstalledVersion != original.InstalledVersion ||
		read.BinaryHash != original.BinaryHash {
		t.Error("marker fields mismatch after round-trip")
	}
}

func TestConfig_JSONSerialization(t *testing.T) {
	tmpFile := filepath.Join(t.TempDir(), "config.json")

	cfg := map[string]interface{}{
		"listenAddr":                "127.0.0.1:8765",
		"allowedCidrs":              []string{"127.0.0.0/8"},
		"pairingRotationSeconds":    45,
	}

	if err := writeConfig(tmpFile, cfg); err != nil {
		t.Fatalf("writeConfig failed: %v", err)
	}

	read, err := readConfig(tmpFile)
	if err != nil {
		t.Fatalf("readConfig failed: %v", err)
	}

	if read["listenAddr"] != "127.0.0.1:8765" {
		t.Errorf("listenAddr mismatch: %v", read["listenAddr"])
	}

	// Verify indentation.
	data, _ := os.ReadFile(tmpFile)
	if !bytes.Contains(data, []byte("\n  ")) {
		t.Error("config should be indented")
	}
}

func TestInstall_ConfigCustomization(t *testing.T) {
	tmpHome := t.TempDir()
	provider := &mockProvider{}
	svc := NewService(tmpHome, provider)

	opts := InstallOptions{
		Config: Config{
			Listen:        "0.0.0.0:8765",
			AllowedCIDRs:  []string{"10.0.0.0/8"},
			StateDir:      "mystate",
		},
	}

	if err := svc.Install(context.Background(), opts); err != nil {
		t.Fatalf("install failed: %v", err)
	}

	configPath := filepath.Join(tmpHome, ".remote", "config.json")
	data, _ := os.ReadFile(configPath)

	var cfg map[string]interface{}
	json.Unmarshal(data, &cfg)

	if cfg["listenAddr"] != "0.0.0.0:8765" {
		t.Errorf("config listen = %v, want 0.0.0.0:8765", cfg["listenAddr"])
	}
	if cfg["stateDir"] != "mystate" {
		t.Errorf("config stateDir = %v, want mystate", cfg["stateDir"])
	}
}
