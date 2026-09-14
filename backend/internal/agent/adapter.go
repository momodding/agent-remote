package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/protocol"
	runtimestore "github.com/agenticremote/agenticremote/backend/internal/runtime"
)

var (
	ErrAgentNotFound = errors.New("agent not found")
	ErrAgentExited   = errors.New("agent has exited")
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

type agentInstance struct {
	mu           sync.RWMutex
	meta         protocol.AgentSession
	tailer       *TranscriptTailer
	sessionFile  string
	agentDir     string
	termID       string
	subscribers  map[int]*AgentSubscriber
	nextSubID    int
	stopPoll     chan struct{}
	stopTerminal func()
	pollInterval time.Duration
}

type Service struct {
	mu           sync.RWMutex
	termMgr      TerminalManager
	store        *runtimestore.Store
	agentDir     string
	agents       map[string]*agentInstance
	byTerminal   map[string]string // terminalID -> agentID
	bridgeServer *BridgeServer
	closing      bool
}

func NewService(termMgr TerminalManager, store *runtimestore.Store, agentDir string) *Service {
	if agentDir == "" {
		agentDir = DefaultAgentDir()
	}
	_ = os.MkdirAll(agentDir, 0o700)

	s := &Service{
		termMgr:    termMgr,
		store:      store,
		agentDir:   agentDir,
		agents:     make(map[string]*agentInstance),
		byTerminal: make(map[string]string),
	}

	socketPath := filepath.Join(agentDir, "bridge.sock")
	if bs, err := NewBridgeServer(socketPath, s.handleBridgeHello, s.handleBridgeDisconnect); err == nil {
		s.bridgeServer = bs
	}

	s.restorePersisted()
	return s
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
		return false
	}
	inst.meta.OMPSessionID = hello.SessionID
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
	inst.meta.UpdatedAt = time.Now().UTC()
	if inst.tailer == nil || inst.tailer.path != hello.SessionFile {
		inst.tailer = NewTranscriptTailer(inst.meta.ID, hello.SessionFile, s.store)
		_ = inst.tailer.RestoreState()
	}
	inst.mu.Unlock()

	s.recordAgentSummary(inst, "agent.updated")
	s.emitState(inst)
	return true
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
	inst.mu.Unlock()

	s.recordAgentSummary(inst, "agent.updated")
	s.emitState(inst)
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
		var caps []protocol.AgentCapability
		_ = json.Unmarshal(a.Capabilities, &caps)
		inst := &agentInstance{
			meta: protocol.AgentSession{
				ID:                a.ID,
				Adapter:           a.Adapter,
				TerminalSessionID: a.TerminalSessionID,
				OMPSessionID:      a.OMPSessionID,
				OMPSessionFile:    a.OMPSessionFile,
				CWD:               a.CWD,
				State:             a.State,
				Capabilities:      caps,
				CreatedAt:         a.CreatedAt,
				UpdatedAt:         a.UpdatedAt,
			},
			sessionFile:  a.OMPSessionFile,
			agentDir:     s.agentDir,
			subscribers:  make(map[int]*AgentSubscriber),
			stopPoll:     make(chan struct{}),
			pollInterval: 250 * time.Millisecond,
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
				s.recordAgentSummary(inst, "agent.updated")
				s.emitState(inst)
			}
		} else {
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

	if s.bridgeServer != nil {
		s.bridgeServer.RegisterAgent(agentID, secret)
	}

	cmdArgs := append([]string{"--no-extensions", "-e", bridgePath}, args...)
	var env map[string]string
	if s.bridgeServer != nil {
		env = map[string]string{
			"AGENTIC_REMOTE_BRIDGE_SOCKET":   s.bridgeServer.SocketPath(),
			"AGENTIC_REMOTE_BRIDGE_AGENT_ID": agentID,
			"AGENTIC_REMOTE_BRIDGE_SECRET":   secret,
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

	agentSession := protocol.AgentSession{
		ID:                agentID,
		Adapter:           "omp",
		TerminalSessionID: termSummary.ID,
		CWD:               termSummary.CWD,
		State:             "idle",
		Capabilities:      caps,
		CreatedAt:         now,
		UpdatedAt:         now,
	}

	inst := &agentInstance{
		meta:         agentSession,
		agentDir:     s.agentDir,
		subscribers:  make(map[int]*AgentSubscriber),
		stopPoll:     make(chan struct{}),
		pollInterval: 200 * time.Millisecond,
	}

	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		if s.bridgeServer != nil {
			s.bridgeServer.UnregisterAgent(agentID)
		}
		removeBridgeSecret(s.agentDir, agentID)
		_ = s.termMgr.Close(termSummary.ID)
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
	stop, err := s.termMgr.Subscribe(inst.meta.TerminalSessionID, func(_ protocol.PTYOutputEnvelope, st protocol.SessionStateEnvelope) {
		if st.State != "exited" {
			return
		}
		inst.mu.Lock()
		inst.meta.State = "exited"
		inst.meta.Capabilities = []protocol.AgentCapability{
			{Name: "chat", Enabled: true},
			{Name: "prompt", Enabled: false},
			{Name: "abort", Enabled: false},
			{Name: "model", Enabled: false},
			{Name: "thinking", Enabled: false},
		}
		inst.meta.UpdatedAt = time.Now().UTC()
		inst.mu.Unlock()
		if s.bridgeServer != nil {
			s.bridgeServer.UnregisterAgent(inst.meta.ID)
		}
		s.recordAgentSummary(inst, "agent.updated")
		s.emitState(inst)
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
	event := protocol.AgentEvent{
		Type:         "state",
		EventID:      fmt.Sprintf("%s:state:%s", inst.meta.ID, inst.meta.UpdatedAt.UTC().Format(time.RFC3339Nano)),
		AgentID:      inst.meta.ID,
		State:        inst.meta.State,
		Capabilities: append([]protocol.AgentCapability(nil), inst.meta.Capabilities...),
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
				sessionsDir := ComputeDefaultSessionDir(inst.agentDir, inst.meta.CWD)
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
		}
	}
	if stateChanged {
		inst.meta.UpdatedAt = time.Now().UTC()
	}
	subscribers := make([]func(protocol.AgentEvent), 0, len(inst.subscribers))
	for _, sub := range inst.subscribers {
		subscribers = append(subscribers, sub.fn)
	}
	inst.mu.Unlock()

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

// SubmitPrompt sends a user prompt through the verified OMP bridge.
func (s *Service) SubmitPrompt(agentID, prompt string) error {
	s.mu.RLock()
	inst, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok {
		return ErrAgentNotFound
	}
	inst.mu.RLock()
	promptEnabled := false
	for _, c := range inst.meta.Capabilities {
		if c.Name == "prompt" && c.Enabled {
			promptEnabled = true
			break
		}
	}
	inst.mu.RUnlock()
	if !promptEnabled || s.bridgeServer == nil || !s.bridgeServer.IsConnected(agentID) {
		return errors.New("needs_terminal")
	}
	return s.bridgeServer.SendCommand(context.Background(), agentID, "prompt", map[string]any{"prompt": prompt})
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
	return s.bridgeServer.SendCommand(context.Background(), agentID, "abort", nil)
}

// SetModel changes the active model through the verified OMP bridge.
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
	return s.bridgeServer.SendCommand(context.Background(), agentID, "model", map[string]any{"model": model})
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
	return s.bridgeServer.SendCommand(context.Background(), agentID, "thinking", map[string]any{"level": level})
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
	return &meta, nil
}

// ListAgents returns all known agent sessions.
func (s *Service) ListAgents() []protocol.AgentSession {
	s.mu.RLock()
	defer s.mu.RUnlock()
	list := make([]protocol.AgentSession, 0, len(s.agents))
	for _, inst := range s.agents {
		inst.mu.RLock()
		list = append(list, inst.meta)
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

	if bs != nil {
		_ = bs.Close()
	}

	for _, inst := range instances {
		close(inst.stopPoll)
		inst.mu.Lock()
		stop := inst.stopTerminal
		inst.stopTerminal = nil
		inst.mu.Unlock()
		if stop != nil {
			stop()
		}
	}
	time.Sleep(30 * time.Millisecond)
	return nil
}
