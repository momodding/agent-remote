package agent

import (
	"bytes"
	"encoding/json"
	"io"
	"os"

	"github.com/agenticremote/agenticremote/backend/internal/protocol"
)

// TranscriptTailer projects complete OMP JSONL entries without reading terminal output.
type TranscriptTailer struct {
	agentID string
	path    string
	offset  int64
	pending []byte
	seen    map[string]struct{}
}

func NewTranscriptTailer(agentID, path string) *TranscriptTailer {
	return &TranscriptTailer{agentID: agentID, path: path, seen: map[string]struct{}{}}
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
	if info.Size() < t.offset {
		t.offset, t.pending, t.seen = 0, nil, map[string]struct{}{}
	}
	if _, err := file.Seek(t.offset, io.SeekStart); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return nil, err
	}
	t.offset += int64(len(data))
	data = append(t.pending, data...)
	lastNewline := bytes.LastIndexByte(data, '\n')
	if lastNewline < 0 {
		t.pending = data
		return nil, nil
	}
	lines := bytes.Split(data[:lastNewline], []byte("\n"))
	t.pending = append(t.pending[:0], data[lastNewline+1:]...)

	events := make([]protocol.AgentEvent, 0, len(lines))
	for _, line := range lines {
		entry := transcriptEntry{}
		if err := json.Unmarshal(line, &entry); err != nil || entry.Type != "message" || entry.ID == "" {
			continue
		}
		if _, ok := t.seen[entry.ID]; ok {
			continue
		}
		t.seen[entry.ID] = struct{}{}
		events = append(events, entry.events(t.agentID)...)
	}
	return events, nil
}

type transcriptEntry struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	Message json.RawMessage `json:"message"`
}

type transcriptMessage struct {
	Role     string          `json:"role"`
	Content  json.RawMessage `json:"content"`
	ToolName string          `json:"toolName"`
}

type transcriptContent struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

func (e transcriptEntry) events(agentID string) []protocol.AgentEvent {
	message := transcriptMessage{}
	if json.Unmarshal(e.Message, &message) != nil {
		return nil
	}
	text, blocks := transcriptText(message.Content)
	switch message.Role {
	case "user":
		if text != "" {
			return []protocol.AgentEvent{{Type: "message.user", AgentID: agentID, MessageID: e.ID, Text: text}}
		}
	case "assistant":
		events := make([]protocol.AgentEvent, 0, len(blocks)+1)
		if text != "" {
			events = append(events, protocol.AgentEvent{Type: "message.assistant", AgentID: agentID, MessageID: e.ID, Text: text})
		}
		for _, block := range blocks {
			if block.Type == "toolCall" {
				events = append(events, protocol.AgentEvent{Type: "tool.call", AgentID: agentID, MessageID: e.ID, ToolName: block.Name, ToolInput: json.RawMessage(block.Arguments)})
			}
		}
		return events
	case "toolResult":
		return []protocol.AgentEvent{{Type: "tool.result", AgentID: agentID, MessageID: e.ID, Text: text, ToolName: message.ToolName}}
	}
	return nil
}

func transcriptText(content json.RawMessage) (string, []transcriptContent) {
	var text string
	if json.Unmarshal(content, &text) == nil {
		return text, nil
	}
	var blocks []transcriptContent
	if json.Unmarshal(content, &blocks) != nil {
		return "", nil
	}
	var out string
	for _, block := range blocks {
		if block.Type != "text" {
			continue
		}
		out += block.Text
	}
	return out, blocks
}
