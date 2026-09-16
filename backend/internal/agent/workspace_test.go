package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agenticremote/agenticremote/backend/internal/session"
)

func TestAgentWorkspaceRelativeCWDAndJSONSerialization(t *testing.T) {
	daemonHome := t.TempDir()
	stateDir := t.TempDir()
	workspaceRoot := t.TempDir()

	nestedDir := filepath.Join(workspaceRoot, "projects", "frontend")
	if err := os.MkdirAll(nestedDir, 0o755); err != nil {
		t.Fatalf("failed to create nested dir: %v", err)
	}

	mgr, err := session.NewManager(daemonHome, stateDir, workspaceRoot, 1024*1024, 100, nil)
	if err != nil {
		t.Fatalf("NewManager failed: %v", err)
	}
	defer mgr.Shutdown()

	svc := NewService(mgr, mgr.RuntimeStore(), stateDir)
	defer svc.Close()

	// 1. Root Agent creation: empty CWD -> AgentSession.CWD should be ""
	agentRoot, err := svc.CreateAgent(context.Background(), "", "Root Agent")
	if err != nil {
		t.Fatalf("CreateAgent (root) failed: %v", err)
	}
	if agentRoot.CWD != "" {
		t.Fatalf("expected AgentSession.CWD to be empty string for root, got %q", agentRoot.CWD)
	}

	// Verify JSON serialization contains no absolute host path prefix
	dataRoot, err := json.Marshal(agentRoot)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	var mapRoot map[string]any
	if err := json.Unmarshal(dataRoot, &mapRoot); err != nil {
		t.Fatalf("json.Unmarshal failed: %v", err)
	}
	if mapRoot["cwd"] != "" {
		t.Fatalf("expected serialized cwd to be \"\", got %v", mapRoot["cwd"])
	}
	if strings.Contains(string(dataRoot), workspaceRoot) {
		t.Fatalf("serialized JSON leaked host workspace root path %q: %s", workspaceRoot, string(dataRoot))
	}

	// 2. Nested Agent creation: "projects/frontend" -> AgentSession.CWD should be "projects/frontend"
	agentNested, err := svc.CreateAgent(context.Background(), "projects/frontend", "Nested Agent")
	if err != nil {
		t.Fatalf("CreateAgent (nested) failed: %v", err)
	}
	if agentNested.CWD != "projects/frontend" {
		t.Fatalf("expected AgentSession.CWD to be %q, got %q", "projects/frontend", agentNested.CWD)
	}

	dataNested, err := json.Marshal(agentNested)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	var mapNested map[string]any
	if err := json.Unmarshal(dataNested, &mapNested); err != nil {
		t.Fatalf("json.Unmarshal failed: %v", err)
	}
	if mapNested["cwd"] != "projects/frontend" {
		t.Fatalf("expected serialized cwd to be \"projects/frontend\", got %v", mapNested["cwd"])
	}
	if strings.Contains(string(dataNested), workspaceRoot) {
		t.Fatalf("serialized JSON leaked host workspace root path %q: %s", workspaceRoot, string(dataNested))
	}
}
