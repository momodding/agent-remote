package agent

import (
	"bufio"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// DefaultAgentDir returns the root OMP agent directory (~/.omp/agent or $PI_CODING_AGENT_DIR).
func DefaultAgentDir() string {
	if dir := os.Getenv("PI_CODING_AGENT_DIR"); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(os.TempDir(), ".omp", "agent")
	}
	return filepath.Join(home, ".omp", "agent")
}

// TerminalIDFromTTY converts a Linux/POSIX TTY path (e.g., /dev/pts/3) to an OMP terminal ID (e.g., pts-3).
func TerminalIDFromTTY(ttyPath string) string {
	ttyPath = strings.TrimSpace(ttyPath)
	if strings.HasPrefix(ttyPath, "/dev/") {
		return strings.ReplaceAll(strings.TrimPrefix(ttyPath, "/dev/"), "/", "-")
	}
	return ""
}

// ReadTerminalBreadcrumb reads ~/.omp/agent/terminal-sessions/<terminalID> and returns the recorded session file.
func ReadTerminalBreadcrumb(agentDir, terminalID string) (cwd, sessionFile string, fresh bool, err error) {
	if terminalID == "" {
		return "", "", false, os.ErrNotExist
	}
	path := filepath.Join(agentDir, "terminal-sessions", terminalID)
	f, err := os.Open(path)
	if err != nil {
		return "", "", false, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	var lines []string
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		return "", "", false, err
	}
	if len(lines) < 2 {
		return "", "", false, os.ErrNotExist
	}
	cwd = lines[0]
	sessionFile = lines[1]
	if len(lines) >= 3 && lines[2] == "fresh" {
		fresh = true
	}
	return cwd, sessionFile, fresh, nil
}

// ComputeDefaultSessionDir returns the canonical OMP sessions directory for a given cwd.
func ComputeDefaultSessionDir(agentDir, cwd string) string {
	cleanCWD := filepath.Clean(cwd)
	home, err := os.UserHomeDir()
	if err == nil && home != "" {
		cleanHome := filepath.Clean(home)
		rel, err := filepath.Rel(cleanHome, cleanCWD)
		if err == nil && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel) {
			if rel == "." || rel == "" {
				return filepath.Join(agentDir, "sessions", "-")
			}
			encoded := strings.ReplaceAll(rel, string(filepath.Separator), "-")
			return filepath.Join(agentDir, "sessions", "-"+encoded)
		}
	}

	tempRoot := filepath.Clean(os.TempDir())
	relTmp, err := filepath.Rel(tempRoot, cleanCWD)
	if err == nil && !strings.HasPrefix(relTmp, "..") && !filepath.IsAbs(relTmp) {
		if relTmp == "." || relTmp == "" {
			return filepath.Join(agentDir, "sessions", "-tmp")
		}
		encoded := strings.ReplaceAll(relTmp, string(filepath.Separator), "-")
		return filepath.Join(agentDir, "sessions", "-tmp-"+encoded)
	}

	// Absolute fallback
	trimmed := strings.TrimPrefix(cleanCWD, string(filepath.Separator))
	encoded := strings.ReplaceAll(trimmed, string(filepath.Separator), "-")
	return filepath.Join(agentDir, "sessions", "--"+encoded+"--")
}

// FindLatestSessionFile looks for the most recently modified .jsonl file in the sessions directory.
func FindLatestSessionFile(sessionsDir string) (string, error) {
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		return "", err
	}
	var latestFile string
	var latestModTime int64
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if info.ModTime().UnixNano() >= latestModTime {
			latestModTime = info.ModTime().UnixNano()
			latestFile = filepath.Join(sessionsDir, entry.Name())
		}
	}
	if latestFile == "" {
		return "", os.ErrNotExist
	}
	return latestFile, nil
}

// FindOnlySessionFile permits cwd recovery only when exactly one transcript exists.
func FindOnlySessionFile(sessionsDir string) (string, error) {
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		return "", err
	}
	var file string
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".jsonl" {
			continue
		}
		if file != "" {
			return "", errors.New("ambiguous OMP session files")
		}
		file = filepath.Join(sessionsDir, entry.Name())
	}
	if file == "" {
		return "", os.ErrNotExist
	}
	return file, nil
}
