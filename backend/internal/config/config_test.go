package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultValues(t *testing.T) {
	cfg := Default()
	if cfg.ListenAddr != "127.0.0.1:8765" {
		t.Fatalf("unexpected listen addr: %s", cfg.ListenAddr)
	}
	if cfg.ListenScheme != "https" {
		t.Fatalf("unexpected listen scheme: %s", cfg.ListenScheme)
	}
	if cfg.SkipFingerprintVerification {
		t.Fatal("fingerprint bypass must default off")
	}
	if cfg.PairingRotationSeconds != 45 {
		t.Fatalf("unexpected pairing rotation seconds: %d", cfg.PairingRotationSeconds)
	}
	if err := Validate(cfg); err != nil {
		t.Fatalf("default config should validate: %v", err)
	}
}

func TestLoadAcceptsFingerprintBypass(t *testing.T) {
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
	  "skipFingerprintVerification": true,
	  "expoPushEndpoint": "https://exp.host/--/api/v2/push/send",
	  "pairingRotationSeconds": 30
	}`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.SkipFingerprintVerification {
		t.Fatal("expected fingerprint bypass to load")
	}
	if cfg.PairingRotationSeconds != 30 {
		t.Fatalf("expected pairing rotation seconds to load, got %d", cfg.PairingRotationSeconds)
	}
}

func TestInvalidCIDRRejected(t *testing.T) {
	cfg := Default()
	cfg.AllowedCIDRs = []string{"not-a-cidr"}
	if err := Validate(cfg); err == nil {
		t.Fatal("expected invalid CIDR to fail")
	}
}

func TestPairingRotationSecondsMustBePositive(t *testing.T) {
	cfg := Default()
	cfg.PairingRotationSeconds = 0
	if err := Validate(cfg); err == nil {
		t.Fatal("expected non-positive pairing rotation seconds to fail")
	}
}

func TestUploadDirOutsideWorkspaceRejected(t *testing.T) {
	cfg := Default()
	cfg.WorkspaceRoot = "/tmp/workspace"
	cfg.UploadDir = "../outside"
	if err := Validate(cfg); err == nil {
		t.Fatal("expected uploadDir escape to fail")
	}
}

func TestPublicEndpointValidation(t *testing.T) {
	tests := []struct {
		name     string
		endpoint string
		wantErr  bool
	}{
		{name: "rejects unsupported scheme", endpoint: "ftp://host:8765", wantErr: true},
		{name: "rejects missing host", endpoint: "https://", wantErr: true},
		{name: "rejects query", endpoint: "https://host:8765?x=1", wantErr: true},
		{name: "rejects path", endpoint: "https://host.example.com/base", wantErr: true},
		{name: "accepts https host", endpoint: "https://host.example.com:8765", wantErr: false},
		{name: "accepts http host", endpoint: "http://host.example.com:8765", wantErr: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := Default()
			cfg.PublicEndpoint = tt.endpoint
			err := Validate(cfg)
			if tt.wantErr && err == nil {
				t.Fatal("expected validation error")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("unexpected validation error: %v", err)
			}
		})
	}
}

func TestListenSchemeValidation(t *testing.T) {
	tests := []struct {
		name    string
		scheme  string
		wantErr bool
	}{
		{name: "default https", scheme: "https", wantErr: false},
		{name: "http", scheme: "http", wantErr: false},
		{name: "rejects invalid", scheme: "tcp", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := Default()
			cfg.ListenScheme = tt.scheme
			err := Validate(cfg)
			if tt.wantErr && err == nil {
				t.Fatal("expected validation error")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("unexpected validation error: %v", err)
			}
		})
	}
}
