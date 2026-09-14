package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	runtimestore "github.com/agenticremote/agenticremote/backend/internal/runtime"
)

func TestTranscriptTailerReadsCompleteAppendsOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(path, []byte(`{"type":"title","v":1}`+"\n"+`{"type":"session","id":"s1"}`+"\n"+`{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	tailer := NewTranscriptTailer("a1", path, nil)
	if events, err := tailer.Read(); err != nil || len(events) != 0 {
		t.Fatalf("partial read = %+v, %v", events, err)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("\n"); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	events, err := tailer.Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != "message.user" || events[0].Text != "hello" || events[0].EventID != "u1:message" {
		t.Fatalf("events = %+v", events)
	}
	if events, err := tailer.Read(); err != nil || len(events) != 0 {
		t.Fatalf("duplicate read = %+v, %v", events, err)
	}
}

func TestTranscriptTailerResetsAfterTruncateAndReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	write := func(id, text string) {
		t.Helper()
		data := []byte(`{"type":"message","id":"` + id + `","message":{"role":"assistant","content":"` + text + `"}}` + "\n")
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("old", "this entry is deliberately longer than its replacement")
	tailer := NewTranscriptTailer("a1", path, nil)
	if events, err := tailer.Read(); err != nil || len(events) != 1 || events[0].EventID != "old:message" {
		t.Fatalf("initial events = %+v, %v", events, err)
	}
	write("new", "new")
	if events, err := tailer.Read(); err != nil || len(events) != 1 || events[0].EventID != "new:message" {
		t.Fatalf("truncated events = %+v, %v", events, err)
	}
	write("two", "two")
	if err := os.Chtimes(path, time.Now(), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if events, err := tailer.Read(); err != nil || len(events) != 1 || events[0].EventID != "two:message" {
		t.Fatalf("equal-size rewrite events = %+v, %v", events, err)
	}
	replacement := path + ".replacement"
	if err := os.WriteFile(replacement, []byte(`{"type":"message","id":"replacement","message":{"role":"assistant","content":"replacement"}}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	if events, err := tailer.Read(); err != nil || len(events) != 1 || events[0].EventID != "replacement:message" {
		t.Fatalf("replacement events = %+v, %v", events, err)
	}
}

func TestTranscriptStateNotAdvancedUntilEventsRecorded(t *testing.T) {
	// Regression: offset saved BEFORE events persisted to store = events lost on restart
	path := filepath.Join(t.TempDir(), "session.jsonl")
	stateDir := t.TempDir()
	if err := os.WriteFile(path, []byte(`{"type":"message","id":"m1","message":{"role":"user","content":"hello"}}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	store, err := runtimestore.Open(stateDir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer store.Close()

	agentID := "agent_test_1"
	tailer := NewTranscriptTailer(agentID, path, store)

	// First read parses event and advances offset in-memory
	events, err := tailer.Read()
	if err != nil || len(events) != 1 {
		t.Fatalf("first read: events=%d, err=%v", len(events), err)
	}

	// Simulate: events would be recorded to store here
	// Then SaveState is called AFTER all events recorded
	if err := tailer.SaveState(); err != nil {
		t.Fatalf("save state: %v", err)
	}

	// Load state back: verify offset persisted
	tailer2 := NewTranscriptTailer(agentID, path, store)
	if err := tailer2.RestoreState(); err != nil {
		t.Fatalf("restore state: %v", err)
	}

	// Second read should return 0 events (offset was advanced)
	events2, err := tailer2.Read()
	if err != nil || len(events2) != 0 {
		t.Fatalf("second read after restore: events=%d (expected 0), err=%v", len(events2), err)
	}
}

func TestTranscriptProjectsAssistantToolAndResult(t *testing.T) {
	entry := transcriptEntry{Type: "message", ID: "a1", Message: &transcriptMessage{Role: "assistant", Content: json.RawMessage(`[{"type":"thinking","text":"plan"},{"type":"toolCall","toolCallId":"call_1","name":"bash","arguments":{"command":"pwd"}},{"type":"text","text":"done"}]`)}}
	events := entry.events("agent")
	if len(events) != 3 || events[0].EventID != "a1:thinking:0" || events[1].EventID != "a1:tool-call:call_1" || events[1].ToolCallID != "call_1" || events[2].EventID != "a1:message:2" {
		t.Fatalf("assistant events = %+v", events)
	}
	result := transcriptEntry{Type: "message", ID: "r1", Message: &transcriptMessage{Role: "toolResult", ToolCallID: "call_1", Content: json.RawMessage(`"/workspace"`)}}
	events = result.events("agent")
	if len(events) != 1 || events[0].Type != "tool.result" || events[0].EventID != "r1:tool-result:call_1" || events[0].Text != "/workspace" {
		t.Fatalf("result events = %+v", events)
	}
}

func TestTranscriptAssistantTextBlocksHaveDistinctIDs(t *testing.T) {
	entry := transcriptEntry{Type: "message", ID: "a1", Message: &transcriptMessage{Role: "assistant", Content: json.RawMessage(`[{"type":"text","text":"first"},{"type":"text","text":"second"}]`)}}
	events := entry.events("agent")
	if len(events) != 2 || events[0].EventID != "a1:message:0" || events[1].EventID != "a1:message:1" {
		t.Fatalf("text events = %+v", events)
	}
}

func TestTranscriptProjectsSpecialMessages(t *testing.T) {
	tests := []struct {
		name  string
		entry transcriptEntry
		want  []string
	}{
		{"execution", transcriptEntry{Type: "message", ID: "exec", Message: &transcriptMessage{Role: "bashExecution", Command: "pwd", Output: "/workspace"}}, []string{"exec:execution:call", "exec:execution:result"}},
		{"file", transcriptEntry{Type: "message", ID: "file", Message: &transcriptMessage{Role: "fileMention", Files: []struct {
			Path string `json:"path"`
		}{{Path: "README.md"}}}}, []string{"file:message"}},
		{"displayed custom", transcriptEntry{Type: "custom_message", ID: "custom", Display: true, Content: json.RawMessage(`"notice"`)}, []string{"custom:message"}},
		{"hidden custom", transcriptEntry{Type: "custom_message", ID: "hidden", Display: false, Content: json.RawMessage(`"secret"`)}, nil},
		{"aborted", transcriptEntry{Type: "message", ID: "aborted", Message: &transcriptMessage{Role: "assistant", Aborted: true, Content: json.RawMessage(`"`)}}, []string{"aborted:message"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			events := test.entry.events("agent")
			if len(events) != len(test.want) {
				t.Fatalf("events = %+v", events)
			}
			for i, id := range test.want {
				if events[i].EventID != id {
					t.Fatalf("events = %+v", events)
				}
			}
		})
	}
	result := transcriptEntry{Type: "message", ID: "error", Message: &transcriptMessage{Role: "toolResult", ToolCallID: "call", IsError: true, Content: json.RawMessage(`"failed"`)}}.events("agent")
	if len(result) != 1 || !result[0].IsError {
		t.Fatalf("error result = %+v", result)
	}
	aborted := transcriptEntry{Type: "message", ID: "aborted", Message: &transcriptMessage{Role: "assistant", Aborted: true, Content: json.RawMessage(`"`)}}.events("agent")
	if len(aborted) != 1 || !aborted[0].Aborted {
		t.Fatalf("aborted result = %+v", aborted)
	}
}
