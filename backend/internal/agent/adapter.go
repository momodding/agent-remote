package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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
	mu         sync.RWMutex
	termMgr    TerminalManager
	store      *runtimestore.Store
	agentDir   string
	agents     map[string]*agentInstance
	byTerminal map[string]string // terminalID -> agentID
	closing    bool
}

func NewService(termMgr TerminalManager, store *runtimestore.Store, agentDir string) *Service {
	if agentDir == "" {
		agentDir = DefaultAgentDir()
	}
	s := &Service{
		termMgr:    termMgr,
		store:      store,
		agentDir:   agentDir,
		agents:     make(map[string]*agentInstance),
		byTerminal: make(map[string]string),
	}
	s.restorePersisted()
	return s
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
				CWD:               a.CWD,
				State:             a.State,
				Capabilities:      caps,
				CreatedAt:         a.CreatedAt,
				UpdatedAt:         a.UpdatedAt,
			},
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
		s.watchTerminal(inst)
		go s.pollTranscript(inst)

		s.agents[a.ID] = inst
		s.byTerminal[a.TerminalSessionID] = a.ID
	}
}

// CreateAgent starts an OMP-backed terminal runtime and returns an AgentSession.
func (s *Service) CreateAgent(ctx context.Context, cwd, name string, args ...string) (*protocol.AgentSession, error) {
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		return nil, errors.New("service closing")
	}
	s.mu.Unlock()

	if name == "" {
		name = "OMP Agent"
	}
	termSummary, err := s.termMgr.Create(ctx, protocol.CreateSessionRequest{
		Name:    name,
		Command: "omp",
		Args:    args,
		CWD:     cwd,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create agent terminal: %w", err)
	}

	caps := []protocol.AgentCapability{
		{Name: "chat", Enabled: true},
		{Name: "prompt", Enabled: false},
		{Name: "abort", Enabled: false},
	}
	now := time.Now().UTC()
	agentID, err := newAgentID()
	if err != nil {
		_ = s.termMgr.Close(termSummary.ID)
		return nil, err
	}
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
	inst := &agentInstance{meta: agentSession, agentDir: s.agentDir, subscribers: make(map[int]*AgentSubscriber), stopPoll: make(chan struct{}), pollInterval: 200 * time.Millisecond}
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
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
		inst.meta.UpdatedAt = time.Now().UTC()
		inst.mu.Unlock()
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
		CWD:               meta.CWD,
		State:             meta.State,
		Capabilities:      capsBytes,
		CreatedAt:         meta.CreatedAt,
		UpdatedAt:         meta.UpdatedAt,
	}, kind)
}

func (s *Service) emitState(inst *agentInstance) {
	inst.mu.RLock()
	event := protocol.AgentEvent{Type: "state", EventID: fmt.Sprintf("%s:state:%s", inst.meta.ID, inst.meta.UpdatedAt.UTC().Format(time.RFC3339Nano)), AgentID: inst.meta.ID, State: inst.meta.State}
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
			inst.tailer = NewTranscriptTailer(inst.meta.ID, inst.sessionFile)
		}
	}
	tailer := inst.tailer
	inst.mu.Unlock()
	if tailer == nil {
		return
	}
	events, err := tailer.Read()
	if err != nil || len(events) == 0 {
		return
	}

	inst.mu.Lock()
	var stateChanged bool
	for _, ev := range events {
		switch ev.Type {
		case "message.user", "tool.call":
			if inst.meta.State != "running" && inst.meta.State != "exited" {
				inst.meta.State = "running"
				stateChanged = true
			}
		case "message.assistant":
			if inst.meta.State != "idle" && inst.meta.State != "exited" {
				inst.meta.State = "idle"
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

	for i := range events {
		if s.store != nil {
			cursor, err := s.store.RecordEvent(inst.meta.ID, events[i].Type, events[i])
			if err == nil {
				events[i].Cursor = cursor
			}
		}
		for _, fn := range subscribers {
			fn(events[i])
		}
	}

	if stateChanged {
		s.recordAgentSummary(inst, "agent.updated")
		s.emitState(inst)
	}
}

// SubmitPrompt writes bracketed paste to the underlying terminal session.
func (s *Service) SubmitPrompt(agentID, prompt string) error {
	s.mu.RLock()
	_, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok {
		return ErrAgentNotFound
	}
	// Transcript tailing is read-only; prompt commands require a verified OMP bridge.
	return errors.New("needs_terminal")
}

// Abort is unavailable until a verified OMP command bridge is installed.
func (s *Service) Abort(agentID string) error {
	s.mu.RLock()
	_, ok := s.agents[agentID]
	s.mu.RUnlock()
	if !ok {
		return ErrAgentNotFound
	}
	return errors.New("needs_terminal")
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

// Close shuts down all background polling workers.
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
	s.mu.Unlock()

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
	return nil
}
