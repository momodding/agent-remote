package tmux

import (
	"bufio"
	"fmt"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Parser handles tmux control-mode protocol with FIFO command queue.
// Parses: %begin → <output lines> → %end/%error (FIFO matched)
// Notifications: %output %pane <octal>, %sessions-changed, etc. outside blocks
// Decodes octal escapes and fans out pane output.
type Parser struct {
	mu             sync.Mutex
	scanner        *bufio.Scanner
	currentCmd     *ControlCommand   // Currently parsed command
	cmdQueue       []*ControlCommand // FIFO pending commands
	cmdCounter     int64             // For unique command IDs
	sequence       uint64            // monotonically increases for every control line
	paneOutputCh   map[string]chan paneOutput
	captureOutputs map[string][]paneOutput // unbounded only during capture-pane handoff
	closed         bool
	ignoringBlock  bool
	ready          chan struct{}
	readyOnce      sync.Once
	notifyChan     chan NotificationEvent
}

func NewParser(reader io.Reader) *Parser {
	return &Parser{
		scanner:        bufio.NewScanner(reader),
		cmdQueue:       make([]*ControlCommand, 0, 32),
		paneOutputCh:   make(map[string]chan paneOutput),
		captureOutputs: make(map[string][]paneOutput),
		ready:          make(chan struct{}),
		notifyChan:     make(chan NotificationEvent, 64),
	}
}

var (
	beginRegex          = regexp.MustCompile(`^%begin\s+(\S+)\s+(\S+)\s+(\S+)$`)
	endRegex            = regexp.MustCompile(`^%end\s+(\S+)\s+(\S+)\s+(\S+)$`)
	errorRegex          = regexp.MustCompile(`^%error\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$`)
	outputRegex         = regexp.MustCompile(`^%output\s+(\S+)\s+(.*)$`) // %output %pane <octal>
	sessionChangedRegex = regexp.MustCompile(`^%session-changed\s+(\S+)\s+(\S+)$`)
)

// Start launches the parser loop
func (p *Parser) Start() (resultErr error) {
	defer close(p.notifyChan)
	defer func() {
		code := "EOF"
		if resultErr != nil {
			code = "parser_error"
		}
		p.failPendingCommands(code, "parser exited")
	}()

	for p.scanner.Scan() {
		line := p.scanner.Text()
		if line == "" {
			continue
		}

		if err := p.handleLine(line); err != nil {
			return fmt.Errorf("parser error: %w", err)
		}
	}

	if err := p.scanner.Err(); err != nil {
		return err
	}
	return nil
}

func (p *Parser) failPendingCommands(code, message string) {
	p.mu.Lock()
	defer p.mu.Unlock()

	fail := func(cmd *ControlCommand) {
		cmd.Result = &CommandResult{CommandID: cmd.ID, Error: &ControlError{Code: code, Message: message}}
		select {
		case cmd.resultChan <- cmd.Result:
		default:
		}
		close(cmd.resultChan)
	}
	if p.currentCmd != nil {
		fail(p.currentCmd)
		p.currentCmd = nil
	}
	for _, cmd := range p.cmdQueue {
		fail(cmd)
	}
	p.cmdQueue = p.cmdQueue[:0]
}

// handleLine processes a single line
func (p *Parser) handleLine(line string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sequence++

	// Command block markers
	if strings.HasPrefix(line, BeginMarker) {
		return p.handleBegin(line)
	}

	if strings.HasPrefix(line, EndMarker) {
		return p.handleEnd(line)
	}

	if strings.HasPrefix(line, ErrorMarker) {
		return p.handleError(line)
	}

	// %output outside blocks: pane output
	if strings.HasPrefix(line, OutputMarker) {
		return p.handlePaneOutput(line)
	}

	// Notifications
	if strings.HasPrefix(line, SessionsChanged) {
		p.notifyChan <- NotificationEvent{Type: "sessions-changed", Timestamp: time.Now()}
		return nil
	}

	if strings.HasPrefix(line, SessionChanged) {
		m := sessionChangedRegex.FindStringSubmatch(line)
		if len(m) >= 2 {
			p.notifyChan <- NotificationEvent{Type: "session-changed", SessionID: m[1], Timestamp: time.Now()}
		}
		return nil
	}

	if strings.HasPrefix(line, WindowAdd) {
		parts := strings.Fields(line)
		if len(parts) >= 2 {
			p.notifyChan <- NotificationEvent{Type: "window-add", WindowID: parts[1], Timestamp: time.Now()}
		}
		return nil
	}

	if strings.HasPrefix(line, WindowDel) {
		parts := strings.Fields(line)
		if len(parts) >= 2 {
			p.notifyChan <- NotificationEvent{Type: "window-del", WindowID: parts[1], Timestamp: time.Now()}
		}
		return nil
	}

	if strings.HasPrefix(line, WindowChanged) {
		p.notifyChan <- NotificationEvent{Type: "window-changed", Timestamp: time.Now()}
		return nil
	}

	if strings.HasPrefix(line, LayoutChanged) {
		p.notifyChan <- NotificationEvent{Type: "layout-changed", Timestamp: time.Now()}
		return nil
	}

	if strings.HasPrefix(line, ExitMarker) {
		p.notifyChan <- NotificationEvent{Type: "exit", Timestamp: time.Now()}
		return nil
	}

	if p.currentCmd != nil {
		p.currentCmd.Result.Lines = append(p.currentCmd.Result.Lines, line)
	}
	return nil
}

// handleBegin pops queue head
func (p *Parser) handleBegin(line string) error {
	if p.currentCmd != nil {
		return fmt.Errorf("%%begin while previous command incomplete")
	}

	if len(p.cmdQueue) == 0 {
		p.ignoringBlock = true
		return nil
	}

	cmd := p.cmdQueue[0]
	p.cmdQueue = p.cmdQueue[1:]
	cmd.Result = &CommandResult{CommandID: cmd.ID, Lines: []string{}}
	p.currentCmd = cmd

	return nil
}

// handleEnd closes command block successfully.
func (p *Parser) handleEnd(line string) error {
	if p.ignoringBlock {
		p.ignoringBlock = false
		p.readyOnce.Do(func() { close(p.ready) })
		return nil
	}
	if p.currentCmd == nil {
		return fmt.Errorf("%%end without %%begin")
	}

	cmd := p.currentCmd
	cmd.Result.Output = concatenateLines(cmd.Result.Lines)
	cmd.Result.Sequence = p.sequence
	// Send result to channel (non-blocking with buffer)
	select {
	case cmd.resultChan <- cmd.Result:
	default:
		// Buffer full or closed; drop
	}
	close(cmd.resultChan)
	p.currentCmd = nil

	return nil
}

// handleError closes command block with error.
func (p *Parser) handleError(line string) error {
	if p.ignoringBlock {
		p.ignoringBlock = false
		return nil
	}
	if p.currentCmd == nil {
		return fmt.Errorf("%%error without %%begin")
	}

	m := errorRegex.FindStringSubmatch(line)
	errMsg := ""
	if len(m) > 4 && m[4] != "" {
		errMsg = m[4]
	}

	cmd := p.currentCmd
	cmd.Result.Output = concatenateLines(cmd.Result.Lines)
	cmd.Result.Sequence = p.sequence
	cmd.Result.Error = &ControlError{Code: "command_error", Message: errMsg}
	// Send result to channel (non-blocking with buffer)
	select {
	case cmd.resultChan <- cmd.Result:
	default:
		// Buffer full or closed; drop
	}
	close(cmd.resultChan)
	p.currentCmd = nil

	return nil
}

// handlePaneOutput decodes %output and fans out to pane subscribers
func (p *Parser) handlePaneOutput(line string) error {
	// %output %pane <octal-escaped-bytes>
	m := outputRegex.FindStringSubmatch(line)
	if len(m) < 3 {
		return nil // Malformed, ignore
	}

	paneID := m[1]
	octals := m[2]

	// Decode octal escapes
	payload := decodeOctalEscapes(octals)

	event := paneOutput{sequence: p.sequence, payload: payload}
	if buffered, capturing := p.captureOutputs[paneID]; capturing {
		p.captureOutputs[paneID] = append(buffered, event)
		return nil
	}
	if ch, ok := p.paneOutputCh[paneID]; ok {
		select {
		case ch <- event:
		default:
			// The normal terminal consumer applies its own bounded backpressure.
		}
	}

	return nil
}

// decodeOctalEscapes converts \NNN octal sequences to bytes
func decodeOctalEscapes(s string) []byte {
	var result []byte
	i := 0
	for i < len(s) {
		if s[i] == '\\' && i+1 < len(s) {
			if s[i+1] == '\\' {
				result = append(result, '\\')
				i += 2
				continue
			}
			// Try 3-digit octal
			if i+4 <= len(s) && isOctalDigit(s[i+1]) && isOctalDigit(s[i+2]) && isOctalDigit(s[i+3]) {
				oct := s[i+1 : i+4]
				val := 0
				for _, c := range oct {
					val = val*8 + int(c-'0')
				}
				result = append(result, byte(val))
				i += 4
				continue
			}
		}
		result = append(result, s[i])
		i++
	}
	return result
}

func isOctalDigit(c byte) bool {
	return c >= '0' && c <= '7'
}

func concatenateLines(lines []string) []byte {
	if len(lines) == 0 {
		return []byte{}
	}
	return []byte(strings.Join(lines, "\n"))
}

// SubmitCommand enqueues a command (FIFO)
func (p *Parser) SubmitCommand(cmdLine string) (chan *CommandResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	cmdID := fmt.Sprintf("%d_%d", time.Now().Unix()*1000000, p.cmdCounter)
	p.cmdCounter++

	resultChan := make(chan *CommandResult, 1)
	cmd := &ControlCommand{
		Command:    cmdLine,
		ID:         cmdID,
		Result:     &CommandResult{CommandID: cmdID},
		resultChan: resultChan,
	}

	p.cmdQueue = append(p.cmdQueue, cmd)
	return resultChan, nil
}

// SubscribePaneOutput returns the normal bounded live-output channel.
func (p *Parser) SubscribePaneOutput(paneID string) <-chan paneOutput {
	p.mu.Lock()
	defer p.mu.Unlock()
	ch := p.paneOutputCh[paneID]
	if ch == nil {
		ch = make(chan paneOutput, 16)
		p.paneOutputCh[paneID] = ch
	}
	return ch
}

// BeginPaneCapture starts lossless temporary buffering for one pane and
// returns its live channel. FinishPaneCapture atomically hands off to ch.
func (p *Parser) BeginPaneCapture(paneID string) <-chan paneOutput {
	p.mu.Lock()
	defer p.mu.Unlock()
	ch := p.paneOutputCh[paneID]
	if ch == nil {
		ch = make(chan paneOutput, 16)
		p.paneOutputCh[paneID] = ch
	}
	p.captureOutputs[paneID] = nil
	return ch
}

func (p *Parser) FinishPaneCapture(paneID string, sequence uint64, attach func([]byte) error) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	events := p.captureOutputs[paneID]
	var pending []byte
	for _, event := range events {
		if event.sequence > sequence {
			pending = append(pending, event.payload...)
		}
	}
	err := attach(pending)
	delete(p.captureOutputs, paneID)
	return err
}

func (p *Parser) AbortPaneCapture(paneID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.captureOutputs, paneID)
}

// GetNotifications returns notification channel
// Ready closes after the initial uncorrelated control block completes.
func (p *Parser) Ready() <-chan struct{} { return p.ready }

func (p *Parser) GetNotifications() <-chan NotificationEvent {
	return p.notifyChan
}

// Close shuts down parser
func (p *Parser) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.closed = true

	for _, cmd := range p.cmdQueue {
		cmd.Result = &CommandResult{CommandID: cmd.ID, Error: &ControlError{Code: "closed", Message: "parser closed"}}
		cmd.resultChan <- cmd.Result
		close(cmd.resultChan)
	}
	p.cmdQueue = p.cmdQueue[:0]

	if p.currentCmd != nil {
		p.currentCmd.Result = &CommandResult{CommandID: p.currentCmd.ID, Error: &ControlError{Code: "closed", Message: "parser closed"}}
		p.currentCmd.resultChan <- p.currentCmd.Result
		close(p.currentCmd.resultChan)
		p.currentCmd = nil
	}

	for _, ch := range p.paneOutputCh {
		close(ch)
	}
	p.paneOutputCh = make(map[string]chan paneOutput)

	return nil
}

func (p *Parser) Closed() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.closed
}
