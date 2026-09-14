package session

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/detect"
	"github.com/agenticremote/agenticremote/backend/internal/notify"
	"github.com/agenticremote/agenticremote/backend/internal/protocol"
	runtimestore "github.com/agenticremote/agenticremote/backend/internal/runtime"
	"github.com/agenticremote/agenticremote/backend/internal/tmux"
)

type State string

const (
	StateRunning State = "running"
	StateExited  State = "exited"
	StateWaiting State = "waiting"
	StateIdle    State = "idle"
)

type Session struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Command   string            `json:"command"`
	CWD       string            `json:"cwd"`
	State     State             `json:"state"`
	CreatedAt time.Time         `json:"createdAt"`
	UpdatedAt time.Time         `json:"updatedAt"`
	WaitState *detect.WaitState `json:"waitState,omitempty"`
	Preview   []string          `json:"preview,omitempty"`
}

type CreateRequest struct {
	Name    string
	Command string
	Args    []string
	CWD     string
	Cols    int
	Rows    int
	Backend string
}

type subscriber struct {
	mu        sync.Mutex
	fn        func(protocol.PTYOutputEnvelope, protocol.SessionStateEnvelope)
	active    bool
	replaySeq int64
}

type TerminalRuntime struct {
	meta         Session
	detector     detect.Detector
	subs         []*subscriber
	seq          int64
	scrollback   string
	scrollbackMu sync.Mutex
	plain        string
	outbound     chan outboundMessage
	backend      TerminalBackend
	exitOnce     sync.Once
	enqueueMu    sync.Mutex
}

type outboundMessage struct {
	output  *protocol.PTYOutputEnvelope
	state   *protocol.SessionStateEnvelope
	control bool
}
type Manager struct {
	mu                 sync.Mutex
	sessions           map[string]*TerminalRuntime
	stateDir           string
	workspaceRoot      string
	defaultCWD         string
	maxScrollbackBytes int64
	channelBufferSize  int
	notifier           notify.Notifier
	runtime            *runtimestore.Store
	outputWorkers      sync.WaitGroup
	forwardWorkers     sync.WaitGroup
	shutdownOnce       sync.Once
	shutdownErr        error
	closing            bool
	tmuxClient         *tmux.ControlClient // nil if tmux unavailable
	useTmux            bool                // true to route Create through tmux panes
	recordTopology     func() error
}

func (m *Manager) RuntimeStore() *runtimestore.Store {
	return m.runtime
}

// TmuxAvailable reports whether this manager currently routes "auto"
// terminal/Agent creation through a live private tmux control client.
func (m *Manager) TmuxAvailable() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.useTmux && m.tmuxClient != nil
}

func NewManager(defaultCWD, stateDir, workspaceRoot string, maxScrollbackBytes int64, channelBufferSize int, notifier notify.Notifier) (*Manager, error) {
	if err := os.MkdirAll(filepath.Join(stateDir, "sessions"), 0o755); err != nil {
		return nil, err
	}
	store, err := runtimestore.Open(stateDir)
	if err != nil {
		return nil, err
	}
	m := &Manager{sessions: map[string]*TerminalRuntime{}, defaultCWD: defaultCWD, stateDir: stateDir, workspaceRoot: workspaceRoot, maxScrollbackBytes: maxScrollbackBytes, channelBufferSize: channelBufferSize, notifier: notifier, runtime: store}
	m.recordTopology = m.recordTmuxTopology
	if err := m.restore(); err != nil {
		_ = store.Close()
		return nil, err
	}
	return m, nil
}
func commandWithEnv(command string, args []string, env map[string]string) (string, []string) {
	if len(env) == 0 {
		return command, args
	}
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	prefixed := make([]string, 0, len(keys)+len(args)+1)
	for _, key := range keys {
		prefixed = append(prefixed, key+"="+env[key])
	}
	prefixed = append(prefixed, command)
	prefixed = append(prefixed, args...)
	return "env", prefixed
}

// SetTmux injects a tmux ControlClient, enables tmux backend for future
// Create() calls, and watches for tmux server/control loss so affected
// runtimes are marked exited without the manager recreating commands.
func (m *Manager) SetTmux(client *tmux.ControlClient) {
	m.mu.Lock()
	m.tmuxClient = client
	m.useTmux = true
	m.mu.Unlock()
	go func() {
		<-client.Lost()
		m.markTmuxRuntimesLost()
	}()
}

// markTmuxRuntimesLost exits every tmux-backed runtime after the control
// client reports the tmux server/connection is gone. It never spawns a
// replacement command; a later daemon restart reconciles surviving panes.
func (m *Manager) markTmuxRuntimesLost() {
	m.mu.Lock()
	m.useTmux = false
	runtimes := make([]*TerminalRuntime, 0, len(m.sessions))
	for _, runtime := range m.sessions {
		if _, ok := runtime.backend.(*tmux.TmuxBackend); ok {
			runtimes = append(runtimes, runtime)
		}
	}
	m.mu.Unlock()
	for _, runtime := range runtimes {
		m.markExited(runtime)
	}
}

// ReconcileTmux reattaches surviving tmux panes to their persisted terminal
// runtimes after a daemon restart. It never creates a replacement pane: a
// terminal whose pane no longer exists remains StateExited from restore().
func (m *Manager) ReconcileTmux(ctx context.Context) error {
	m.mu.Lock()
	client := m.tmuxClient
	m.mu.Unlock()
	if client == nil {
		return nil
	}
	if err := client.RefreshTopology(ctx); err != nil {
		return err
	}
	snapshot, err := m.runtime.Snapshot()
	if err != nil {
		return err
	}
	for _, pane := range snapshot.Topology {
		if pane.ServerID != client.ServerID() {
			continue // persisted from a different tmux server generation
		}
		m.mu.Lock()
		runtime, ok := m.sessions[pane.TerminalSessionID]
		m.mu.Unlock()
		if !ok || runtime.backend != nil {
			continue
		}
		backend, err := client.ReattachPane(ctx, pane.PaneID, pane.SessionID, pane.WindowID)
		if err != nil {
			continue // pane no longer present; terminal stays exited
		}
		var baseline []byte
		if tb, ok := any(backend).(interface{ TakeBaseline() []byte }); ok {
			baseline = tb.TakeBaseline()
		}
		m.mu.Lock()
		runtime.backend = backend
		runtime.meta.State = StateRunning
		runtime.meta.UpdatedAt = time.Now().UTC()
		runtime.seq++
		trimmed := truncateFront(baseline, m.maxScrollbackBytes)
		_ = os.WriteFile(runtime.scrollback, trimmed, 0o644)
		runtime.plain = trimPreview(detect.StripANSI(string(trimmed)))
		runtime.meta.Preview = previewLines(runtime.plain)
		runtime.outbound = make(chan outboundMessage, m.channelBufferSize)
		runtime.exitOnce = sync.Once{}
		m.forwardWorkers.Add(1)
		m.outputWorkers.Add(1)
		m.mu.Unlock()
		m.emitState(runtime)
		_ = m.recordRuntime(runtime, "terminal.updated")
		go func(r *TerminalRuntime) { defer m.forwardWorkers.Done(); m.forward(r) }(runtime)
		go func(r *TerminalRuntime) {
			defer m.outputWorkers.Done()
			defer close(r.outbound)
			m.readOutput(r)
		}(runtime)
	}
	return m.saveMetadata()
}

func (m *Manager) Create(ctx context.Context, req protocol.CreateSessionRequest) (*protocol.SessionSummary, error) {
	id, err := randomID()
	if err != nil {
		return nil, err
	}
	command := req.Command
	if command == "" {
		command = defaultShell()
	}
	cwd := req.CWD
	if cwd == "" {
		cwd = m.defaultCWD
	}
	cols, rows := req.Cols, req.Rows
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	var backend TerminalBackend
	switch req.Backend {
	case "", "auto":
		if m.useTmux && m.tmuxClient != nil {
			command, args := commandWithEnv(command, req.Args, req.Env)
			backend, err = m.tmuxClient.CreatePane(ctx, id, command, args, cwd, cols, rows)
		} else {
			cmd := exec.Command(command, req.Args...)
			cmd.Dir = cwd
			cmd.Env = append(os.Environ(), "TERM=xterm-256color")
			for key, value := range req.Env {
				cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", key, value))
			}
			backend, err = newPtyBackend(cmd, cols, rows)
		}
	case "pty", "direct":
		cmd := exec.Command(command, req.Args...)
		cmd.Dir = cwd
		cmd.Env = append(os.Environ(), "TERM=xterm-256color")
		for key, value := range req.Env {
			cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", key, value))
		}
		backend, err = newPtyBackend(cmd, cols, rows)
	case "tmux":
		if m.tmuxClient == nil {
			return nil, errors.New("tmux backend requested but unavailable")
		}
		command, args := commandWithEnv(command, req.Args, req.Env)
		backend, err = m.tmuxClient.CreatePane(ctx, id, command, args, cwd, cols, rows)
	default:
		return nil, fmt.Errorf("invalid terminal backend %q (must be auto, pty, or tmux)", req.Backend)
	}
	if err != nil {
		return nil, err
	}
	if tb, ok := any(backend).(interface{ TakeBaseline() []byte }); ok {
		_ = tb.TakeBaseline()
	}
	now := time.Now().UTC()
	runtime := &TerminalRuntime{
		meta: Session{
			ID:        id,
			Name:      req.Name,
			Command:   command,
			CWD:       cwd,
			State:     StateRunning,
			CreatedAt: now,
			UpdatedAt: now,
			Preview:   []string{"> session created"},
		},
		scrollback: filepath.Join(m.stateDir, "sessions", id+".scrollback"),
		outbound:   make(chan outboundMessage, m.channelBufferSize),
		backend:    backend,
	}
	if err := appendScrollback(runtime.scrollback, []byte("> session created\n"), m.maxScrollbackBytes); err != nil {
		_ = backend.Close()
		return nil, err
	}
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		_ = backend.Close()
		return nil, errors.New("session manager shutting down")
	}
	if err := m.runtime.RecordTerminal(m.terminalSummaryLocked(runtime), "terminal.created"); err != nil {
		m.mu.Unlock()
		_ = backend.Close()
		return nil, err
	}
	m.sessions[id] = runtime
	m.mu.Unlock()
	if err := m.recordTopology(); err != nil {
		m.mu.Lock()
		delete(m.sessions, id)
		m.mu.Unlock()
		_ = backend.Close()
		if rollbackErr := m.runtime.RemoveTerminal(id); rollbackErr != nil {
			return nil, fmt.Errorf("record tmux topology: %w; remove terminal projection: %v", err, rollbackErr)
		}
		return nil, err
	}
	m.mu.Lock()
	m.forwardWorkers.Add(1)
	m.outputWorkers.Add(1)
	m.mu.Unlock()
	go func() { defer m.forwardWorkers.Done(); m.forward(runtime) }()
	go func() {
		defer m.outputWorkers.Done()
		defer close(runtime.outbound)
		m.readOutput(runtime)
	}()
	if err := m.saveMetadata(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	copy := runtime.meta
	m.mu.Unlock()
	return &protocol.SessionSummary{ID: copy.ID, Name: copy.Name, Command: copy.Command, CWD: copy.CWD, State: string(copy.State), CreatedAt: copy.CreatedAt, UpdatedAt: copy.UpdatedAt, Preview: copy.Preview, WaitState: protocolWait(copy.WaitState)}, nil
}

func (m *Manager) recordTmuxTopology() error {
	m.mu.Lock()
	client := m.tmuxClient
	bindings := make(map[string]string, len(m.sessions))
	for terminalID, runtime := range m.sessions {
		if backend, ok := runtime.backend.(*tmux.TmuxBackend); ok {
			bindings[backend.GetPaneID()] = terminalID
		}
	}
	m.mu.Unlock()
	if client == nil {
		return nil
	}
	topology := client.GetTopology()
	panes := make([]runtimestore.TopologyPane, 0, len(bindings))
	for paneID, terminalID := range bindings {
		pane := topology.Panes[paneID]
		if pane == nil {
			continue
		}
		window := topology.Windows[pane.WindowID]
		session := topology.Sessions[pane.SessionID]
		if window == nil || session == nil {
			continue
		}
		panes = append(panes, runtimestore.TopologyPane{TerminalSessionID: terminalID, ServerID: client.ServerID(), SessionID: pane.SessionID, WindowID: pane.WindowID, PaneID: pane.PaneID, SessionName: session.Name, WindowName: window.Name, WindowIndex: window.Index, PaneIndex: pane.Index, CWD: pane.Path, Active: pane.Active, UpdatedAt: time.Now().UTC()})
	}
	return m.runtime.RecordTopology(panes)
}

func (m *Manager) RuntimeSnapshot() (*runtimestore.Snapshot, error) { return m.runtime.Snapshot() }

func (m *Manager) RuntimeEvents(after int64, limit int) ([]runtimestore.Event, int64, error) {
	return m.runtime.Events(after, limit)
}
func (m *Manager) SubscribeRuntime(fn func(runtimestore.Event)) func() {
	return m.runtime.Subscribe(fn)
}

func (m *Manager) Shutdown() error {
	m.shutdownOnce.Do(func() {
		m.mu.Lock()
		m.closing = true
		sessions := make([]*TerminalRuntime, 0, len(m.sessions))
		for _, runtime := range m.sessions {
			sessions = append(sessions, runtime)
		}
		m.mu.Unlock()
		for _, runtime := range sessions {
			if runtime.backend != nil {
				_ = runtime.backend.Close()
			}
		}
		m.outputWorkers.Wait()
		m.forwardWorkers.Wait()
		m.shutdownErr = m.runtime.Close()
	})
	return m.shutdownErr
}

func (m *Manager) List(_ context.Context) []protocol.SessionSummary {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]protocol.SessionSummary, 0, len(m.sessions))
	for _, runtime := range m.sessions {
		out = append(out, protocol.SessionSummary{ID: runtime.meta.ID, Name: runtime.meta.Name, Command: runtime.meta.Command, CWD: runtime.meta.CWD, State: string(runtime.meta.State), CreatedAt: runtime.meta.CreatedAt, UpdatedAt: runtime.meta.UpdatedAt, Preview: runtime.meta.Preview, WaitState: protocolWait(runtime.meta.WaitState)})
	}
	return out
}
func (m *Manager) Subscribe(id string, fn func(protocol.PTYOutputEnvelope, protocol.SessionStateEnvelope)) (func(), error) {
	m.mu.Lock()
	runtime, ok := m.sessions[id]
	if !ok {
		m.mu.Unlock()
		return nil, errors.New("session not found")
	}
	scrollback := runtime.scrollback
	m.mu.Unlock()
	runtime.scrollbackMu.Lock()
	m.mu.Lock()
	sub := &subscriber{fn: fn, active: true, replaySeq: runtime.seq}
	runtime.subs = append(runtime.subs, sub)
	m.mu.Unlock()

	// Holding the individual subscriber lock makes replay complete before a
	// concurrent forward can deliver newer frames to this subscriber.
	sub.mu.Lock()
	data, _ := os.ReadFile(scrollback)
	if sub.active {
		sub.fn(protocol.PTYOutputEnvelope{Type: "pty.baseline", SessionID: id, Data: base64.StdEncoding.EncodeToString(data), Seq: sub.replaySeq}, protocol.SessionStateEnvelope{})
	}
	sub.mu.Unlock()
	runtime.scrollbackMu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			m.mu.Lock()
			for i, candidate := range runtime.subs {
				if candidate == sub {
					runtime.subs = append(runtime.subs[:i], runtime.subs[i+1:]...)
					break
				}
			}
			m.mu.Unlock()

			sub.mu.Lock()
			sub.active = false
			sub.mu.Unlock()
		})
	}, nil
}

func (m *Manager) Input(id string, b []byte) error {
	m.mu.Lock()
	runtime, ok := m.sessions[id]
	m.mu.Unlock()
	if !ok {
		return errors.New("session not found")
	}
	if runtime.backend == nil || !runtime.backend.Alive() {
		return errors.New("session not running")
	}
	_, err := runtime.backend.Write(b)
	return err
}

func (m *Manager) Resize(id string, cols, rows int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	runtime, ok := m.sessions[id]
	if !ok {
		return errors.New("session not found")
	}
	if cols <= 0 || rows <= 0 {
		return errors.New("invalid terminal size")
	}
	if runtime.backend == nil || !runtime.backend.Alive() {
		return nil
	}
	return runtime.backend.Resize(cols, rows)
}

// TerminalTTY returns the child TTY for exact OMP breadcrumb association.
func (m *Manager) TerminalTTY(id string) string {
	m.mu.Lock()
	runtime := m.sessions[id]
	client := m.tmuxClient
	m.mu.Unlock()
	if runtime == nil || runtime.backend == nil {
		return ""
	}
	if backend, ok := runtime.backend.(*PtyBackend); ok {
		return backend.TTY()
	}
	if backend, ok := runtime.backend.(*tmux.TmuxBackend); ok && client != nil {
		if pane := client.GetTopology().Panes[backend.GetPaneID()]; pane != nil {
			return pane.TTY
		}
	}
	return ""
}

func (m *Manager) Close(id string) error {
	m.mu.Lock()
	runtime, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id)
	}
	m.mu.Unlock()
	if !ok {
		return errors.New("session not found")
	}
	if runtime.backend != nil {
		_ = runtime.backend.Close()
	}
	m.markExited(runtime)
	_ = os.Remove(runtime.scrollback)
	return nil
}

func (m *Manager) forward(runtime *TerminalRuntime) {
	for msg := range runtime.outbound {
		m.mu.Lock()
		subs := append([]*subscriber(nil), runtime.subs...)
		m.mu.Unlock()
		for _, sub := range subs {
			sub.mu.Lock()
			if sub.active && (msg.output == nil || msg.output.Seq > sub.replaySeq) {
				var output protocol.PTYOutputEnvelope
				var state protocol.SessionStateEnvelope
				if msg.output != nil {
					output = *msg.output
				}
				if msg.state != nil {
					state = *msg.state
				}
				sub.fn(output, state)
			}
			sub.mu.Unlock()
		}
	}
}

func (m *Manager) readOutput(runtime *TerminalRuntime) {
	buf := make([]byte, 32*1024)
	for {
		n, err := runtime.backend.Read(buf)
		if n > 0 {
			m.recordOutput(runtime, buf[:n])
		}
		if err != nil {
			m.markExited(runtime)
			return
		}
	}
}

func (m *Manager) recordOutput(runtime *TerminalRuntime, chunk []byte) {
	runtime.scrollbackMu.Lock()
	defer runtime.scrollbackMu.Unlock()
	_ = appendScrollback(runtime.scrollback, chunk, m.maxScrollbackBytes)
	plain := detect.StripANSI(string(chunk))

	stateChanged := false
	m.mu.Lock()
	runtime.seq++
	seq := runtime.seq
	runtime.plain = trimPreview(runtime.plain + plain)
	runtime.meta.Preview = previewLines(runtime.plain)
	runtime.meta.UpdatedAt = time.Now().UTC()
	wait := runtime.detector.Push(string(chunk), time.Now())
	if wait != nil {
		runtime.meta.WaitState = wait
		runtime.meta.State = StateWaiting
		stateChanged = true
	} else if runtime.meta.State == StateWaiting {
		runtime.meta.State = StateRunning
		stateChanged = true
	}
	m.mu.Unlock()

	if wait != nil {
		m.notify(runtime, wait)
		m.emitState(runtime)
	}
	m.enqueue(runtime, outboundMessage{output: &protocol.PTYOutputEnvelope{Type: "pty.output", SessionID: runtime.meta.ID, Data: base64.StdEncoding.EncodeToString(chunk), Seq: seq}})
	if stateChanged {
		_ = m.saveMetadata()
	}
}

func (m *Manager) markExited(runtime *TerminalRuntime) {
	runtime.exitOnce.Do(func() {
		m.mu.Lock()
		wait := runtime.detector.Exited()
		runtime.meta.State = StateExited
		runtime.meta.WaitState = wait
		runtime.meta.UpdatedAt = time.Now().UTC()
		m.mu.Unlock()
		m.notify(runtime, wait)
		m.emitState(runtime)
		_ = m.saveMetadata()
		_ = m.recordRuntime(runtime, "terminal.exited")
	})
}

func (m *Manager) recordRuntime(runtime *TerminalRuntime, kind string) error {
	m.mu.Lock()
	summary := m.terminalSummaryLocked(runtime)
	m.mu.Unlock()
	return m.runtime.RecordTerminal(summary, kind)
}

// terminalSummaryLocked reads runtime.meta fields; caller must hold m.mu.
func (m *Manager) terminalSummaryLocked(runtime *TerminalRuntime) runtimestore.TerminalSummary {
	return runtimestore.TerminalSummary{
		ID: runtime.meta.ID, Name: runtime.meta.Name, CWD: runtime.meta.CWD, Seq: runtime.seq,
		Exited: runtime.meta.State == StateExited, CreatedAt: runtime.meta.CreatedAt, UpdatedAt: runtime.meta.UpdatedAt,
	}
}

func (m *Manager) emitState(runtime *TerminalRuntime) {
	m.enqueue(runtime, outboundMessage{state: &protocol.SessionStateEnvelope{Type: "session.state", SessionID: runtime.meta.ID, State: string(runtime.meta.State), WaitState: protocolWait(runtime.meta.WaitState)}, control: true})
}

func (m *Manager) enqueue(runtime *TerminalRuntime, msg outboundMessage) {
	runtime.enqueueMu.Lock()
	defer runtime.enqueueMu.Unlock()
	if msg.control {
		select {
		case runtime.outbound <- msg:
		default:
			queue := drainQueue(runtime.outbound)
			for _, item := range queue {
				if item.control {
					continue
				}
				runtime.outbound <- item
			}
			runtime.outbound <- msg
		}
		return
	}
	select {
	case runtime.outbound <- msg:
	default:
		oldest := <-runtime.outbound
		if oldest.control {
			runtime.outbound <- oldest
			return
		}
		runtime.outbound <- msg
	}
}

func (m *Manager) notify(runtime *TerminalRuntime, wait *detect.WaitState) {
	if m.notifier == nil || wait == nil {
		return
	}
	_ = m.notifier.Notify(context.Background(), notify.Event{SessionID: runtime.meta.ID, SessionName: runtime.meta.Name, Kind: wait.Kind, Title: wait.Label, Body: wait.Matched, At: time.Now().UTC()})
}

func (m *Manager) restore() error {
	path := filepath.Join(m.stateDir, "sessions", "sessions.json")
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var restored []Session
	if err := json.Unmarshal(data, &restored); err != nil {
		return err
	}
	for _, item := range restored {
		item.State = StateExited
		runtime := &TerminalRuntime{meta: item, scrollback: filepath.Join(m.stateDir, "sessions", item.ID+".scrollback"), outbound: make(chan outboundMessage, m.channelBufferSize)}
		if data, err := os.ReadFile(runtime.scrollback); err == nil {
			trimmed := truncateFront(data, m.maxScrollbackBytes)
			_ = os.WriteFile(runtime.scrollback, trimmed, 0o644)
			runtime.plain = trimPreview(detect.StripANSI(string(trimmed)))
			runtime.meta.Preview = previewLines(runtime.plain)
		}
		m.sessions[item.ID] = runtime
		runtime.exitOnce.Do(func() {})
		close(runtime.outbound)
	}
	return m.saveMetadata()
}

func (m *Manager) saveMetadata() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	items := make([]Session, 0, len(m.sessions))
	for _, runtime := range m.sessions {
		items = append(items, runtime.meta)
	}
	data, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(filepath.Join(m.stateDir, "sessions", "sessions.json"), data, 0o644)
}

func appendScrollback(path string, chunk []byte, limit int64) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := file.Write(chunk); err != nil {
		file.Close()
		return err
	}
	file.Close()
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	trimmed := truncateFront(data, limit)
	if len(trimmed) == len(data) {
		return nil
	}
	return os.WriteFile(path, trimmed, 0o644)
}

func truncateFront(data []byte, limit int64) []byte {
	if int64(len(data)) <= limit {
		return data
	}
	return append([]byte(nil), data[len(data)-int(limit):]...)
}

func previewLines(text string) []string {
	lines := strings.Split(text, "\n")
	out := make([]string, 0, 6)
	for _, line := range lines {
		if line == "" {
			continue
		}
		out = append(out, line)
		if len(out) > 6 {
			out = out[1:]
		}
	}
	return out
}

func trimPreview(text string) string {
	if len(text) <= 8192 {
		return text
	}
	return text[len(text)-8192:]
}

func defaultShell() string {
	if runtime.GOOS == "windows" {
		if shell := os.Getenv("COMSPEC"); shell != "" {
			return shell
		}
		return "cmd.exe"
	}
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	if u, err := user.Current(); err == nil && runtime.GOOS != "windows" {
		if data, err := os.ReadFile("/etc/passwd"); err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				parts := strings.Split(line, ":")
				if len(parts) >= 7 && parts[0] == u.Username {
					if parts[6] != "" {
						return parts[6]
					}
				}
			}
		}
	}
	return "/bin/sh"
}

func AvailableShells() []string {
	if runtime.GOOS == "windows" {
		var shells []string
		for _, candidate := range []string{"cmd.exe", "powershell.exe", "pwsh.exe"} {
			if _, err := exec.LookPath(candidate); err == nil {
				shells = append(shells, candidate)
			}
		}
		if len(shells) == 0 {
			shells = []string{defaultShell()}
		}
		return shells
	}
	data, err := os.ReadFile("/etc/shells")
	if err != nil {
		return []string{defaultShell()}
	}
	var shells []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		shells = append(shells, line)
	}
	if len(shells) == 0 {
		// ponytail: /etc/shells missing entries on minimal containers — fall back rather than return empty.
		return []string{defaultShell()}
	}
	return shells
}

func protocolWait(wait *detect.WaitState) *protocol.WaitState {
	if wait == nil {
		return nil
	}
	return &protocol.WaitState{Kind: wait.Kind, Label: wait.Label, Confidence: wait.Confidence, Matched: wait.Matched}
}

func drainQueue(ch <-chan outboundMessage) []outboundMessage {
	items := make([]outboundMessage, 0)
	for {
		select {
		case item := <-ch:
			items = append(items, item)
		default:
			return items
		}
	}
}

func randomID() (string, error) {
	return base64.RawURLEncoding.EncodeToString([]byte(time.Now().UTC().Format("150405.000000000"))), nil
}
