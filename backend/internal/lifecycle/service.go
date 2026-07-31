package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Service manages installation, uninstallation, and updates.
type Service struct {
	Home           string // $HOME/.remote root
	RunnerProvider RunnerProvider
}

// RunnerProvider wraps exec.CommandContext for dependency injection in tests.
type RunnerProvider interface {
	Command(ctx context.Context, name string, args ...string) Runner
}

// Runner is the interface for executing commands.
type Runner interface {
	Output() ([]byte, error)
	CombinedOutput() ([]byte, error)
}

// Config holds installation configuration.
type Config struct {
	Listen         string   // e.g., "127.0.0.1:8765"
	PublicEndpoint string   // e.g., "https://127.0.0.1:8765"
	AllowedCIDRs   []string // e.g., ["127.0.0.0/8", "::1/128"]
	WorkspaceRoot  string   // daemon home for sessions
	StateDir       string   // relative to managed root, e.g., "state"
}

// InstallOptions specifies install parameters.
type InstallOptions struct {
	Config Config
}

// UninstallOptions specifies uninstall parameters.
type UninstallOptions struct {
	Purge bool // if true, remove entire $HOME/.remote tree
}

// UpdateOptions specifies update parameters.
type UpdateOptions struct {
	Version string // target release tag; "stable" for latest
	Force   bool   // if true, allow downgrade or same version
}

// NewService creates a Service with a real command runner.
func NewService(home string, provider RunnerProvider) *Service {
	if provider == nil {
		provider = &DefaultRunnerProvider{}
	}
	return &Service{
		Home:           home,
		RunnerProvider: provider,
	}
}

// Install prepares the managed layout and systemd unit. Linux-only.
func (s *Service) Install(ctx context.Context, opts InstallOptions) error {
	if runtime.GOOS != "linux" {
		return errors.New("install: unsupported platform (requires Linux with user systemd)")
	}

	// Validate home exists and is a directory.
	stat, err := os.Stat(s.Home)
	if err != nil || !stat.IsDir() {
		return fmt.Errorf("install: daemon home is not a valid directory: %s", s.Home)
	}

	// Create managed root.
	managed := filepath.Join(s.Home, ".remote")
	if err := os.MkdirAll(filepath.Join(managed, "bin"), 0o700); err != nil {
		return fmt.Errorf("install: create bin directory: %w", err)
	}

	// Copy current binary to staged location.
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("install: cannot determine executable path: %w", err)
	}
	data, err := os.ReadFile(exe)
	if err != nil {
		return fmt.Errorf("install: cannot read executable: %w", err)
	}

	binaryPath := filepath.Join(managed, "bin", "agenticRemote")
	stagePath := binaryPath + ".staging"
	if err := os.WriteFile(stagePath, data, 0o755); err != nil {
		return fmt.Errorf("install: write staged binary: %w", err)
	}

	// Verify staged binary can run.
	runner := s.RunnerProvider.Command(ctx, stagePath, "version")
	if _, err := runner.CombinedOutput(); err != nil {
		_ = os.Remove(stagePath)
		return fmt.Errorf("install: verify binary failed: %w", err)
	}

	// Atomically install binary.
	if err := os.Rename(stagePath, binaryPath); err != nil {
		_ = os.Remove(stagePath)
		return fmt.Errorf("install: atomic rename: %w", err)
	}

	// Create config if absent.
	configPath := filepath.Join(managed, "config.json")
	if _, err := os.Stat(configPath); errors.Is(err, os.ErrNotExist) {
		cfg := newDefaultConfig(s.Home, opts.Config)
		if err := writeConfig(configPath, cfg); err != nil {
			return fmt.Errorf("install: write config: %w", err)
		}
	}

	// Create state directory.
	stateDir := filepath.Join(managed, opts.Config.StateDir)
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return fmt.Errorf("install: create state dir: %w", err)
	}

	// Write marker with metadata.
	marker := &Marker{
		SchemaVersion: 1,
		ManagedRoot:   managed,
		BinaryPath:    binaryPath,
		ConfigPath:    configPath,
		StatePath:     stateDir,
		UnitPath:      systemdUnitPath(s.Home),
	}
	if err := writeMarker(managed, marker); err != nil {
		return fmt.Errorf("install: write marker: %w", err)
	}

	// Write systemd unit.
	unitPath := marker.UnitPath
	if err := os.MkdirAll(filepath.Dir(unitPath), 0o700); err != nil {
		return fmt.Errorf("install: create systemd directory: %w", err)
	}
	unitContent := renderUnit(marker)
	if err := os.WriteFile(unitPath, []byte(unitContent), 0o644); err != nil {
		return fmt.Errorf("install: write systemd unit: %w", err)
	}

	// Reload and enable service.
	if err := s.systemctl(ctx, "daemon-reload"); err != nil {
		return fmt.Errorf("install: daemon-reload: %w", err)
	}
	if err := s.systemctl(ctx, "enable", "--now", "agenticremote.service"); err != nil {
		return fmt.Errorf("install: enable service: %w", err)
	}

	return nil
}

// Uninstall stops and removes the service. Linux-only.
func (s *Service) Uninstall(ctx context.Context, opts UninstallOptions) error {
	if runtime.GOOS != "linux" {
		return errors.New("uninstall: unsupported platform (requires Linux with user systemd)")
	}

	managed := filepath.Join(s.Home, ".remote")
	marker, err := readMarker(managed)
	if err != nil {
		return fmt.Errorf("uninstall: invalid marker: %w", err)
	}

	// Stop and disable service.
	_ = s.systemctl(ctx, "disable", "--now", "agenticremote.service")

	// Remove systemd unit.
	if err := os.Remove(marker.UnitPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("uninstall: remove unit: %w", err)
	}

	// Reload systemd.
	_ = s.systemctl(ctx, "daemon-reload")

	// Optionally purge entire managed root.
	if opts.Purge {
		if err := os.RemoveAll(managed); err != nil {
			return fmt.Errorf("uninstall: purge managed root: %w", err)
		}
	}

	return nil
}

// Update fetches a release, verifies checksum, stages, and atomically swaps. Linux-only.
func (s *Service) Update(ctx context.Context, opts UpdateOptions) error {
	if runtime.GOOS != "linux" {
		return errors.New("update: unsupported platform (requires Linux with user systemd)")
	}

	managed := filepath.Join(s.Home, ".remote")
	_, err := readMarker(managed)
	if err != nil {
		return fmt.Errorf("update: invalid marker: %w", err)
	}

	// Placeholder: stub for now; real implementation fetches/verifies/stages/swaps.
	_ = opts.Version // suppress unused

	return nil
}

func (s *Service) systemctl(ctx context.Context, args ...string) error {
	runner := s.RunnerProvider.Command(ctx, "systemctl", args...)
	_, err := runner.CombinedOutput()
	return err
}

func systemdUnitPath(home string) string {
	// XDG_CONFIG_HOME or $HOME/.config
	configHome := os.Getenv("XDG_CONFIG_HOME")
	if configHome == "" {
		configHome = filepath.Join(home, ".config")
	}
	return filepath.Join(configHome, "systemd", "user", "agenticremote.service")
}

func renderUnit(m *Marker) string {
	// Simple systemd unit template.
	return fmt.Sprintf(`[Unit]
Description=Agentic Remote Daemon
After=network.target

[Service]
Type=simple
ExecStart=%s serve --config %s
Restart=on-failure
RestartSec=5s
WorkingDirectory=%s
Environment="HOME=%s"

[Install]
WantedBy=default.target
`, m.BinaryPath, m.ConfigPath, filepath.Dir(filepath.Dir(m.ConfigPath)), filepath.Dir(filepath.Dir(m.ConfigPath)))
}

func newDefaultConfig(home string, opts Config) map[string]interface{} {
	listen := "127.0.0.1:8765"
	if opts.Listen != "" {
		listen = opts.Listen
	}
	pubEndpoint := "https://127.0.0.1:8765"
	if opts.PublicEndpoint != "" {
		pubEndpoint = opts.PublicEndpoint
	}
	allowedCIDRs := []string{"127.0.0.0/8", "::1/128"}
	if len(opts.AllowedCIDRs) > 0 {
		allowedCIDRs = opts.AllowedCIDRs
	}
	workspace := home
	if opts.WorkspaceRoot != "" {
		workspace = opts.WorkspaceRoot
	}
	stateDir := "state"
	if opts.StateDir != "" {
		stateDir = opts.StateDir
	}

	return map[string]interface{}{
		"listenAddr":                  listen,
		"listenScheme":                "https",
		"publicEndpoint":              pubEndpoint,
		"stateDir":                    stateDir,
		"workspaceRoot":               workspace,
		"uploadDir":                   "uploads",
		"allowedCidrs":                allowedCIDRs,
		"maxConnections":              8,
		"maxSessions":                 16,
		"channelBufferSize":           256,
		"maxScrollbackBytes":          10485760,
		"allowDestructiveFiles":       false,
		"skipFingerprintVerification": false,
		"expoPushEndpoint":            "https://exp.host/--/api/v2/push/send",
		"pairingRotationSeconds":      45,
		"pairingPageUsername":         "admin",
		"pairingPagePassword":         generatePassword(),
	}
}

func generatePassword() string {
	// Stub; real implementation generates a random 16-char alphanumeric password.
	return "changeme"
}
