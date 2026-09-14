package agent

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"strconv"
	"strings"
	"syscall"

	"github.com/agenticremote/agenticremote/backend/internal/protocol"
	runtimestore "github.com/agenticremote/agenticremote/backend/internal/runtime"
)

type TranscriptTailer struct {
	agentID     string
	path        string
	offset      int64
	pending     []byte
	seen        map[string]struct{}
	store       *runtimestore.Store
	lastInode   uint64
	lastSize    int64
	lastMtime   int64
	fingerprint string
}

type tailerState struct {
	offset      int64
	pending     []byte
	seen        map[string]struct{}
	lastInode   uint64
	lastSize    int64
	lastMtime   int64
	fingerprint string
}

func (t *TranscriptTailer) snapshot() tailerState {
	seen := make(map[string]struct{}, len(t.seen))
	for id := range t.seen {
		seen[id] = struct{}{}
	}
	return tailerState{t.offset, append([]byte(nil), t.pending...), seen, t.lastInode, t.lastSize, t.lastMtime, t.fingerprint}
}

func (t *TranscriptTailer) restore(state tailerState) {
	t.offset, t.pending, t.seen, t.lastInode, t.lastSize, t.lastMtime, t.fingerprint = state.offset, state.pending, state.seen, state.lastInode, state.lastSize, state.lastMtime, state.fingerprint
}

func NewTranscriptTailer(agentID, path string, store *runtimestore.Store) *TranscriptTailer {
	return &TranscriptTailer{
		agentID: agentID,
		path:    path,
		store:   store,
		seen:    map[string]struct{}{},
	}
}

// RestoreState loads prior tailer state from persistent store
func (t *TranscriptTailer) RestoreState() error {
	if t.store == nil {
		return nil
	}
	ts, err := t.store.LoadTranscriptState(t.agentID)
	if err != nil {
		return err
	}
	if ts == nil {
		return nil
	}
	// Only restore if path matches (file may have moved)
	if ts.TranscriptPath != t.path {
		return nil
	}
	t.offset = ts.FileOffset
	t.lastInode = ts.FileInode
	t.lastSize = ts.FileSize
	t.lastMtime = ts.FileMtime
	t.fingerprint = ts.BoundaryFingerprint
	return nil
}

func (t *TranscriptTailer) Read() ([]protocol.AgentEvent, error) {
	file, err := os.Open(t.path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return nil, err
	}

	// Detect rotation: inode changed, size decreased, or mtime went backward
	stat := info.Sys().(*syscall.Stat_t)
	size := info.Size()
	mtime := info.ModTime().UnixNano()
	if t.lastInode != 0 && (stat.Ino != t.lastInode || size < t.offset || (t.lastMtime != 0 && mtime != t.lastMtime && size == t.lastSize)) {
		t.offset, t.pending, t.seen = 0, nil, map[string]struct{}{}
	}
	t.lastInode = stat.Ino
	t.lastSize = size
	t.lastMtime = mtime

	if size < t.offset {
		t.offset, t.pending, t.seen, t.fingerprint = 0, nil, map[string]struct{}{}, ""
	}
	if t.offset > 0 && t.fingerprint != "" {
		boundary := make([]byte, min(int(t.offset), 4096))
		if _, err := file.ReadAt(boundary, t.offset-int64(len(boundary))); err != nil {
			return nil, err
		}
		sum := sha256.Sum256(boundary)
		if hex.EncodeToString(sum[:]) != t.fingerprint {
			t.offset, t.pending, t.seen, t.fingerprint = 0, nil, map[string]struct{}{}, ""
		}
	}
	if _, err := file.Seek(t.offset, io.SeekStart); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return nil, err
	}

	oldPendingLen := int64(len(t.pending))
	data = append(t.pending, data...)
	lastNewline := bytes.LastIndexByte(data, '\n')
	if lastNewline < 0 {
		t.pending = data
		return nil, nil
	}
	lines := bytes.Split(data[:lastNewline], []byte("\n"))
	t.offset += int64(len(data)) - oldPendingLen
	t.pending = append(t.pending[:0], data[lastNewline+1:]...)
	events := make([]protocol.AgentEvent, 0, len(lines))
	for _, line := range lines {
		entry := transcriptEntry{}
		if err := json.Unmarshal(line, &entry); err != nil {
			continue
		}
		if entry.ID == "" {
			continue
		}
		if _, ok := t.seen[entry.ID]; ok {
			continue
		}
		t.seen[entry.ID] = struct{}{}
		events = append(events, entry.events(t.agentID)...)
	}

	boundary := make([]byte, min(int(t.offset), 4096))
	if len(boundary) > 0 {
		if _, err := file.ReadAt(boundary, t.offset-int64(len(boundary))); err != nil {
			return nil, err
		}
	}
	sum := sha256.Sum256(boundary)
	t.fingerprint = hex.EncodeToString(sum[:])
	// ponytail: offset persisted by caller after all semantic events recorded.
	return events, nil
}

// SaveState persists current offset and file state to durable storage.
// Called after all semantic events from this read have been recorded to the store.
func (t *TranscriptTailer) checkpoint() runtimestore.TranscriptState {
	return runtimestore.TranscriptState{AgentID: t.agentID, TranscriptPath: t.path, FileOffset: t.offset, FileInode: t.lastInode, FileSize: t.lastSize, FileMtime: t.lastMtime, BoundaryFingerprint: t.fingerprint}
}

func (t *TranscriptTailer) SaveState() error {
	if t.store == nil {
		return nil
	}
	return t.store.SaveTranscriptState(t.agentID, t.path, t.offset, t.lastInode, t.lastSize, t.lastMtime, t.fingerprint)
}

type transcriptEntry struct {
	Type    string             `json:"type"`
	ID      string             `json:"id"`
	Message *transcriptMessage `json:"message,omitempty"`
	Content json.RawMessage    `json:"content,omitempty"`
	Display bool               `json:"display,omitempty"`
}

type transcriptMessage struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	ToolCallID string          `json:"toolCallId"`
	ToolName   string          `json:"toolName"`
	Command    string          `json:"command"`
	Output     string          `json:"output"`
	Files      []struct {
		Path string `json:"path"`
	} `json:"files"`
	IsError    bool   `json:"isError"`
	Aborted    bool   `json:"aborted"`
	StopReason string `json:"stopReason"`
	Display    bool   `json:"display,omitempty"`
}

type transcriptContent struct {
	Type       string          `json:"type"`
	Text       string          `json:"text"`
	ToolCallID string          `json:"toolCallId"`
	Name       string          `json:"name"`
	Arguments  json.RawMessage `json:"arguments"`
}

func (e transcriptEntry) events(agentID string) []protocol.AgentEvent {
	if e.ID == "" {
		return nil
	}
	if e.Type == "custom_message" {
		isDisplayed := e.Display || (e.Message != nil && e.Message.Display)
		if !isDisplayed {
			return nil
		}
		text, _ := transcriptText(e.Content)
		if text == "" && e.Message != nil {
			text, _ = transcriptText(e.Message.Content)
		}
		if text == "" {
			return nil
		}
		return []protocol.AgentEvent{{Type: "message.system", EventID: e.ID + ":message", AgentID: agentID, MessageID: e.ID, Text: text}}
	}
	if e.Type != "message" || e.Message == nil {
		return nil
	}
	message := e.Message
	isDisplayed := e.Display || message.Display
	if (message.Role == "custom" || message.Role == "hookMessage") && !isDisplayed {
		return nil
	}
	text, contents := transcriptText(message.Content)
	if message.Role == "fileMention" && text == "" {
		for index, file := range message.Files {
			if index > 0 {
				text += "\n"
			}
			text += file.Path
		}
	}
	if message.Role == "toolResult" {
		if message.ToolCallID == "" {
			return nil
		}
		return []protocol.AgentEvent{{Type: "tool.result", EventID: e.ID + ":tool-result:" + message.ToolCallID, AgentID: agentID, MessageID: e.ID, ToolCallID: message.ToolCallID, Text: text, ToolOutput: text, IsError: message.IsError}}
	}
	if message.Role == "bashExecution" || message.Role == "pythonExecution" {
		input := map[string]string{"command": message.Command}
		return []protocol.AgentEvent{{Type: "tool.call", EventID: e.ID + ":execution:call", AgentID: agentID, MessageID: e.ID, ToolName: message.Role, ToolInput: input}, {Type: "tool.result", EventID: e.ID + ":execution:result", AgentID: agentID, MessageID: e.ID, ToolName: message.Role, Text: message.Output, ToolOutput: message.Output, IsError: message.IsError}}
	}
	role := message.Role
	if role == "" {
		role = "user"
	}
	if role == "fileMention" || role == "custom" || role == "hookMessage" {
		role = "system"
	}
	isAborted := message.Aborted || strings.EqualFold(message.StopReason, "aborted")
	if role != "assistant" || len(contents) == 0 {
		if text == "" && !(role == "assistant" && isAborted) {
			return nil
		}
		return []protocol.AgentEvent{{Type: "message." + role, EventID: e.ID + ":message", AgentID: agentID, MessageID: e.ID, Text: text, IsError: message.IsError, Aborted: isAborted}}
	}
	events := make([]protocol.AgentEvent, 0, len(contents))
	hasAssistant := false
	for index, content := range contents {
		switch content.Type {
		case "text":
			if content.Text != "" || isAborted {
				hasAssistant = true
				events = append(events, protocol.AgentEvent{Type: "message.assistant", EventID: e.ID + ":message:" + strconv.Itoa(index), AgentID: agentID, MessageID: e.ID, Text: content.Text, IsError: message.IsError, Aborted: isAborted})
			}
		case "thinking":
			if content.Text != "" {
				events = append(events, protocol.AgentEvent{Type: "message.thinking", EventID: e.ID + ":thinking:" + strconv.Itoa(index), AgentID: agentID, MessageID: e.ID, Text: content.Text})
			}
		case "toolCall":
			if content.ToolCallID != "" {
				events = append(events, protocol.AgentEvent{Type: "tool.call", EventID: e.ID + ":tool-call:" + content.ToolCallID, AgentID: agentID, MessageID: e.ID, ToolCallID: content.ToolCallID, ToolName: content.Name, ToolInput: json.RawMessage(content.Arguments)})
			}
		}
	}
	if isAborted && !hasAssistant {
		events = append(events, protocol.AgentEvent{Type: "message.assistant", EventID: e.ID + ":message", AgentID: agentID, MessageID: e.ID, IsError: message.IsError, Aborted: true})
	}
	return events
}

func transcriptText(content json.RawMessage) (string, []transcriptContent) {
	var text string
	if json.Unmarshal(content, &text) == nil {
		return text, nil
	}
	var contents []transcriptContent
	if err := json.Unmarshal(content, &contents); err != nil {
		return "", nil
	}
	for _, c := range contents {
		if c.Type == "text" {
			text += c.Text
		}
	}
	return text, contents
}
