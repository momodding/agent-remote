package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	ListenAddr                  string   `json:"listenAddr"`
	ListenScheme                string   `json:"listenScheme"`
	PublicEndpoint              string   `json:"publicEndpoint"`
	StateDir                    string   `json:"stateDir"`
	WorkspaceRoot               string   `json:"workspaceRoot"`
	UploadDir                   string   `json:"uploadDir"`
	AllowedCIDRs                []string `json:"allowedCidrs"`
	MaxConnections              int      `json:"maxConnections"`
	MaxSessions                 int      `json:"maxSessions"`
	ChannelBufferSize           int      `json:"channelBufferSize"`
	MaxScrollbackBytes          int64    `json:"maxScrollbackBytes"`
	AllowDestructiveFiles       bool     `json:"allowDestructiveFiles"`
	SkipFingerprintVerification bool     `json:"skipFingerprintVerification"`
	ExpoPushEndpoint            string   `json:"expoPushEndpoint"`
	PairingRotationSeconds      int      `json:"pairingRotationSeconds"`
	PairingPageUsername         string   `json:"pairingPageUsername"`
	PairingPagePassword         string   `json:"pairingPagePassword"`
	VNCPort                     int      `json:"vncPort"`
}

func Default() Config {
	return Config{
		ListenAddr:                  "127.0.0.1:8765",
		ListenScheme:                "https",
		PublicEndpoint:              "https://127.0.0.1:8765",
		StateDir:                    ".agenticremote",
		WorkspaceRoot:               ".",
		UploadDir:                   "uploads",
		AllowedCIDRs:                []string{"127.0.0.0/8", "::1/128"},
		MaxConnections:              8,
		MaxSessions:                 16,
		ChannelBufferSize:           256,
		MaxScrollbackBytes:          10485760,
		AllowDestructiveFiles:       true,
		SkipFingerprintVerification: false,
		ExpoPushEndpoint:            "https://exp.host/--/api/v2/push/send",
		PairingRotationSeconds:      45,
		VNCPort:                     5900,
	}
}

func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	cfg := Default()
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, err
	}
	if err := Validate(cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func Validate(cfg Config) error {
	if cfg.MaxConnections <= 0 || cfg.MaxSessions <= 0 || cfg.ChannelBufferSize <= 0 || cfg.MaxScrollbackBytes <= 0 || cfg.PairingRotationSeconds <= 0 {
		return errors.New("limits must be positive")
	}
	if cfg.ListenScheme != "http" && cfg.ListenScheme != "https" {
		return errors.New("listenScheme must be http or https")
	}
	u, err := url.Parse(cfg.PublicEndpoint)
	if err != nil {
		return fmt.Errorf("invalid publicEndpoint: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New("publicEndpoint must use http or https")
	}
	if u.Host == "" {
		return errors.New("publicEndpoint must include host")
	}
	if u.Path != "" && u.Path != "/" {
		return errors.New("publicEndpoint must not include path")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return errors.New("publicEndpoint must not include query or fragment")
	}

	for _, cidr := range cfg.AllowedCIDRs {
		if _, _, err := net.ParseCIDR(cidr); err != nil {
			return fmt.Errorf("invalid allowedCidrs entry %q: %w", cidr, err)
		}
	}
	workspaceAbs, err := filepath.Abs(cfg.WorkspaceRoot)
	if err != nil {
		return err
	}
	uploadAbs, err := filepath.Abs(filepath.Join(workspaceAbs, cfg.UploadDir))
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(workspaceAbs, uploadAbs)
	if err != nil {
		return err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return errors.New("uploadDir must stay within workspaceRoot")
	}
	if (cfg.PairingPageUsername == "") != (cfg.PairingPagePassword == "") {
		return errors.New("pairingPageUsername and pairingPagePassword must be set together")
	}
	if cfg.VNCPort < 1 || cfg.VNCPort > 65535 {
		return errors.New("vncPort must be 1-65535")
	}
	return nil
}

func CleanState(configPath string) error {
	cfg := Default()
	if data, err := os.ReadFile(configPath); err == nil {
		if err := json.Unmarshal(data, &cfg); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	stateDir := filepath.Join(filepath.Dir(configPath), cfg.StateDir)
	for _, name := range []string{"tls", "auth", "sessions"} {
		if err := os.RemoveAll(filepath.Join(stateDir, name)); err != nil {
			return err
		}
	}
	return nil
}

func WriteSample(path string, cfg Config) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

// AppendDefaults adds new default keys without altering existing JSON values.
func AppendDefaults(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var existing map[string]json.RawMessage
	if err := json.Unmarshal(data, &existing); err != nil {
		return err
	}
	if existing == nil {
		return errors.New("config must be a JSON object")
	}
	defaultData, err := json.Marshal(Default())
	if err != nil {
		return err
	}
	var defaults map[string]json.RawMessage
	if err := json.Unmarshal(defaultData, &defaults); err != nil {
		return err
	}
	for key, value := range defaults {
		if _, ok := existing[key]; !ok {
			existing[key] = value
		}
	}
	data, err = json.MarshalIndent(existing, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}
