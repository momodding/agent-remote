package agent

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strconv"
	"syscall"

	"github.com/agenticremote/agenticremote/backend/internal/protocol"
	runtimestore "github.com/agenticremote/agenticremote/backend/internal/runtime"
)

type TranscriptTailer struct {
	agentID   string
	path      string
	offset    int64
	pending   []byte
	seen      map[string]struct{}
	store     *runtimestore.Store
	lastInode uint64
	lastSize  int64
	lastMtime int64
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
		t.offset, t.pending, t.seen = 0, nil, map[string]struct{}{}
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

	// ponytail: offset persisted by caller after all semantic events recorded.
	return events, nil
}

// SaveState persists current offset and file state to durable storage.
// Called after all semantic events from this read have been recorded to the store.
func (t *TranscriptTailer) SaveState() error {
	if t.store == nil {
		return nil
	}
	return t.store.SaveTranscriptState(t.agentID, t.path, t.offset, t.lastInode, t.lastSize, t.lastMtime)
}

type transcriptEntry struct {
	Type    string             `json:"type"`
	ID      string             `json:"id"`
	Message *transcriptMessage `json:"message,omitempty"`
}

type transcriptMessage struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	ToolCallID string          `json:"toolCallId"`
	ToolName   string          `json:"toolName"`
	IsError    bool            `json:"isError"`
	Aborted    bool            `json:"aborted"`
}

type transcriptContent struct {
	Type       string          `json:"type"`
	Text       string          `json:"text"`
	ToolCallID string          `json:"toolCallId"`
	Name       string          `json:"name"`
	Arguments  json.RawMessage `json:"arguments"`
}

func (e transcriptEntry) events(agentID string) []protocol.AgentEvent {
	if e.Type != "message" || e.Message == nil || e.ID == "" {
		return nil
	}
	message := e.Message
	text, contents := transcriptText(message.Content)
	if message.Role == "toolResult" {
		if message.ToolCallID == "" {
			return nil
		}
		return []protocol.AgentEvent{{Type: "tool.result", EventID: e.ID + ":tool-result:" + message.ToolCallID, AgentID: agentID, MessageID: e.ID, ToolCallID: message.ToolCallID, Text: text, ToolOutput: text}}
	}
	role := message.Role
	if role == "" {
		role = "user"
	}
	if role != "assistant" || len(contents) == 0 {
		if text == "" && !(role == "assistant" && message.Aborted) {
			return nil
		}
		return []protocol.AgentEvent{{Type: "message." + role, EventID: e.ID + ":message", AgentID: agentID, MessageID: e.ID, Text: text}}
	}
	events := make([]protocol.AgentEvent, 0, len(contents))
	for index, content := range contents {
		switch content.Type {
		case "text":
			if content.Text != "" || message.Aborted {
				events = append(events, protocol.AgentEvent{Type: "message.assistant", EventID: e.ID + ":message:" + strconv.Itoa(index), AgentID: agentID, MessageID: e.ID, Text: content.Text})
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
