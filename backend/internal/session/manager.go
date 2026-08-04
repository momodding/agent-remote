package session

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/detect"
	"github.com/agenticremote/agenticremote/backend/internal/notify"
	"github.com/agenticremote/agenticremote/backend/internal/protocol"
	"github.com/creack/pty"
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
}

type subscriber struct {
	mu        sync.Mutex
	fn        func(protocol.PTYOutputEnvelope, protocol.SessionStateEnvelope)
	active    bool
	replaySeq int64
}

type sessionRuntime struct {
	meta       Session
	detector   detect.Detector
	subs       []*subscriber
	seq        int64
	scrollback string
	plain      string
	outbound   chan outboundMessage
	cmd        *exec.Cmd
	ptmx       *os.File
	exitOnce   sync.Once
}

type outboundMessage struct {
	output  *protocol.PTYOutputEnvelope
	state   *protocol.SessionStateEnvelope
	control bool
}

type Manager struct {
	mu                 sync.Mutex
	sessions           map[string]*sessionRuntime
	stateDir           string
	workspaceRoot      string
	defaultCWD         string
	maxScrollbackBytes int64
	channelBufferSize  int
	notifier           notify.Notifier
}

func NewManager(defaultCWD, stateDir, workspaceRoot string, maxScrollbackBytes int64, channelBufferSize int, notifier notify.Notifier) (*Manager, error) {
	m := &Manager{sessions: map[string]*sessionRuntime{}, defaultCWD: defaultCWD, stateDir: stateDir, workspaceRoot: workspaceRoot, maxScrollbackBytes: maxScrollbackBytes, channelBufferSize: channelBufferSize, notifier: notifier}
	if err := os.MkdirAll(filepath.Join(stateDir, "sessions"), 0o755); err != nil {
		return nil, err
	}
	if err := m.restore(); err != nil {
		return nil, err
	}
	return m, nil
}

func (m *Manager) Create(_ context.Context, req protocol.CreateSessionRequest) (*protocol.SessionSummary, error) {
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
	cmd := exec.Command(command, req.Args...)
	cmd.Dir = cwd
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	runtime := &sessionRuntime{
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
		cmd:        cmd,
		ptmx:       ptmx,
	}
	if err := appendScrollback(runtime.scrollback, []byte("> session created\n"), m.maxScrollbackBytes); err != nil {
		_ = ptmx.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		return nil, err
	}
	m.mu.Lock()
	m.sessions[id] = runtime
	m.mu.Unlock()
	go m.forward(runtime)
	go m.readOutput(runtime)
	if err := m.saveMetadata(); err != nil {
		return nil, err
	}
	copy := runtime.meta
	return &protocol.SessionSummary{ID: copy.ID, Name: copy.Name, Command: copy.Command, CWD: copy.CWD, State: string(copy.State), CreatedAt: copy.CreatedAt, UpdatedAt: copy.UpdatedAt, Preview: copy.Preview, WaitState: protocolWait(copy.WaitState)}, nil
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
	sub := &subscriber{fn: fn, active: true, replaySeq: runtime.seq}
	runtime.subs = append(runtime.subs, sub)
	scrollback := runtime.scrollback
	m.mu.Unlock()

	// Holding the individual subscriber lock makes replay complete before a
	// concurrent forward can deliver newer frames to this subscriber.
	sub.mu.Lock()
	if data, err := os.ReadFile(scrollback); err == nil && len(data) > 0 && sub.active {
		sub.fn(protocol.PTYOutputEnvelope{Type: "pty.output", SessionID: id, Data: base64.StdEncoding.EncodeToString(data), Seq: sub.replaySeq}, protocol.SessionStateEnvelope{})
	}
	sub.mu.Unlock()

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
	if runtime.ptmx == nil {
		return errors.New("session not running")
	}
	_, err := runtime.ptmx.Write(b)
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
	if runtime.ptmx == nil {
		return nil
	}
	return pty.Setsize(runtime.ptmx, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
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
	if runtime.cmd != nil && runtime.cmd.Process != nil {
		_ = runtime.cmd.Process.Kill()
	}
	if runtime.ptmx != nil {
		_ = runtime.ptmx.Close()
	}
	m.markExited(runtime)
	// ponytail: Process.Kill only hits direct PTY child, not whole process tree; add per-OS process-group kill if orphaned grandchildren become real.
	// ponytail: outbound channel is left open (goroutine leaks until GC of the
	// last subscriber send); explicit close is rare enough that a done-signal
	// isn't worth it. Revisit if session churn gets heavy.
	_ = os.Remove(runtime.scrollback)
	return nil
}

func (m *Manager) forward(runtime *sessionRuntime) {
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

func (m *Manager) readOutput(runtime *sessionRuntime) {
	buf := make([]byte, 32*1024)
	for {
		n, err := runtime.ptmx.Read(buf)
		if n > 0 {
			m.recordOutput(runtime, buf[:n])
		}
		if err != nil {
			m.markExited(runtime)
			return
		}
	}
}

func (m *Manager) recordOutput(runtime *sessionRuntime, chunk []byte) {
	runtime.seq++
	_ = appendScrollback(runtime.scrollback, chunk, m.maxScrollbackBytes)
	plain := detect.StripANSI(string(chunk))
	runtime.plain = trimPreview(runtime.plain + plain)
	runtime.meta.Preview = previewLines(runtime.plain)
	runtime.meta.UpdatedAt = time.Now().UTC()
	if wait := runtime.detector.Push(string(chunk), time.Now()); wait != nil {
		runtime.meta.WaitState = wait
		runtime.meta.State = StateWaiting
		m.notify(runtime, wait)
		m.emitState(runtime)
	} else if runtime.meta.State == StateWaiting {
		runtime.meta.State = StateRunning
	}
	m.enqueue(runtime, outboundMessage{output: &protocol.PTYOutputEnvelope{Type: "pty.output", SessionID: runtime.meta.ID, Data: base64.StdEncoding.EncodeToString(chunk), Seq: runtime.seq}})
	_ = m.saveMetadata()
}

func (m *Manager) markExited(runtime *sessionRuntime) {
	runtime.exitOnce.Do(func() {
		runtime.meta.State = StateExited
		wait := runtime.detector.Exited()
		runtime.meta.WaitState = wait
		runtime.meta.UpdatedAt = time.Now().UTC()
		m.notify(runtime, wait)
		m.emitState(runtime)
		_ = m.saveMetadata()
	})
}

func (m *Manager) emitState(runtime *sessionRuntime) {
	m.enqueue(runtime, outboundMessage{state: &protocol.SessionStateEnvelope{Type: "session.state", SessionID: runtime.meta.ID, State: string(runtime.meta.State), WaitState: protocolWait(runtime.meta.WaitState)}, control: true})
}

func (m *Manager) enqueue(runtime *sessionRuntime, msg outboundMessage) {
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

func (m *Manager) notify(runtime *sessionRuntime, wait *detect.WaitState) {
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
		runtime := &sessionRuntime{meta: item, scrollback: filepath.Join(m.stateDir, "sessions", item.ID+".scrollback"), outbound: make(chan outboundMessage, m.channelBufferSize)}
		if data, err := os.ReadFile(runtime.scrollback); err == nil {
			trimmed := truncateFront(data, m.maxScrollbackBytes)
			_ = os.WriteFile(runtime.scrollback, trimmed, 0o644)
			runtime.plain = trimPreview(detect.StripANSI(string(trimmed)))
			runtime.meta.Preview = previewLines(runtime.plain)
		}
		m.sessions[item.ID] = runtime
		go m.forward(runtime)
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
	return "/bin/sh"
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
