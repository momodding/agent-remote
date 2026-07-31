package lifecycle

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Marker represents the ownership/metadata file written by install.
type Marker struct {
	SchemaVersion int    `json:"schemaVersion"`
	ManagedRoot   string `json:"managedRoot"`
	BinaryPath    string `json:"binaryPath"`
	ConfigPath    string `json:"configPath"`
	StatePath     string `json:"statePath"`
	UnitPath      string `json:"unitPath"`
	InstalledVersion string `json:"installedVersion,omitempty"`
	BinaryHash    string `json:"binaryHash,omitempty"`
	ConfigHash    string `json:"configHash,omitempty"`
	UnitHash      string `json:"unitHash,omitempty"`
}

// readMarker reads the marker file from the managed root.
func readMarker(managed string) (*Marker, error) {
	path := filepath.Join(managed, ".agenticremote-managed.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read marker: %w", err)
	}
	var m Marker
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parse marker: %w", err)
	}
	return &m, nil
}

// writeMarker writes the marker file to the managed root.
func writeMarker(managed string, m *Marker) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal marker: %w", err)
	}
	path := filepath.Join(managed, ".agenticremote-managed.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("write marker: %w", err)
	}
	return nil
}

// readConfig reads the managed config file.
func readConfig(path string) (map[string]interface{}, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var cfg map[string]interface{}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	return cfg, nil
}

// writeConfig writes the config file.
func writeConfig(path string, cfg map[string]interface{}) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	return nil
}
