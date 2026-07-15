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
