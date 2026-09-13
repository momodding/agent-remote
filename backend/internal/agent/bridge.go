package agent

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

//go:embed bridge.ts
var bridgeTS []byte

const (
	maxFrameSize  = 1024 * 1024 // 1 MB
	helloTimeout  = 5 * time.Second
	maxSecretLen  = 256
	maxAgentIDLen = 256
)

var (
	ErrBridgeNotConnected = errors.New("bridge not connected")
	ErrBridgeClosed       = errors.New("bridge closed")
	ErrUnknownAgent       = errors.New("unknown agent")
	ErrInvalidSecret      = errors.New("invalid bridge secret")
	ErrFrameTooLarge      = errors.New("frame exceeds maximum size")
)

func generateSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// EnsureBridgeMaterialized writes the embedded bridge.ts extension to disk with 0600 permissions.
func EnsureBridgeMaterialized(agentDir string) (string, error) {
	if err := os.MkdirAll(agentDir, 0o700); err != nil {
		return "", fmt.Errorf("failed to create agent dir: %w", err)
	}
	bridgePath := filepath.Join(agentDir, "bridge.ts")
	if err := os.WriteFile(bridgePath, bridgeTS, 0o600); err != nil {
		return "", fmt.Errorf("failed to materialize bridge.ts: %w", err)
	}
	return bridgePath, nil
}

func saveBridgeSecret(agentDir, agentID, secret string) error {
	dir := filepath.Join(agentDir, "bridge", "credentials")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, agentID), []byte(secret), 0o600)
}

func loadBridgeSecret(agentDir, agentID string) (string, error) {
	data, err := os.ReadFile(filepath.Join(agentDir, "bridge", "credentials", agentID))
	if err != nil {
		return "", err
	}
	secret := strings.TrimSpace(string(data))
	if secret == "" || len(secret) > maxSecretLen {
		return "", ErrInvalidSecret
	}
	return secret, nil
}

func removeBridgeSecret(agentDir, agentID string) {
	_ = os.Remove(filepath.Join(agentDir, "bridge", "credentials", agentID))
}

func validateUserArgs(args []string) error {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "-e" || arg == "--extension" || strings.HasPrefix(arg, "-e=") || strings.HasPrefix(arg, "--extension=") {
			return fmt.Errorf("user extension flags are not allowed: %s", arg)
		}
		if arg == "--trusted-extension" || strings.HasPrefix(arg, "--trusted-extension=") {
			return fmt.Errorf("user extension flags are not allowed: %s", arg)
		}
		if arg == "--mode" && i+1 < len(args) && args[i+1] != "tui" {
			return fmt.Errorf("user mode flag not allowed in agent terminal: %s %s", arg, args[i+1])
		}
		if strings.HasPrefix(arg, "--mode=") && arg != "--mode=tui" {
			return fmt.Errorf("user mode flag not allowed in agent terminal: %s", arg)
		}
		if arg == "--print" || arg == "--export" || strings.HasPrefix(arg, "--export=") {
			return fmt.Errorf("non-interactive flag not allowed: %s", arg)
		}
	}
	return nil
}

type BridgeHello struct {
	Type         string   `json:"type"`
	AgentID      string   `json:"agentId"`
	Secret       string   `json:"secret"`
	SessionID    string   `json:"sessionId"`
	SessionFile  string   `json:"sessionFile"`
	Capabilities []string `json:"capabilities"`
}

type BridgeCommand struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Command   string `json:"command"`
	Args      any    `json:"args,omitempty"`
}

type BridgeCommandResult struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	OK        bool   `json:"ok"`
	Error     string `json:"error,omitempty"`
}

type bridgeAgentState struct {
	mu            sync.Mutex
	agentID       string
	secret        string
	authenticated bool
	conn          net.Conn
	writerMu      sync.Mutex
	pending       map[string]chan BridgeCommandResult
	sessionID     string
	sessionFile   string
	capabilities  map[string]bool
}

type BridgeServer struct {
	mu           sync.RWMutex
	socketPath   string
	listener     net.Listener
	agents       map[string]*bridgeAgentState // agentID -> state
	closing      bool
	reqCounter   uint64
	onHello      func(agentID string, hello BridgeHello)
	onDisconnect func(agentID string)
}

func NewBridgeServer(socketPath string, onHello func(agentID string, hello BridgeHello), onDisconnect func(agentID string)) (*BridgeServer, error) {
	dir := filepath.Dir(socketPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("failed to create bridge socket dir: %w", err)
	}

	_ = os.Remove(socketPath)
	l, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("failed to listen on bridge socket: %w", err)
	}
	_ = os.Chmod(socketPath, 0o600)

	bs := &BridgeServer{
		socketPath:   socketPath,
		listener:     l,
		agents:       make(map[string]*bridgeAgentState),
		onHello:      onHello,
		onDisconnect: onDisconnect,
	}

	go bs.acceptLoop()
	return bs, nil
}

func (b *BridgeServer) acceptLoop() {
	for {
		conn, err := b.listener.Accept()
		if err != nil {
			b.mu.RLock()
			closing := b.closing
			b.mu.RUnlock()
			if closing {
				return
			}
			time.Sleep(10 * time.Millisecond)
			continue
		}
		go b.handleConn(conn)
	}
}

func (b *BridgeServer) handleConn(conn net.Conn) {
	defer conn.Close()

	_ = conn.SetReadDeadline(time.Now().Add(helloTimeout))
	reader := bufio.NewReaderSize(conn, 64*1024)

	line, err := readBoundedLine(reader, maxFrameSize)
	if err != nil {
		return
	}

	var hello BridgeHello
	if err := json.Unmarshal(line, &hello); err != nil || hello.Type != "hello" {
		return
	}

	if hello.AgentID == "" || hello.Secret == "" || len(hello.AgentID) > maxAgentIDLen || len(hello.Secret) > maxSecretLen {
		return
	}

	b.mu.RLock()
	state, exists := b.agents[hello.AgentID]
	closing := b.closing
	b.mu.RUnlock()

	if closing || !exists || state == nil {
		return
	}

	state.mu.Lock()
	if subtle.ConstantTimeCompare([]byte(state.secret), []byte(hello.Secret)) != 1 {
		state.mu.Unlock()
		return
	}

	// Reject replayed / concurrent connections on the same agent while one is active
	if state.conn != nil {
		oldConn := state.conn
		state.conn = nil
		state.authenticated = false
		_ = oldConn.Close()
		for reqID, ch := range state.pending {
			delete(state.pending, reqID)
			select {
			case ch <- BridgeCommandResult{RequestID: reqID, OK: false, Error: "reconnected"}:
			default:
			}
		}
	}

	state.conn = conn
	state.authenticated = true
	state.sessionID = hello.SessionID
	state.sessionFile = hello.SessionFile
	state.capabilities = make(map[string]bool)
	for _, capName := range hello.Capabilities {
		state.capabilities[capName] = true
	}
	agentID := state.agentID
	state.mu.Unlock()

	_ = conn.SetReadDeadline(time.Time{})

	if b.onHello != nil {
		b.onHello(agentID, hello)
	}

	defer func() {
		disconnected := false
		state.mu.Lock()
		if state.conn == conn {
			state.conn = nil
			state.authenticated = false
			disconnected = true
			for reqID, ch := range state.pending {
				delete(state.pending, reqID)
				select {
				case ch <- BridgeCommandResult{RequestID: reqID, OK: false, Error: "bridge disconnected"}:
				default:
				}
			}
		}
		state.mu.Unlock()
		if disconnected && b.onDisconnect != nil {
			b.onDisconnect(agentID)
		}
	}()

	for {
		line, err := readBoundedLine(reader, maxFrameSize)
		if err != nil {
			return
		}
		if len(line) == 0 {
			continue
		}

		var raw struct {
			Type      string `json:"type"`
			RequestID string `json:"requestId"`
			OK        bool   `json:"ok"`
			Error     string `json:"error,omitempty"`
		}
		if err := json.Unmarshal(line, &raw); err != nil {
			continue
		}

		if raw.Type == "command.result" && raw.RequestID != "" {
			state.mu.Lock()
			ch, ok := state.pending[raw.RequestID]
			if ok {
				delete(state.pending, raw.RequestID)
			}
			state.mu.Unlock()

			if ok && ch != nil {
				ch <- BridgeCommandResult{
					Type:      raw.Type,
					RequestID: raw.RequestID,
					OK:        raw.OK,
					Error:     raw.Error,
				}
			}
		}
	}
}

func readBoundedLine(r *bufio.Reader, maxBytes int) ([]byte, error) {
	var line []byte
	for {
		chunk, isPrefix, err := r.ReadLine()
		if err != nil {
			return nil, err
		}
		line = append(line, chunk...)
		if len(line) > maxBytes {
			return nil, ErrFrameTooLarge
		}
		if !isPrefix {
			break
		}
	}
	return line, nil
}

func (b *BridgeServer) RegisterAgent(agentID, secret string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.agents[agentID] = &bridgeAgentState{
		agentID: agentID,
		secret:  secret,
		pending: make(map[string]chan BridgeCommandResult),
	}
}

func (b *BridgeServer) UnregisterAgent(agentID string) {
	b.mu.Lock()
	state, ok := b.agents[agentID]
	delete(b.agents, agentID)
	b.mu.Unlock()

	if ok && state != nil {
		state.mu.Lock()
		if state.conn != nil {
			_ = state.conn.Close()
			state.conn = nil
		}
		for reqID, ch := range state.pending {
			delete(state.pending, reqID)
			select {
			case ch <- BridgeCommandResult{RequestID: reqID, OK: false, Error: "agent unregistered"}:
			default:
			}
		}
		state.mu.Unlock()
	}
}

func (b *BridgeServer) SendCommand(ctx context.Context, agentID, command string, args any) error {
	b.mu.RLock()
	state, ok := b.agents[agentID]
	closing := b.closing
	b.mu.RUnlock()

	if closing {
		return ErrBridgeClosed
	}
	if !ok || state == nil {
		return ErrUnknownAgent
	}

	state.mu.Lock()
	if !state.authenticated || state.conn == nil {
		state.mu.Unlock()
		return ErrBridgeNotConnected
	}

	reqID := fmt.Sprintf("req_%d_%d", atomic.AddUint64(&b.reqCounter, 1), time.Now().UnixNano())
	resCh := make(chan BridgeCommandResult, 1)
	state.pending[reqID] = resCh
	conn := state.conn
	state.mu.Unlock()

	cmd := BridgeCommand{
		Type:      "command",
		RequestID: reqID,
		Command:   command,
		Args:      args,
	}
	data, err := json.Marshal(cmd)
	if err != nil {
		state.mu.Lock()
		delete(state.pending, reqID)
		state.mu.Unlock()
		return err
	}
	data = append(data, '\n')
	if len(data) > maxFrameSize {
		state.mu.Lock()
		delete(state.pending, reqID)
		state.mu.Unlock()
		return ErrFrameTooLarge
	}

	state.writerMu.Lock()
	_, err = conn.Write(data)
	state.writerMu.Unlock()
	if err != nil {
		state.mu.Lock()
		delete(state.pending, reqID)
		state.mu.Unlock()
		return fmt.Errorf("failed to send command to bridge: %w", err)
	}

	select {
	case <-ctx.Done():
		state.mu.Lock()
		delete(state.pending, reqID)
		state.mu.Unlock()
		return ctx.Err()
	case res := <-resCh:
		if !res.OK {
			if res.Error != "" {
				return errors.New(res.Error)
			}
			return fmt.Errorf("bridge command %q failed", command)
		}
		return nil
	}
}

func (b *BridgeServer) IsConnected(agentID string) bool {
	b.mu.RLock()
	state, ok := b.agents[agentID]
	b.mu.RUnlock()
	if !ok || state == nil {
		return false
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.authenticated && state.conn != nil
}

func (b *BridgeServer) HasCapability(agentID, capName string) bool {
	b.mu.RLock()
	state, ok := b.agents[agentID]
	b.mu.RUnlock()
	if !ok || state == nil {
		return false
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.authenticated && state.conn != nil && state.capabilities[capName]
}

func (b *BridgeServer) SocketPath() string {
	return b.socketPath
}

func (b *BridgeServer) Close() error {
	b.mu.Lock()
	if b.closing {
		b.mu.Unlock()
		return nil
	}
	b.closing = true
	agents := make([]*bridgeAgentState, 0, len(b.agents))
	for _, a := range b.agents {
		agents = append(agents, a)
	}
	b.agents = make(map[string]*bridgeAgentState)
	l := b.listener
	b.listener = nil
	b.mu.Unlock()

	var err error
	if l != nil {
		err = l.Close()
	}
	_ = os.Remove(b.socketPath)

	for _, a := range agents {
		a.mu.Lock()
		if a.conn != nil {
			_ = a.conn.Close()
			a.conn = nil
		}
		for reqID, ch := range a.pending {
			delete(a.pending, reqID)
			select {
			case ch <- BridgeCommandResult{RequestID: reqID, OK: false, Error: "bridge closed"}:
			default:
			}
		}
		a.mu.Unlock()
	}
	return err
}
