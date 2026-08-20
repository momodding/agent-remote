// +build darwin

package lifecycle

// Darwin-specific lifecycle support for LaunchAgents.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (s *Service) Install(ctx context.Context, opts InstallOptions) error {
	info, err := os.Stat(s.Home)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("daemon home is not a valid directory")
	}

	binDir := filepath.Join(s.Home, "bin")
	stateDir := filepath.Join(s.Home, "state")
	for _, dir := range []string{binDir, stateDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("mkdir %s: %w", dir, err)
		}
	}

	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("could not resolve executable: %w", err)
	}
	installPath := filepath.Join(binDir, "agenticRemote")

	staged := installPath + ".staged"
	if err := copyFileAtomic(executable, staged, 0o755); err != nil {
		return fmt.Errorf("stage binary: %w", err)
	}

	runner := s.RunnerProvider.Command(ctx, staged, "version")
	if out, err := runner.CombinedOutput(); err != nil || !strings.Contains(string(out), "agenticRemote") {
		_ = os.Remove(staged)
		return fmt.Errorf("verify binary failed: %v", err)
	}

	if err := os.Rename(staged, installPath); err != nil {
		return fmt.Errorf("install binary: %w", err)
	}

	configPath := filepath.Join(s.Home, "config.json")
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		opts.Config.StateDir = stateDir
		if err := writeJSONAtomic(configPath, opts.Config, 0o600); err != nil {
			return fmt.Errorf("write config: %w", err)
		}
	}

	binHash, _ := hashFile(installPath)
	cfgHash, _ := hashFile(configPath)

	userHome, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("user home: %w", err)
	}
	unitDir := filepath.Join(userHome, "Library", "LaunchAgents")
	if err := os.MkdirAll(unitDir, 0o755); err != nil {
		return fmt.Errorf("mkdir launchagents: %w", err)
	}

	plistPath := filepath.Join(unitDir, "com.agenticremote.daemon.plist")
	plistContent := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agenticremote.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>%s</string>
        <string>start</string>
        <string>--config</string>
        <string>%s</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>%s/daemon.log</string>
    <key>StandardErrorPath</key>
    <string>%s/daemon.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>`, installPath, configPath, stateDir, stateDir)

	if err := os.WriteFile(plistPath, []byte(plistContent), 0o644); err != nil {
		return fmt.Errorf("write plist: %w", err)
	}

	unitHash, _ := hashFile(plistPath)

	marker := Marker{
		SchemaVersion:    1,
		ManagedRoot:      s.Home,
		BinaryPath:       installPath,
		ConfigPath:       configPath,
		StatePath:        stateDir,
		UnitPath:         plistPath,
		InstalledVersion: "local",
		BinaryHash:       binHash,
		ConfigHash:       cfgHash,
		UnitHash:         unitHash,
	}

	markerPath := filepath.Join(s.Home, "install.json")
	if err := writeJSONAtomic(markerPath, marker, 0o644); err != nil {
		return fmt.Errorf("write marker: %w", err)
	}

	_ = s.RunnerProvider.Command(ctx, "launchctl", "unload", plistPath).CombinedOutput()
	if _, err := s.RunnerProvider.Command(ctx, "launchctl", "load", "-w", plistPath).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl load: %w", err)
	}

	return nil

func (s *Service) Uninstall(ctx context.Context, opts UninstallOptions) error {
	markerPath := filepath.Join(s.Home, "install.json")
	var marker Marker
	if err := readJSON(markerPath, &marker); err != nil {
		return fmt.Errorf("invalid marker: %w", err)
	}

	_ = s.RunnerProvider.Command(ctx, "launchctl", "unload", "-w", marker.UnitPath).CombinedOutput()
	_ = os.Remove(marker.UnitPath)

	if opts.Purge {
		return os.RemoveAll(s.Home)
	}
	return nil

func (s *Service) Update(ctx context.Context, opts UpdateOptions) error {
	return fmt.Errorf("not implemented")


	// Re-using common util from linux
	return nil
