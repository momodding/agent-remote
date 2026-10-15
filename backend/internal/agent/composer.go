package agent

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	fsservice "github.com/agenticremote/agenticremote/backend/internal/fs"
	"github.com/agenticremote/agenticremote/backend/internal/harness"
	"github.com/agenticremote/agenticremote/backend/internal/protocol"
)

// ResolveMentionPath admits only an existing workspace-relative file whose
// symlink-resolved location remains under workspaceRoot. This is deliberately
// stricter than OMP's local resolver because this server is a remote boundary.
func ResolveMentionPath(workspaceRoot, mention string) (string, error) {
	if mention == "" {
		return "", errors.New("file mention path is required")
	}
	resolved, err := fsservice.ResolvePath(workspaceRoot, mention)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", errors.New("file mention must name a file")
	}
	return filepath.ToSlash(filepath.Clean(mention)), nil
}
func (s *Service) CommandDescriptors(agentID string) ([]protocol.AgentCommandDescriptor, error) {
	s.mu.RLock()
	inst, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok {
		return nil, ErrAgentNotFound
	}
	inst.mu.RLock()
	defer inst.mu.RUnlock()
	reason := ""
	if inst.runtime == nil {
		reason = "OMP runtime is unavailable"
	} else if safety := inst.runtime.ControlSafety(); !safety.Safe {
		reason = string(safety.Reason)
	}
	if inst.meta.State == "exited" {
		reason = "agent has exited"
	}
	return []protocol.AgentCommandDescriptor{
		{Name: "goal_show", Description: "Show the active OMP goal", Route: "omp.goal.show", Enabled: reason == "", DisabledReason: reason, PostCondition: "OMP renders goal details in the bound TUI session"},
		{Name: "plan_toggle", Description: "Toggle OMP plan mode", Route: "omp.plan.toggle", Enabled: reason == "", DisabledReason: reason, PostCondition: "bound OMP session emits a mode_change event"},
	}, nil
}

func (s *Service) ExecuteCommand(ctx context.Context, agentID, name string) error {
	var err error
	switch name {
	case "goal_show":
		err = s.RouteOMPGoalShow(ctx, agentID)
	case "plan_toggle":
		err = s.RouteOMPPlanToggle(ctx, agentID)
	default:
		return fmt.Errorf("unknown structured command %q", name)
	}
	if errors.Is(err, harness.ErrTUIConfirmationPending) {
		return nil
	}
	return err
}

func snapshotAttachment(workspaceRoot, agentID, source string) (string, string, error) {
	resolved, err := fsservice.ResolvePath(workspaceRoot, source)
	if err != nil {
		return "", "", err
	}
	fd, err := syscall.Open(resolved, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return "", "", err
	}
	in := os.NewFile(uintptr(fd), resolved)
	defer in.Close()
	info, err := in.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", "", errors.New("attachment must be a regular file")
	}
	dir := filepath.Join(workspaceRoot, ".agenticremote-attachments", agentID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", err
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", "", err
	}
	target := filepath.Join(dir, fmt.Sprintf("%x%s", nonce, filepath.Ext(source)))
	out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", "", err
	}
	if _, err := io.Copy(out, io.LimitReader(in, 50<<20)); err != nil {
		_ = out.Close()
		_ = os.Remove(target)
		return "", "", err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(target)
		return "", "", err
	}
	rel, err := filepath.Rel(workspaceRoot, target)
	if err != nil {
		_ = os.Remove(target)
		return "", "", err
	}
	return filepath.ToSlash(rel), target, nil
}

func removeSnapshots(paths []string) {
	for _, path := range paths {
		_ = os.Remove(path)
	}
}

// SubmitPromptWithAttachments sends supported binary images through the bridge
// and passes regular files as OMP-native @mentions. OMP 18.6.1's ExtensionAPI
// accepts only text/image content, while AgentSession expands @ references into
// fileMention transcript content before model delivery.
func (s *Service) SubmitPromptWithAttachments(agentID, prompt string, legacyImages []protocol.AgentPromptImage, attachments []protocol.AgentAttachment) error {
	s.mu.RLock()
	inst, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok {
		return ErrAgentNotFound
	}
	workspaceRoot := s.workspaceRoot
	if workspaceRoot == "" {
		workspaceRoot = inst.resolvedCWD
	}
	images := append([]protocol.AgentPromptImage(nil), legacyImages...)
	mentions := make([]string, 0, len(attachments))
	snapshots := make([]string, 0, len(attachments))
	for _, attachment := range attachments {
		if attachment.Name == "" || attachment.StorageRef == "" || attachment.SizeBytes < 0 {
			return errors.New("invalid attachment descriptor")
		}
		ref, snapshot, err := snapshotAttachment(workspaceRoot, agentID, attachment.StorageRef)
		if err != nil {
			return fmt.Errorf("attachment %q: %w", attachment.Name, err)
		}
		snapshots = append(snapshots, snapshot)
		if strings.HasPrefix(strings.ToLower(attachment.MIMEType), "image/") {
			images = append(images, protocol.AgentPromptImage{Path: ref})
		} else {
			mentions = append(mentions, "@"+ref)
		}
	}
	if len(mentions) > 0 {
		prompt = strings.TrimSpace(prompt + " " + strings.Join(mentions, " "))
	}
	if err := s.submitPromptFrom(agentID, prompt, images, workspaceRoot); err != nil {
		removeSnapshots(snapshots)
		return err
	}
	inst.mu.Lock()
	inst.stagedAttachments = append(inst.stagedAttachments, snapshots...)
	inst.mu.Unlock()
	return nil
}
