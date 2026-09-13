package agent

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
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
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type transcriptContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func (e transcriptEntry) events(agentID string) []protocol.AgentEvent {
	if e.Type != "message" || e.Message == nil || e.ID == "" {
		return nil
	}
	text, _ := transcriptText(e.Message.Content)
	if text == "" {
		return nil
	}
	role := e.Message.Role
	if role == "" {
		role = "user"
	}
	return []protocol.AgentEvent{{
		Type:      "message." + role,
		EventID:   e.ID + ":" + role,
		AgentID:   agentID,
		MessageID: e.ID,
		Text:      text,
	}}
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
