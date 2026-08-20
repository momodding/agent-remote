//go:build darwin
// +build darwin

package lifecycle

import (
	"context"
	"fmt"
	"html"
	"os"
	"path/filepath"
)

const launchAgentLabel = "com.agenticremote.daemon"

func (s *Service) installDarwin(ctx context.Context, opts InstallOptions) error {
	info, err := os.Stat(s.Home)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("install: daemon home is not a valid directory: %s", s.Home)
	}

	managed := filepath.Join(s.Home, ".remote")
	if err := os.MkdirAll(filepath.Join(managed, "bin"), 0o700); err != nil {
		return fmt.Errorf("install: create bin directory: %w", err)
	}

	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("install: cannot determine executable path: %w", err)
	}
	binaryPath := filepath.Join(managed, "bin", "agenticRemote")
	stagePath := binaryPath + ".staging"
	if err := copyFileAtomic(exe, stagePath, 0o755); err != nil {
		return fmt.Errorf("install: stage binary: %w", err)
	}
	if _, err := s.RunnerProvider.Command(ctx, stagePath, "version").CombinedOutput(); err != nil {
		_ = os.Remove(stagePath)
		return fmt.Errorf("install: verify binary failed: %w", err)
	}
	if err := os.Rename(stagePath, binaryPath); err != nil {
		_ = os.Remove(stagePath)
		return fmt.Errorf("install: atomic rename: %w", err)
	}

	configPath := filepath.Join(managed, "config.json")
	if _, err := os.Stat(configPath); err != nil {
		if !os.IsNotExist(err) {
			return fmt.Errorf("install: inspect config: %w", err)
		}
		if err := writeConfig(configPath, newDefaultConfig(s.Home, opts.Config)); err != nil {
			return fmt.Errorf("install: write config: %w", err)
		}
	}
	stateDirName := opts.Config.StateDir
	if stateDirName == "" {
		stateDirName = "state"
	}
	stateDir := filepath.Join(managed, stateDirName)
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return fmt.Errorf("install: create state dir: %w", err)
	}

	unitPath, err := launchAgentPath()
	if err != nil {
		return fmt.Errorf("install: resolve LaunchAgents directory: %w", err)
	}
	unitContent := renderLaunchAgent(binaryPath, configPath, stateDir)
	if err := os.MkdirAll(filepath.Dir(unitPath), 0o755); err != nil {
		return fmt.Errorf("install: create LaunchAgents directory: %w", err)
	}
	if err := os.WriteFile(unitPath, []byte(unitContent), 0o644); err != nil {
		return fmt.Errorf("install: write LaunchAgent plist: %w", err)
	}

	binaryHash, err := hashFile(binaryPath)
	if err != nil {
		return fmt.Errorf("install: hash binary: %w", err)
	}
	configHash, err := hashFile(configPath)
	if err != nil {
		return fmt.Errorf("install: hash config: %w", err)
	}
	marker := &Marker{
		SchemaVersion: 1,
		ManagedRoot:   managed,
		BinaryPath:    binaryPath,
		ConfigPath:    configPath,
		StatePath:     stateDir,
		UnitPath:      unitPath,
		BinaryHash:    binaryHash,
		ConfigHash:    configHash,
		UnitHash:      hashSHA256([]byte(unitContent)),
	}
	if err := writeMarker(managed, marker); err != nil {
		return fmt.Errorf("install: write marker: %w", err)
	}

	_ = s.launchctl(ctx, "bootout", launchAgentDomain())
	if err := s.launchctl(ctx, "bootstrap", launchAgentDomain(), unitPath); err != nil {
		return fmt.Errorf("install: bootstrap LaunchAgent: %w", err)
	}
	return nil
}

func (s *Service) uninstallDarwin(ctx context.Context, opts UninstallOptions) error {
	managed := filepath.Join(s.Home, ".remote")
	marker, err := readMarker(managed)
	if err != nil {
		return fmt.Errorf("uninstall: invalid marker: %w", err)
	}
	_ = s.launchctl(ctx, "bootout", launchAgentDomain())
	if err := os.Remove(marker.UnitPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("uninstall: remove LaunchAgent plist: %w", err)
	}
	if opts.Purge {
		if err := os.RemoveAll(managed); err != nil {
			return fmt.Errorf("uninstall: purge managed root: %w", err)
		}
	}
	return nil
}

func (s *Service) restartDarwin(ctx context.Context) error {
	return s.launchctl(ctx, "kickstart", "-k", launchAgentDomain())
}

func (s *Service) launchctl(ctx context.Context, args ...string) error {
	out, err := s.RunnerProvider.Command(ctx, "launchctl", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %w", string(out), err)
	}
	return nil
}

func launchAgentPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", launchAgentLabel+".plist"), nil
}

func launchAgentDomain() string {
	return fmt.Sprintf("gui/%d/%s", os.Getuid(), launchAgentLabel)
}

func renderLaunchAgent(binaryPath, configPath, stateDir string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>%s</string>
<key>ProgramArguments</key><array><string>%s</string><string>serve</string><string>--config</string><string>%s</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>%s/daemon.log</string>
<key>StandardErrorPath</key><string>%s/daemon.log</string>
</dict></plist>
`, launchAgentLabel, html.EscapeString(binaryPath), html.EscapeString(configPath), html.EscapeString(stateDir), html.EscapeString(stateDir))
}
