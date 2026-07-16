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
	ListenAddr            string   `json:"listenAddr"`
	ListenScheme          string   `json:"listenScheme"`
	PublicEndpoint        string   `json:"publicEndpoint"`
	StateDir              string   `json:"stateDir"`
	WorkspaceRoot         string   `json:"workspaceRoot"`
	UploadDir             string   `json:"uploadDir"`
	AllowedCIDRs          []string `json:"allowedCidrs"`
	MaxConnections        int      `json:"maxConnections"`
	MaxSessions           int      `json:"maxSessions"`
	ChannelBufferSize     int      `json:"channelBufferSize"`
	MaxScrollbackBytes    int64    `json:"maxScrollbackBytes"`
	AllowDestructiveFiles bool     `json:"allowDestructiveFiles"`
	ExpoPushEndpoint      string   `json:"expoPushEndpoint"`
}

func Default() Config {
	return Config{
		ListenAddr:            "127.0.0.1:8765",
		ListenScheme:          "https",
		PublicEndpoint:        "https://127.0.0.1:8765",
		StateDir:              ".agenticremote",
		WorkspaceRoot:         ".",
		UploadDir:             "uploads",
		AllowedCIDRs:          []string{"127.0.0.0/8", "::1/128"},
		MaxConnections:        8,
		MaxSessions:           16,
		ChannelBufferSize:     256,
		MaxScrollbackBytes:    10485760,
		AllowDestructiveFiles: false,
		ExpoPushEndpoint:      "https://exp.host/--/api/v2/push/send",
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
	if cfg.MaxConnections <= 0 || cfg.MaxSessions <= 0 || cfg.ChannelBufferSize <= 0 || cfg.MaxScrollbackBytes <= 0 {
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
	return nil
}

func WriteSample(path string, cfg Config) error {
	if _, err := os.Stat(path); err == nil {
		return fmt.Errorf("config already exists: %s", path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(path, data, 0o644)
}
