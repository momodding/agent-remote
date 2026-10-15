package agent

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/harness"
	"github.com/agenticremote/agenticremote/backend/internal/protocol"
	runtimestore "github.com/agenticremote/agenticremote/backend/internal/runtime"
)

var (
	ErrAgentNotFound = errors.New("agent not found")
	ErrAgentExited   = errors.New("agent has exited")
)

const bridgeReconnectGrace = 6 * time.Second

const (
	semanticOwnerBridge = "bridge"
	semanticOwnerTailer = "tailer"
)

func newAgentID() (string, error) {
	data := make([]byte, 16)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return "agent_" + hex.EncodeToString(data), nil
}

// TerminalManager is the minimal interface needed from session.Manager.
type TerminalManager interface {
	Create(ctx context.Context, req protocol.CreateSessionRequest) (*protocol.SessionSummary, error)
	Input(id string, b []byte) error
	Close(id string) error
	Terminate(ctx context.Context, id string) error
	Subscribe(id string, fn func(protocol.PTYOutputEnvelope, protocol.SessionStateEnvelope)) (func(), error)
}

type terminalTTYProvider interface {
	TerminalTTY(id string) string
}

type terminalLister interface {
	List(ctx context.Context) []protocol.SessionSummary
}

type AgentSubscriber struct {
	fn func(protocol.AgentEvent)
}

func transcriptFallbackDeadline(termMgr TerminalManager) time.Time {
	if _, ok := termMgr.(terminalTTYProvider); ok {
		return time.Now().Add(bridgeReconnectGrace)
	}
	return time.Time{}
}

type agentInstance struct {
	mu                      sync.RWMutex
	tailerMu                sync.Mutex
	meta                    protocol.AgentSession
	tailer                  *TranscriptTailer
	sessionFile             string
	agentDir                string
	resolvedCWD             string
	termID                  string
	harness                 *harness.OMPAdapter
	runtime                 *harness.OmpRuntimeState
	compositeObserver       *harness.CompositeRuntimeObserver
	lastObservation         *harness.Observation
	subscribers             map[int]*AgentSubscriber
	nextSubID               int
	stopPoll                chan struct{}
	stopPollOnce            sync.Once
	pollDone                chan struct{}
	stopTerminal            func()
	pollInterval            time.Duration
	transcriptFallbackAfter time.Time
	semanticOwner           string
	stagedAttachments       []string
}

type Service struct {
	mu            sync.RWMutex
	termMgr       TerminalManager
	store         *runtimestore.Store
	agentDir      string
	workspaceRoot string
	agents        map[string]*agentInstance
	byTerminal    map[string]string // terminalID -> agentID
	bridgeServer  *BridgeServer
	closing       bool
}

func NewService(termMgr TerminalManager, store *runtimestore.Store, agentDir string) *Service {
	if agentDir == "" {
		agentDir = DefaultAgentDir()
	}
	_ = os.MkdirAll(agentDir, 0o700)
	workspaceRoot := ""
	if provider, ok := termMgr.(interface{ WorkspaceRoot() string }); ok {
		workspaceRoot = provider.WorkspaceRoot()
	}

	s := &Service{
		termMgr:       termMgr,
		store:         store,
		agentDir:      agentDir,
		workspaceRoot: workspaceRoot,
		agents:        make(map[string]*agentInstance),
		byTerminal:    make(map[string]string),
	}

	socketPath := filepath.Join(agentDir, "bridge.sock")
	if bs, err := NewBridgeServer(socketPath, s.handleBridgeHello, s.handleBridgeDisconnect, s.handleBridgeLifecycle, s.handleBridgeSemantic, s.handleBridgeMetadata); err == nil {
		s.bridgeServer = bs
		log.Printf("[bridgeServer] Listening successfully at %s", socketPath)
	} else {
		log.Printf("[bridgeServer] FAILED to init bridge server at %s: %v", socketPath, err)
	}

	s.restorePersisted()
	return s
}
func (s *Service) toWorkspaceRelative(p string) string {
	if relProvider, ok := s.termMgr.(interface{ ToWorkspaceRelative(string) string }); ok {
		return relProvider.ToWorkspaceRelative(p)
	}
	return p
}

func cloneHarnessRuntime(runtime *protocol.HarnessRuntimeState) *protocol.HarnessRuntimeState {
	if runtime == nil {
		return nil
	}
	return &protocol.HarnessRuntimeState{
		SessionMode: runtime.SessionMode,
		Features:    append([]string(nil), runtime.Features...),
		Commands:    append([]string(nil), runtime.Commands...),
	}
}

func loadPromptImages(baseDir string, images []protocol.AgentPromptImage) ([]map[string]string, error) {
	encoded := make([]map[string]string, 0, len(images))
	for _, image := range images {
		if image.Path == "" || filepath.IsAbs(image.Path) || strings.Contains(image.Path, "..") {
			return nil, errors.New("invalid image path")
		}
		path := filepath.Join(baseDir, filepath.FromSlash(image.Path))
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		if len(data) == 0 || len(data) > 10*1024*1024 {
			return nil, errors.New("image size must be between 1 byte and 10 MiB")
		}
		mime := map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}[strings.ToLower(filepath.Ext(path))]
		if mime == "" {
			return nil, errors.New("unsupported image type")
		}
		encoded = append(encoded, map[string]string{"type": "image", "data": base64.StdEncoding.EncodeToString(data), "mimeType": mime})
	}
	return encoded, nil
}

func (s *Service) handleBridgeHello(agentID string, hello BridgeHello) bool {
	if hello.SessionID == "" || hello.SessionFile == "" {
		return false
	}
	s.mu.RLock()
	inst, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok || inst == nil {
		return false
	}

	inst.mu.Lock()
	if (inst.meta.OMPSessionID != "" && inst.meta.OMPSessionID != hello.SessionID) || (inst.meta.OMPSessionFile != "" && inst.meta.OMPSessionFile != hello.SessionFile) {
		inst.mu.Unlock()
		if s.bridgeServer == nil || !s.bridgeServer.IsConnected(agentID) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := s.terminateAgentRuntime(ctx, inst, "mismatched session identity on bridge connect"); err != nil {
				// Log but continue; agent will be re-negotiated
			}
		}
		return false
	}
	inst.meta.OMPSessionID = hello.SessionID
	if inst.semanticOwner == "" {
		inst.semanticOwner = semanticOwnerBridge
	}
	inst.meta.OMPSessionFile = hello.SessionFile
	inst.sessionFile = hello.SessionFile
	capsMap := make(map[string]bool)
	for _, c := range hello.Capabilities {
		capsMap[c] = true
	}
	inst.meta.Capabilities = []protocol.AgentCapability{
		{Name: "chat", Enabled: true},
		{Name: "prompt", Enabled: capsMap["prompt"]},
		{Name: "abort", Enabled: capsMap["abort"]},
		{Name: "model", Enabled: capsMap["model"]},
		{Name: "thinking", Enabled: capsMap["thinking"]},
	}
	if hello.Model != nil {
		inst.meta.Model = hello.Model
	}
	if hello.Thinking != "" {
		inst.meta.Thinking = hello.Thinking
	}
	if len(hello.AvailableModels) > 0 {
		inst.meta.AvailableModels = append([]protocol.AgentModelInfo(nil), hello.AvailableModels...)
	}
	if len(hello.AvailableThinking) > 0 {
		inst.meta.AvailableThinking = append([]string(nil), hello.AvailableThinking...)
	}
	if hello.HarnessRuntime != nil {
		inst.meta.HarnessRuntime = cloneHarnessRuntime(hello.HarnessRuntime)
	}
	inst.meta.UpdatedAt = time.Now().UTC()
	// A bridge reconnect is a new live-observer boundary. Replay the exact
	// bound JSONL through a fresh tailer so mode events are source-backed for
	// newly attached clients, while bridge remains the sole message owner.
	inst.tailer = NewTranscriptTailer(inst.meta.ID, hello.SessionFile, s.store)
	tailer := inst.tailer
	observer := inst.compositeObserver
	runtime := inst.runtime
	terminalID := inst.meta.TerminalSessionID
	inst.mu.Unlock()
	if runtime != nil {
		runtime.SetBridgeReady(true)
	}
	if observer != nil {
		observer.ApplyBridgeHello(agentID, terminalID, hello.SessionID, hello.SessionFile, "")
	}
	s.reconstructTailerMode(inst, tailer)
	s.recordAgentSummary(inst, "agent.updated")
	s.emitState(inst)
	return true
}

// reconstructTailerMode advances the existing JSONL tailer stream and accepts
// only source-backed mode_change entries; bridge semantic events stay owned by
// the bridge.
func (s *Service) reconstructTailerMode(inst *agentInstance, tailer *TranscriptTailer) {
	inst.tailerMu.Lock()
	defer inst.tailerMu.Unlock()
	events, err := tailer.Read()
	if err != nil {
		return
	}
	if err := tailer.SaveState(); err != nil {
		return
	}
	for _, event := range events {
		if event.Type != "mode_change" {
			continue
		}
		if inst.compositeObserver != nil {
			inst.compositeObserver.SetModeFromJSONL(event.Mode)
		}
		if inst.runtime != nil {
			inst.runtime.SetModeFromJSONL(event.Mode)
		}
		s.emitModeChange(inst, event.EventID, event.Mode)
	}
}

func (s *Service) handleBridgeDisconnect(agentID string) {
	s.mu.RLock()
	inst, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok || inst == nil {
		return
	}

	inst.mu.Lock()
	inst.meta.Capabilities = []protocol.AgentCapability{
		{Name: "chat", Enabled: true},
		{Name: "prompt", Enabled: false},
		{Name: "abort", Enabled: false},
		{Name: "model", Enabled: false},
		{Name: "thinking", Enabled: false},
	}
	inst.meta.UpdatedAt = time.Now().UTC()
	// The bridge no longer owns semantics once disconnected; hand authority
	// back to the file tailer so transcript polling resumes updating state
	// (see the ownership contract documented at checkTranscript above).
	inst.semanticOwner = semanticOwnerTailer
	inst.mu.Unlock()
	s.recordAgentSummary(inst, "agent.updated")
	s.emitState(inst)
}
func (s *Service) handleBridgeMetadata(agentID string, frame BridgeMetadataFrame) {
	s.mu.RLock()
	inst, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok || inst == nil {
		return
	}

	inst.mu.Lock()
	if frame.Model != nil {
		inst.meta.Model = frame.Model
	}
	if frame.Thinking != "" {
		inst.meta.Thinking = frame.Thinking
	}
	if len(frame.AvailableModels) > 0 {
		inst.meta.AvailableModels = append([]protocol.AgentModelInfo(nil), frame.AvailableModels...)
	}
	if len(frame.AvailableThinking) > 0 {
		inst.meta.AvailableThinking = append([]string(nil), frame.AvailableThinking...)
	}
	if frame.HarnessRuntime != nil {
		inst.meta.HarnessRuntime = cloneHarnessRuntime(frame.HarnessRuntime)
	}
	inst.meta.UpdatedAt = time.Now().UTC()
	inst.mu.Unlock()

	s.recordAgentSummary(inst, "agent.updated")
	s.emitState(inst)
}

func (s *Service) emitBridgeActivity(inst *agentInstance, frame BridgeLifecycleFrame) {
	eventType := map[string]string{
		"turn_start": "activity.turn.started", "tool_start": "activity.tool.started",
		"tool_end": "activity.tool.completed", "approval_requested": "activity.approval.requested",
		"approval_resolved": "activity.approval.resolved",
	}[frame.Event]
	if eventType == "" {
		return
	}
	if frame.Event == "tool_end" && frame.IsError {
		eventType = "activity.tool.failed"
	}
	eventID := frame.EventID
	if eventID == "" {
		eventID = fmt.Sprintf("%s:%s:%d", inst.meta.ID, eventType, time.Now().UnixNano())
	}
	event := protocol.AgentEvent{Type: eventType, EventID: eventID, AgentID: inst.meta.ID, ToolCallID: frame.ToolCallID, ToolName: frame.ToolName, IsError: frame.IsError}
	inst.mu.RLock()
	subscribers := make([]func(protocol.AgentEvent), 0, len(inst.subscribers))
	for _, sub := range inst.subscribers {
		subscribers = append(subscribers, sub.fn)
	}
	inst.mu.RUnlock()
	if s.store != nil {
		payload, err := json.Marshal(event)
		if err != nil {
			return
		}
		committed, err := s.store.RecordAgentTranscript(inst.meta.ID, []runtimestore.AgentTranscriptEvent{{EventID: event.EventID, Kind: event.Type, Payload: payload}}, runtimestore.TranscriptState{})
		if err != nil || len(committed) == 0 {
			return
		}
		event.Cursor = committed[0].Event.Cursor
	}
	for _, subscriber := range subscribers {
		subscriber(event)
	}
}

func (s *Service) emitModeChange(inst *agentInstance, eventID, mode string) {
	if eventID == "" {
		eventID = fmt.Sprintf("%s:mode_change:%d", inst.meta.ID, time.Now().UnixNano())
	}
	event := protocol.AgentEvent{Type: "mode_change", EventID: eventID, AgentID: inst.meta.ID, Mode: mode}
	inst.mu.RLock()
	subscribers := make([]func(protocol.AgentEvent), 0, len(inst.subscribers))
	for _, sub := range inst.subscribers {
		subscribers = append(subscribers, sub.fn)
	}
	inst.mu.RUnlock()
	if s.store != nil {
		payload, err := json.Marshal(event)
		if err != nil {
			return
		}
		committed, err := s.store.RecordAgentTranscript(inst.meta.ID, []runtimestore.AgentTranscriptEvent{{EventID: event.EventID, Kind: event.Type, Payload: payload}}, runtimestore.TranscriptState{})
		if err != nil {
			return
		}
		if len(committed) > 0 {
			event.Cursor = committed[0].Event.Cursor
		}
	}
	for _, subscriber := range subscribers {
		subscriber(event)
	}
}

func (s *Service) handleBridgeLifecycle(agentID string, frame BridgeLifecycleFrame) {
	s.mu.RLock()
	inst, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok || inst == nil {
		return
	}

	inst.mu.RLock()
	curState := inst.meta.State
	ompSessionID := inst.meta.OMPSessionID
	ompSessionFile := inst.meta.OMPSessionFile
	inst.mu.RUnlock()
	if curState == "exited" {
		return
	}

	if frame.Event == "session_changed" ||
		(frame.SessionID != "" && ompSessionID != "" && frame.SessionID != ompSessionID) ||
		(frame.SessionFile != "" && ompSessionFile != "" && frame.SessionFile != ompSessionFile) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.terminateAgentRuntime(ctx, inst, "session identity changed")
		return
	}
	if inst.compositeObserver != nil {
		inst.compositeObserver.ApplyBridgeLifecycle(frame.Event, "")
	}
	if runtime := inst.runtime; runtime != nil {
		switch frame.Event {
		case "agent_start":
			runtime.SetAgentActive(true)
		case "agent_end":
			runtime.SetAgentActive(false)
		case "turn_start":
			runtime.SetTurnActive(true)
		case "turn_end":
			runtime.SetTurnActive(false)
		case "tool_start":
			runtime.SetToolCount(1)
		case "tool_end":
			runtime.SetToolCount(0)
		case "approval_requested":
			runtime.SetApprovalPending(true)
		case "approval_resolved":
			runtime.SetApprovalPending(false)
		case "compaction_start":
			runtime.SetCompacting(true)
		case "compaction_end":
			runtime.SetCompacting(false)
		case "retry_start":
			runtime.SetRetrying(true)
		case "retry_end":
			runtime.SetRetrying(false)
		case "goal_updated":
			runtime.SetGoalActive(frame.GoalActive, frame.GoalTitle, frame.GoalStatus)
		}
	}
	if frame.Event == "goal_updated" {
		if inst.compositeObserver != nil {
			inst.compositeObserver.SetGoalActive(frame.GoalActive)
		}
		mode := string(harness.OmpAgentModeNone)
		if frame.GoalActive {
			mode = string(harness.OmpAgentModeGoal)
		}
		s.emitModeChange(inst, frame.EventID, mode)
		return
	}
	s.emitBridgeActivity(inst, frame)
	targetState := ""
	switch frame.Event {
	case "agent_start", "turn_start", "tool_start", "tool_end":
		targetState = "working"
	case "approval_requested":
		targetState = "needsYou"
	case "approval_resolved":
		targetState = "working"
	case "turn_end", "agent_end":
		targetState = "idle"
	case "session_shutdown":
		targetState = "exited"
	default:
		if frame.State != "" {
			targetState = frame.State
		}
	}

	if targetState == "" {
		return
	}

	if targetState == "exited" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.terminateAgentRuntime(ctx, inst, "bridge session shutdown")
		return
	}

	inst.mu.Lock()
	if inst.meta.State == "exited" {
		inst.mu.Unlock()
		return
	}
	if inst.meta.State == targetState {
		inst.mu.Unlock()
		return
	}
	inst.meta.State = targetState
	inst.meta.UpdatedAt = time.Now().UTC()
	inst.mu.Unlock()

	s.recordAgentSummary(inst, "agent.updated")
	s.emitState(inst)
}
func (s *Service) handleBridgeSemantic(agentID string, frame BridgeSemanticFrame) {
	s.mu.RLock()
	inst, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok || inst == nil {
		return
	}

	inst.mu.RLock()
	curState := inst.meta.State
	semanticOwner := inst.semanticOwner
	inst.mu.RUnlock()
	if curState == "exited" || semanticOwner == semanticOwnerTailer {
		return
	}

	event := protocol.AgentEvent{
		Type:       frame.Event,
		EventID:    frame.EventID,
		AgentID:    agentID,
		MessageID:  frame.MessageID,
		ToolCallID: frame.ToolCallID,
		Text:       frame.Text,
		ToolName:   frame.ToolName,
		IsError:    frame.IsError,
		Aborted:    frame.Aborted,
	}
	if len(frame.ToolInput) > 0 {
		event.ToolInput = json.RawMessage(frame.ToolInput)
	}
	if frame.ToolOutput != nil {
		event.ToolOutput = frame.ToolOutput
	}
	if event.EventID == "" {
		if event.MessageID != "" {
			event.EventID = event.MessageID + ":message"
		} else {
			event.EventID = fmt.Sprintf("%s:%s:%d", agentID, event.Type, time.Now().UnixNano())
		}
	}

	inst.mu.RLock()
	subscribers := make([]func(protocol.AgentEvent), 0, len(inst.subscribers))
	for _, sub := range inst.subscribers {
		subscribers = append(subscribers, sub.fn)
	}
	inst.mu.RUnlock()
	if s.store != nil {
		payload, err := json.Marshal(event)
		if err != nil {
			return
		}
		inputs := []runtimestore.AgentTranscriptEvent{
			{EventID: event.EventID, Kind: event.Type, Payload: payload},
		}
		committed, err := s.store.RecordAgentTranscript(inst.meta.ID, inputs, runtimestore.TranscriptState{})
		if err != nil {
			return
		}
		if len(committed) == 0 {
			// Deduplicated: event already stored
			return
		}
		event.Cursor = committed[0].Event.Cursor
	}
	for _, subscriber := range subscribers {
		subscriber(event)
	}
}

func (s *Service) terminateAgentRuntime(ctx context.Context, inst *agentInstance, reason string) error {
	inst.mu.Lock()
	if inst.meta.State == "exited" {
		inst.mu.Unlock()
		return nil
	}
	termID := inst.meta.TerminalSessionID
	inst.mu.Unlock()

	if err := s.termMgr.Terminate(ctx, termID); err != nil {
		return fmt.Errorf("terminate backend: %w", err)
	}

	if inst.harness != nil {
		inst.harness.Close()
	}

	inst.mu.Lock()
	agentID := inst.meta.ID
	stop := inst.stopTerminal
	inst.stopTerminal = nil
	inst.meta.State = "exited"
	inst.meta.Capabilities = []protocol.AgentCapability{
		{Name: "chat", Enabled: true},
		{Name: "prompt", Enabled: false},
		{Name: "abort", Enabled: false},
		{Name: "model", Enabled: false},
		{Name: "thinking", Enabled: false},
	}
	inst.meta.UpdatedAt = time.Now().UTC()
	stagedAttachments := inst.stagedAttachments
	inst.stagedAttachments = nil
	inst.mu.Unlock()
	if inst.stopPoll != nil {
		inst.stopPollOnce.Do(func() {
			close(inst.stopPoll)
		})
	}
	if stop != nil {
		stop()
	}
	if inst.pollDone != nil {
		<-inst.pollDone
	}
	if s.bridgeServer != nil {
		s.bridgeServer.UnregisterAgent(agentID)
	}
	removeBridgeSecret(s.agentDir, agentID)
	for _, path := range stagedAttachments {
		_ = os.Remove(path)
	}
	s.recordAgentSummary(inst, "agent.updated")
	s.emitState(inst)
	return nil
}

// Terminate explicitly terminates the running agent instance and its underlying terminal.
func (s *Service) Terminate(agentID string) error {
	s.mu.RLock()
	inst, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok {
		return ErrAgentNotFound
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return s.terminateAgentRuntime(ctx, inst, "explicit termination")
}
func (s *Service) restorePersisted() {
	if s.store == nil {
		return
	}
	snap, err := s.store.Snapshot()
	if err != nil {
		return
	}
	for _, a := range snap.Agents {
		resolved := a.CWD
		for _, t := range snap.Terminals {
			if t.ID == a.TerminalSessionID && t.CWD != "" {
				resolved = t.CWD
				break
			}
		}
		compositeObserver := harness.NewCompositeRuntimeObserver()
		compositeObserver.SetMode(harness.OmpModeUnknown, harness.ModeAuthorityUnknown)
		runtime := harness.NewOmpRuntimeState()
		runtime.SetProcessAlive(s.isTerminalRunning(a.TerminalSessionID, snap))
		inst := &agentInstance{
			meta: protocol.AgentSession{
				ID: a.ID, Adapter: a.Adapter, TerminalSessionID: a.TerminalSessionID,
				OMPSessionID: a.OMPSessionID, OMPSessionFile: a.OMPSessionFile,
				CWD: s.toWorkspaceRelative(a.CWD), State: a.State,
				Capabilities: []protocol.AgentCapability{{Name: "chat", Enabled: true}, {Name: "prompt", Enabled: false}, {Name: "abort", Enabled: false}, {Name: "model", Enabled: false}, {Name: "thinking", Enabled: false}},
				CreatedAt:    a.CreatedAt, UpdatedAt: a.UpdatedAt,
			},
			resolvedCWD: resolved, sessionFile: a.OMPSessionFile, agentDir: s.agentDir,
			runtime: runtime, compositeObserver: compositeObserver,
			subscribers: make(map[int]*AgentSubscriber), stopPoll: make(chan struct{}), pollDone: make(chan struct{}), pollInterval: 250 * time.Millisecond, transcriptFallbackAfter: transcriptFallbackDeadline(s.termMgr),
		}
		if a.ID == a.TerminalSessionID {
			newID, err := newAgentID()
			if err != nil || s.store.MigrateAgentID(a.ID, newID) != nil {
				continue
			}
			a.ID = newID
			inst.meta.ID = newID
		}
		if !s.isTerminalRunning(a.TerminalSessionID, snap) {
			if inst.meta.State != "exited" {
				inst.meta.State = "exited"
				inst.meta.UpdatedAt = time.Now().UTC()
			}
			s.recordAgentSummary(inst, "agent.updated")
			s.emitState(inst)
		} else {
			s.recordAgentSummary(inst, "agent.updated")
			s.emitState(inst)
			s.watchTerminal(inst)
		}
		go s.pollTranscript(inst)
		s.agents[a.ID] = inst
		s.byTerminal[a.TerminalSessionID] = a.ID
		if secret, err := loadBridgeSecret(s.agentDir, a.ID); err == nil && s.bridgeServer != nil {
			s.bridgeServer.RegisterAgent(a.ID, secret)
		}
	}
}

func (s *Service) isTerminalRunning(terminalID string, snap *runtimestore.Snapshot) bool {
	if lister, ok := s.termMgr.(terminalLister); ok {
		for _, term := range lister.List(context.Background()) {
			if term.ID == terminalID {
				return term.State == "running"
			}
		}
		return false
	}
	if snap != nil {
		for _, term := range snap.Terminals {
			if term.ID == terminalID {
				return !term.Exited
			}
		}
	}
	return false
}

// CreateAgent starts an OMP-backed terminal runtime with the default backend.
func (s *Service) CreateAgent(ctx context.Context, cwd, name string, args ...string) (*protocol.AgentSession, error) {
	return s.CreateAgentRequest(ctx, protocol.CreateSessionRequest{CWD: cwd, Name: name, Args: args})
}

// CreateAgentRequest preserves the requested terminal backend for an Agent runtime.
func (s *Service) CreateAgentRequest(ctx context.Context, req protocol.CreateSessionRequest) (*protocol.AgentSession, error) {
	cwd, name, args := req.CWD, req.Name, req.Args
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		return nil, errors.New("service closing")
	}
	s.mu.Unlock()

	if err := validateUserArgs(args); err != nil {
		return nil, err
	}

	if name == "" {
		name = "OMP Agent"
	}

	agentID, err := newAgentID()
	if err != nil {
		return nil, err
	}

	secret, err := generateSecret()
	if err != nil {
		return nil, err
	}
	if err := saveBridgeSecret(s.agentDir, agentID, secret); err != nil {
		return nil, fmt.Errorf("persist bridge secret: %w", err)
	}

	bridgePath, err := EnsureBridgeMaterialized(s.agentDir)
	if err != nil {
		return nil, fmt.Errorf("failed to materialize bridge: %w", err)
	}
	sessionDir := filepath.Join(s.agentDir, "sessions", agentID)
	if err := os.MkdirAll(sessionDir, 0o700); err != nil {
		removeBridgeSecret(s.agentDir, agentID)
		return nil, fmt.Errorf("create agent session directory: %w", err)
	}


	if s.bridgeServer != nil {
		s.bridgeServer.RegisterAgent(agentID, secret)
	}

	cmdArgs := append([]string{"--session-dir", sessionDir, "--no-extensions", "-e", bridgePath}, args...)
	var env map[string]string
	if s.bridgeServer != nil {
		env = map[string]string{
			"AGENTIC_REMOTE_BRIDGE_SOCKET":   s.bridgeServer.SocketPath(),
			"AGENTIC_REMOTE_BRIDGE_AGENT_ID": agentID,
			"AGENTIC_REMOTE_BRIDGE_SECRET":   secret,
			"PI_CODING_AGENT_DIR":            s.agentDir,
			"OMP_AGENT_MODELS_FILE":          filepath.Join(s.agentDir, "models.yml"),
		}
	}

	termSummary, err := s.termMgr.Create(ctx, protocol.CreateSessionRequest{
		Name:    name,
		Command: "omp",
		Args:    cmdArgs,
		CWD:     cwd,
		Backend: req.Backend,
		Env:     env,
	})
	if err != nil {
		if s.bridgeServer != nil {
			s.bridgeServer.UnregisterAgent(agentID)
		}
		removeBridgeSecret(s.agentDir, agentID)
		return nil, fmt.Errorf("failed to create agent terminal: %w", err)
	}

	caps := []protocol.AgentCapability{
		{Name: "chat", Enabled: true},
		{Name: "prompt", Enabled: false},
		{Name: "abort", Enabled: false},
		{Name: "model", Enabled: false},
		{Name: "thinking", Enabled: false},
	}
	now := time.Now().UTC()

	relCWD := s.toWorkspaceRelative(termSummary.CWD)
	agentSession := protocol.AgentSession{
		ID:                agentID,
		Adapter:           "omp",
		TerminalSessionID: termSummary.ID,
		CWD:               relCWD,
		State:             "idle",
		Capabilities:      caps,
		CreatedAt:         now,
		UpdatedAt:         now,
	}

	fallbackAfter := transcriptFallbackDeadline(s.termMgr)

	compositeObserver := harness.NewCompositeRuntimeObserver()
	runtime := harness.NewOmpRuntimeState()
	runtime.SetProcessAlive(true)
	inst := &agentInstance{
		meta:        agentSession,
		resolvedCWD: termSummary.CWD,
		agentDir:    s.agentDir,
		harness: harness.NewOMPAdapterWithVersion(harness.OMPVersion1861, harness.DriverFunc(func(_ context.Context, input harness.Input) error {
			return s.termMgr.Input(termSummary.ID, input.Bytes)
		}), runtime),
		runtime: runtime, compositeObserver: compositeObserver,
		subscribers:             make(map[int]*AgentSubscriber),
		stopPoll:                make(chan struct{}),
		pollDone:                make(chan struct{}),
		pollInterval:            200 * time.Millisecond,
		transcriptFallbackAfter: fallbackAfter,
	}
	// Forward composite observer updates into the harness observer chain.
	compositeObserver.AddObserver(harness.ObserverFunc(func(observation harness.Observation) {
		inst.harness.Observe(observation)
	}))
	// Record the most recent raw observation for state inspection (e.g. tests
	// and diagnostics); the harness observer chain is the only place that sees
	// every observation regardless of its originating source.
	inst.harness.AddObserver(harness.ObserverFunc(func(observation harness.Observation) {
		inst.mu.Lock()
		captured := observation
		inst.lastObservation = &captured
		inst.mu.Unlock()
	}))
	inst.harness.Observe(harness.Observation{
		Provenance: harness.Provenance{Source: "tui", Timestamp: time.Now().UTC(), SessionID: agentSession.ID, ProcessID: termSummary.ID},
		Lifecycle:  harness.LifecycleUnknown,
	})

	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		if s.bridgeServer != nil {
			s.bridgeServer.UnregisterAgent(agentID)
		}
		removeBridgeSecret(s.agentDir, agentID)
		_ = s.termMgr.Terminate(context.Background(), termSummary.ID)
		return nil, errors.New("service closing")
	}
	s.agents[agentSession.ID] = inst
	s.byTerminal[termSummary.ID] = agentSession.ID
	s.recordAgentSummary(inst, "agent.created")
	s.watchTerminal(inst)
	go s.pollTranscript(inst)
	s.mu.Unlock()

	return &agentSession, nil
}

func (s *Service) watchTerminal(inst *agentInstance) {
	stop, err := s.termMgr.Subscribe(inst.meta.TerminalSessionID, func(output protocol.PTYOutputEnvelope, st protocol.SessionStateEnvelope) {
		if output.Type != "" && inst.harness != nil {
			data, err := base64.StdEncoding.DecodeString(output.Data)
			if err == nil {
				inst.harness.Observe(harness.Observation{
					Provenance: harness.Provenance{Source: "tui", Timestamp: time.Now().UTC(), SessionID: inst.meta.ID, ProcessID: inst.meta.TerminalSessionID},
					Lifecycle:  harness.LifecycleUnknown,
					Bytes:      data,
				})
			}
		}
		if st.State != "exited" {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.terminateAgentRuntime(ctx, inst, "terminal exited")
	})
	if err == nil {
		inst.mu.Lock()
		inst.stopTerminal = stop
		inst.mu.Unlock()
	}
}

func (s *Service) recordAgentSummary(inst *agentInstance, kind string) {
	if s.store == nil {
		return
	}
	inst.mu.RLock()
	meta := inst.meta
	inst.mu.RUnlock()
	capsBytes, _ := json.Marshal(meta.Capabilities)
	_ = s.store.RecordAgent(runtimestore.AgentSummary{
		ID:                meta.ID,
		Adapter:           meta.Adapter,
		TerminalSessionID: meta.TerminalSessionID,
		OMPSessionID:      meta.OMPSessionID,
		OMPSessionFile:    meta.OMPSessionFile,
		CWD:               meta.CWD,
		State:             meta.State,
		Capabilities:      capsBytes,
		CreatedAt:         meta.CreatedAt,
		UpdatedAt:         meta.UpdatedAt,
	}, kind)
}

func (s *Service) emitState(inst *agentInstance) {
	inst.mu.RLock()
	var model *protocol.AgentModelInfo
	if inst.meta.Model != nil {
		m := *inst.meta.Model
		model = &m
	}
	event := protocol.AgentEvent{
		Type:              "state",
		EventID:           fmt.Sprintf("%s:state:%s", inst.meta.ID, inst.meta.UpdatedAt.UTC().Format(time.RFC3339Nano)),
		AgentID:           inst.meta.ID,
		State:             inst.meta.State,
		Capabilities:      append([]protocol.AgentCapability(nil), inst.meta.Capabilities...),
		Model:             model,
		Thinking:          inst.meta.Thinking,
		AvailableModels:   append([]protocol.AgentModelInfo(nil), inst.meta.AvailableModels...),
		AvailableThinking: append([]string(nil), inst.meta.AvailableThinking...),
		HarnessRuntime:    cloneHarnessRuntime(inst.meta.HarnessRuntime),
	}
	subscribers := make([]func(protocol.AgentEvent), 0, len(inst.subscribers))
	for _, sub := range inst.subscribers {
		subscribers = append(subscribers, sub.fn)
	}
	inst.mu.RUnlock()
	if s.store != nil {
		if cursor, err := s.store.RecordEvent(inst.meta.ID, event.Type, event); err == nil {
			event.Cursor = cursor
		}
	}
	for _, subscriber := range subscribers {
		subscriber(event)
	}
}

func (s *Service) pollTranscript(inst *agentInstance) {
	if inst.pollDone != nil {
		defer close(inst.pollDone)
	}
	if !inst.transcriptFallbackAfter.IsZero() {
		delay := time.Until(inst.transcriptFallbackAfter)
		if delay > 0 {
			timer := time.NewTimer(delay)
			defer timer.Stop()
			select {
			case <-inst.stopPoll:
				return
			case <-timer.C:
			}
		}
	}
	ticker := time.NewTicker(inst.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-inst.stopPoll:
			return
		case <-ticker.C:
			s.checkTranscript(inst)
		}
	}
}

func (s *Service) checkTranscript(inst *agentInstance) {
	// The bridge owns semantics when it connected before the fallback grace
	// period. Otherwise the file tailer owns them for the lifetime of this
	// agent, including after a bridge reconnect, so one OMP turn cannot be
	// persisted under two unrelated event-ID schemes.
	s.mu.RLock()
	bridge := s.bridgeServer
	s.mu.RUnlock()
	bridgeConnected := bridge != nil && bridge.IsConnected(inst.meta.ID)
	inst.mu.Lock()
	if inst.semanticOwner == semanticOwnerBridge || (inst.semanticOwner == "" && bridgeConnected) {
		inst.semanticOwner = semanticOwnerBridge
		tailer := inst.tailer
		inst.mu.Unlock()
		// Bridge semantic events remain authoritative for messages and activity,
		// while OMP mode changes are only source-backed by the session JSONL.
		// Continue advancing that same bound stream without promoting its other
		// entries into a competing semantic owner.
		if tailer != nil {
			s.reconstructTailerMode(inst, tailer)
		}
		return
	}
	if inst.semanticOwner == "" {
		inst.semanticOwner = semanticOwnerTailer
	}
	inst.mu.Unlock()

	inst.tailerMu.Lock()
	defer inst.tailerMu.Unlock()
	inst.mu.Lock()
	if inst.tailer == nil {
		if inst.sessionFile == "" {
			if provider, ok := s.termMgr.(terminalTTYProvider); ok {
				_, sessionFile, _, err := ReadTerminalBreadcrumb(inst.agentDir, TerminalIDFromTTY(provider.TerminalTTY(inst.meta.TerminalSessionID)))
				if err == nil && sessionFile != "" {
					inst.sessionFile = sessionFile
				}
			}
			if inst.sessionFile == "" {
				targetCWD := inst.resolvedCWD
				if targetCWD == "" {
					targetCWD = inst.meta.CWD
				}
				sessionsDir := ComputeDefaultSessionDir(inst.agentDir, targetCWD)
				if latest, err := FindOnlySessionFile(sessionsDir); err == nil {
					inst.sessionFile = latest
				}
			}
		}
		if inst.sessionFile != "" {
			inst.tailer = NewTranscriptTailer(inst.meta.ID, inst.sessionFile, s.store)
			_ = inst.tailer.RestoreState()
		}
	}
	tailer := inst.tailer
	inst.mu.Unlock()
	if tailer == nil {
		return
	}

	before := tailer.snapshot()
	events, err := tailer.Read()
	if err != nil || len(events) == 0 {
		return
	}

	inst.mu.Lock()
	stateChanged := false
	modeChanges := make([]string, 0, len(events))
	for _, event := range events {
		switch event.Type {
		case "message.user", "tool.call":
			if inst.meta.State != "working" && inst.meta.State != "exited" {
				inst.meta.State = "working"
				stateChanged = true
			}
		case "message.assistant":
			if inst.meta.State != "idle" && inst.meta.State != "exited" {
				inst.meta.State = "idle"
				stateChanged = true
			}
		case "state":
			if event.State != "" && event.State != inst.meta.State {
				inst.meta.State = event.State
				stateChanged = true
			}
		case "mode_change":
			modeChanges = append(modeChanges, event.Mode)
		}
	}
	if stateChanged {
		inst.meta.UpdatedAt = time.Now().UTC()
	}
	subscribers := make([]func(protocol.AgentEvent), 0, len(inst.subscribers))
	for _, sub := range inst.subscribers {
		subscribers = append(subscribers, sub.fn)
	}
	compositeObserver := inst.compositeObserver
	runtimeState := inst.runtime
	inst.mu.Unlock()

	// Observer notification synchronously re-enters inst.harness.Observe, which
	// locks inst.mu from its own observer chain (adapter.go AddObserver closure
	// above); it must run after inst.mu is released or it deadlocks the poller.
	for _, mode := range modeChanges {
		if compositeObserver != nil {
			compositeObserver.SetModeFromJSONL(mode)
		}
		if runtimeState != nil {
			runtimeState.SetModeFromJSONL(mode)
		}
	}

	if s.store != nil {
		inputs := make([]runtimestore.AgentTranscriptEvent, 0, len(events))
		for _, event := range events {
			payload, err := json.Marshal(event)
			if err != nil {
				tailer.restore(before)
				return
			}
			inputs = append(inputs, runtimestore.AgentTranscriptEvent{EventID: event.EventID, Kind: event.Type, Payload: payload})
		}
		committed, err := s.store.RecordAgentTranscript(inst.meta.ID, inputs, tailer.checkpoint())
		if err != nil {
			tailer.restore(before)
			return
		}
		cursors := make(map[string]int64, len(committed))
		for _, stored := range committed {
			cursors[stored.EventID] = stored.Event.Cursor
		}
		published := events[:0]
		for _, event := range events {
			if cursor, ok := cursors[event.EventID]; ok {
				event.Cursor = cursor
				published = append(published, event)
			}
		}
		events = published
	} else if err := tailer.SaveState(); err != nil {
		tailer.restore(before)
		return
	}
	for _, event := range events {
		for _, fn := range subscribers {
			fn(event)
		}
	}

	if stateChanged {
		s.recordAgentSummary(inst, "agent.updated")
		s.emitState(inst)
	}
}

// RouteTUIInput writes bytes to the agent's sole OMP process through its capability router.
func (s *Service) RouteTUIInput(ctx context.Context, agentID string, input []byte) error {
	s.mu.RLock()
	inst, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok {
		return ErrAgentNotFound
	}
	inst.mu.RLock()
	adapter := inst.harness
	exited := inst.meta.State == "exited"
	inst.mu.RUnlock()
	if exited || adapter == nil {
		return ErrAgentExited
	}
	return adapter.Router.Route(ctx, harness.Input{
		Capability: harness.CapabilityTUIInput,
		Action:     harness.ActionTUIInput,
		Source:     harness.SourceTerminalUser,
		Bytes:      input,
	})
}

// RouteOMPGoalShow sends the source-backed OMP /goal show control through the
// same serialized terminal path as user input.
func (s *Service) RouteOMPGoalShow(ctx context.Context, agentID string) error {
	return s.routeOMPControl(ctx, agentID, harness.CapabilityOMPGoal, harness.ActionOMPGoalShow, []byte("/goal show\r"))
}

// RouteOMPPlanToggle sends the source-backed OMP /plan control through the
// same serialized terminal path as user input.
func (s *Service) RouteOMPPlanToggle(ctx context.Context, agentID string) error {
	return s.routeOMPControl(ctx, agentID, harness.CapabilityOMPPlan, harness.ActionOMPPlanToggle, []byte("/plan\r"))
}

func (s *Service) routeOMPControl(ctx context.Context, agentID string, capability harness.HarnessCapability, action harness.HarnessAction, bytes []byte) error {
	s.mu.RLock()
	inst, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok {
		return ErrAgentNotFound
	}
	inst.mu.RLock()
	adapter := inst.harness
	exited := inst.meta.State == "exited"
	inst.mu.RUnlock()
	if exited || adapter == nil {
		return ErrAgentExited
	}
	return adapter.RouteControl(ctx, harness.Input{
		Capability: capability,
		Action:     action,
		Source:     harness.SourceModeControl,
		Bytes:      bytes,
	})
}

// SubmitPrompt sends a text-only user prompt through the verified OMP bridge.
func (s *Service) SubmitPrompt(agentID, prompt string) error {
	return s.submitPrompt(agentID, prompt, nil)
}

// SubmitPromptWithImages sends text plus workspace-relative images as OMP structured content.
func (s *Service) SubmitPromptWithImages(agentID, prompt string, images []protocol.AgentPromptImage) error {
	return s.submitPrompt(agentID, prompt, images)
}

func (s *Service) submitPrompt(agentID, prompt string, images []protocol.AgentPromptImage) error {
	return s.submitPromptFrom(agentID, prompt, images, "")
}

func (s *Service) submitPromptFrom(agentID, prompt string, images []protocol.AgentPromptImage, imageBaseDir string) error {
	s.mu.RLock()
	inst, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok {
		return ErrAgentNotFound
	}
	if imageBaseDir == "" {
		imageBaseDir = inst.resolvedCWD
	}
	encodedImages, err := loadPromptImages(imageBaseDir, images)
	if err != nil {
		return err
	}

	waitCtx, waitCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer waitCancel()

	// OMP treats a prompt sent while a turn is already running as steering
	// folded into that turn rather than a fresh one, so a submission that
	// arrives mid-turn must wait for the agent to go idle - and atomically
	// claim "working" the instant it does - before it is forwarded; this
	// keeps concurrent submissions serialized into distinct turns instead
	// of racing OMP into merging them.
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		inst.mu.Lock()
		promptEnabled := false
		for _, c := range inst.meta.Capabilities {
			if c.Name == "prompt" && c.Enabled {
				promptEnabled = true
				break
			}
		}
		if !promptEnabled || s.bridgeServer == nil || !s.bridgeServer.IsConnected(agentID) {
			inst.mu.Unlock()
			return errors.New("needs_terminal")
		}
		if inst.meta.State != "working" {
			inst.meta.State = "working"
			inst.meta.UpdatedAt = time.Now().UTC()
			inst.mu.Unlock()
			s.recordAgentSummary(inst, "agent.updated")
			s.emitState(inst)
			break
		}
		inst.mu.Unlock()
		select {
		case <-waitCtx.Done():
			return errors.New("agent_busy")
		case <-ticker.C:
		}
	}

	sendCtx, sendCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer sendCancel()
	if err := s.bridgeServer.SendCommand(sendCtx, agentID, "prompt", map[string]any{"prompt": prompt, "images": encodedImages}); err != nil {
		// Sending failed after the state was already claimed; revert so a
		// failed submission does not strand the agent as falsely working.
		inst.mu.Lock()
		if inst.meta.State == "working" {
			inst.meta.State = "idle"
			inst.meta.UpdatedAt = time.Now().UTC()
		}
		inst.mu.Unlock()
		s.recordAgentSummary(inst, "agent.updated")
		s.emitState(inst)
		return err
	}
	return nil
}

// Abort aborts the active operation through the verified OMP bridge.
func (s *Service) Abort(agentID string) error {
	s.mu.RLock()
	inst, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok {
		return ErrAgentNotFound
	}
	inst.mu.RLock()
	abortEnabled := false
	for _, c := range inst.meta.Capabilities {
		if c.Name == "abort" && c.Enabled {
			abortEnabled = true
			break
		}
	}
	inst.mu.RUnlock()
	if !abortEnabled || s.bridgeServer == nil || !s.bridgeServer.IsConnected(agentID) {
		return errors.New("needs_terminal")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return s.bridgeServer.SendCommand(ctx, agentID, "abort", nil)
}

func (s *Service) SetModel(agentID, model string) error {
	s.mu.RLock()
	inst, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok {
		return ErrAgentNotFound
	}
	inst.mu.RLock()
	modelEnabled := false
	for _, c := range inst.meta.Capabilities {
		if c.Name == "model" && c.Enabled {
			modelEnabled = true
			break
		}
	}
	inst.mu.RUnlock()
	if !modelEnabled || s.bridgeServer == nil || !s.bridgeServer.IsConnected(agentID) {
		return errors.New("needs_terminal")
	}
	// Model switching can involve external provider proxy discovery (e.g. omniroute/omninext)
	// taking ~8-9s on cold initialize; use 30s timeout to provide safe headroom.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := s.bridgeServer.SendCommand(ctx, agentID, "model", map[string]any{"model": model}); err != nil {
		return err
	}
	inst.mu.Lock()
	var updatedModel *protocol.AgentModelInfo
	for _, m := range inst.meta.AvailableModels {
		if m.ID == model || fmt.Sprintf("%s/%s", m.Provider, m.ID) == model || m.Name == model {
			updatedModel = &protocol.AgentModelInfo{
				ID:       m.ID,
				Name:     m.Name,
				Provider: m.Provider,
			}
			break
		}
	}
	if updatedModel == nil {
		updatedModel = &protocol.AgentModelInfo{
			ID:   model,
			Name: model,
		}
	}
	inst.meta.Model = updatedModel
	inst.meta.UpdatedAt = time.Now().UTC()
	inst.mu.Unlock()
	s.recordAgentSummary(inst, "agent.updated")
	s.emitState(inst)
	return nil
}

// SetThinking changes the thinking level through the verified OMP bridge.
func (s *Service) SetThinking(agentID, level string) error {
	s.mu.RLock()
	inst, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok {
		return ErrAgentNotFound
	}
	inst.mu.RLock()
	thinkingEnabled := false
	for _, c := range inst.meta.Capabilities {
		if c.Name == "thinking" && c.Enabled {
			thinkingEnabled = true
			break
		}
	}
	inst.mu.RUnlock()
	if !thinkingEnabled || s.bridgeServer == nil || !s.bridgeServer.IsConnected(agentID) {
		return errors.New("needs_terminal")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.bridgeServer.SendCommand(ctx, agentID, "thinking", map[string]any{"level": level}); err != nil {
		return err
	}
	inst.mu.Lock()
	inst.meta.Thinking = level
	inst.meta.UpdatedAt = time.Now().UTC()
	inst.mu.Unlock()
	s.recordAgentSummary(inst, "agent.updated")
	return nil
}

// GetAgent retrieves agent session summary.
func (s *Service) GetAgent(agentID string) (*protocol.AgentSession, error) {
	s.mu.RLock()
	inst, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok {
		return nil, ErrAgentNotFound
	}
	inst.mu.RLock()
	defer inst.mu.RUnlock()
	meta := inst.meta
	meta.HarnessRuntime = cloneHarnessRuntime(inst.meta.HarnessRuntime)
	return &meta, nil
}

// ListAgents returns all known agent sessions.
func (s *Service) ListAgents() []protocol.AgentSession {
	s.mu.RLock()
	defer s.mu.RUnlock()
	list := make([]protocol.AgentSession, 0, len(s.agents))
	for _, inst := range s.agents {
		inst.mu.RLock()
		meta := inst.meta
		meta.HarnessRuntime = cloneHarnessRuntime(inst.meta.HarnessRuntime)
		list = append(list, meta)
		inst.mu.RUnlock()
	}
	return list
}

// Subscribe listens to live agent events.
func (s *Service) Subscribe(agentID string, fn func(protocol.AgentEvent)) (func(), error) {
	s.mu.RLock()
	inst, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok {
		return nil, ErrAgentNotFound
	}
	inst.mu.Lock()
	subID := inst.nextSubID
	inst.nextSubID++
	inst.subscribers[subID] = &AgentSubscriber{fn: fn}
	inst.mu.Unlock()

	return func() {
		inst.mu.Lock()
		delete(inst.subscribers, subID)
		inst.mu.Unlock()
	}, nil
}

// History returns ordered durable semantic events and runtime high-water cursor for an agent.
func (s *Service) History(agentID string) (*protocol.AgentHistoryResponse, error) {
	s.mu.RLock()
	_, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok {
		return nil, ErrAgentNotFound
	}
	if s.store == nil {
		return &protocol.AgentHistoryResponse{
			Cursor: 0,
			Events: []protocol.AgentEvent{},
		}, nil
	}
	entries, cursor, err := s.store.AgentHistory(agentID)
	if err != nil {
		return nil, err
	}
	events := make([]protocol.AgentEvent, 0, len(entries))
	for _, entry := range entries {
		var event protocol.AgentEvent
		if err := json.Unmarshal(entry.Payload, &event); err != nil {
			event = protocol.AgentEvent{
				Type:    entry.Kind,
				EventID: entry.EventID,
				AgentID: entry.AgentID,
			}
		}
		if event.EventID == "" {
			event.EventID = entry.EventID
		}
		if event.AgentID == "" {
			event.AgentID = entry.AgentID
		}
		if event.Type == "" {
			event.Type = entry.Kind
		}
		events = append(events, event)
	}
	return &protocol.AgentHistoryResponse{
		Cursor: cursor,
		Events: events,
	}, nil
}

// Close shuts down all background polling workers and the bridge server.
func (s *Service) Close() error {
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		return nil
	}
	s.closing = true
	instances := make([]*agentInstance, 0, len(s.agents))
	for _, inst := range s.agents {
		instances = append(instances, inst)
	}
	s.agents = make(map[string]*agentInstance)
	s.byTerminal = make(map[string]string)
	bs := s.bridgeServer
	s.bridgeServer = nil
	s.mu.Unlock()

	for _, inst := range instances {
		if inst.stopPoll != nil {
			inst.stopPollOnce.Do(func() {
				close(inst.stopPoll)
			})
		}
		inst.mu.Lock()
		stop := inst.stopTerminal
		inst.stopTerminal = nil
		stagedAttachments := inst.stagedAttachments
		inst.stagedAttachments = nil
		inst.mu.Unlock()
		if stop != nil {
			stop()
		}
		if inst.pollDone != nil {
			<-inst.pollDone
		}
		for _, path := range stagedAttachments {
			_ = os.Remove(path)
		}
	}

	if bs != nil {
		_ = bs.Close()
	}

	return nil
}
