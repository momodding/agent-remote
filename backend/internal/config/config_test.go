package config

import "testing"

func TestDefaultValues(t *testing.T) {
	cfg := Default()
	if cfg.ListenAddr != "127.0.0.1:8765" {
		t.Fatalf("unexpected listen addr: %s", cfg.ListenAddr)
	}
	if err := Validate(cfg); err != nil {
		t.Fatalf("default config should validate: %v", err)
	}
}

func TestInvalidCIDRRejected(t *testing.T) {
	cfg := Default()
	cfg.AllowedCIDRs = []string{"not-a-cidr"}
	if err := Validate(cfg); err == nil {
		t.Fatal("expected invalid CIDR to fail")
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
		{name: "rejects non https", endpoint: "http://host:8765", wantErr: true},
		{name: "rejects missing host", endpoint: "https://", wantErr: true},
		{name: "rejects query", endpoint: "https://host:8765?x=1", wantErr: true},
		{name: "rejects path", endpoint: "https://host.example.com/base", wantErr: true},
		{name: "accepts https host", endpoint: "https://host.example.com:8765", wantErr: false},
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
