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
		{"displayed custom nested", transcriptEntry{Type: "message", ID: "c_vis", Message: &transcriptMessage{Role: "custom", Display: true, Content: json.RawMessage(`"custom info"`)}}, []string{"c_vis:message"}},
		{"hidden custom nested", transcriptEntry{Type: "message", ID: "c_hid", Message: &transcriptMessage{Role: "custom", Display: false, Content: json.RawMessage(`"custom hidden"`)}}, nil},
		{"custom omitted display", transcriptEntry{Type: "message", ID: "c_none", Message: &transcriptMessage{Role: "custom", Content: json.RawMessage(`"custom omitted"`)}}, nil},
		{"displayed hook", transcriptEntry{Type: "message", ID: "h_vis", Message: &transcriptMessage{Role: "hookMessage", Display: true, Content: json.RawMessage(`"hook info"`)}}, []string{"h_vis:message"}},
		{"hidden hook", transcriptEntry{Type: "message", ID: "h_hid", Message: &transcriptMessage{Role: "hookMessage", Display: false, Content: json.RawMessage(`"hook hidden"`)}}, nil},
		{"hook omitted display", transcriptEntry{Type: "message", ID: "h_none", Message: &transcriptMessage{Role: "hookMessage", Content: json.RawMessage(`"hook omitted"`)}}, nil},
		{"aborted", transcriptEntry{Type: "message", ID: "aborted", Message: &transcriptMessage{Role: "assistant", Aborted: true, Content: json.RawMessage(`"`)}}, []string{"aborted:message"}},
		{"aborted stopReason", transcriptEntry{Type: "message", ID: "aborted_stop", Message: &transcriptMessage{Role: "assistant", StopReason: "aborted", Content: json.RawMessage(`""`)}}, []string{"aborted_stop:message"}},
		{"aborted stopReason empty turn", transcriptEntry{Type: "message", ID: "aborted_empty", Message: &transcriptMessage{Role: "assistant", StopReason: "aborted"}}, []string{"aborted_empty:message"}},
		{"aborted stopReason structured blocks", transcriptEntry{Type: "message", ID: "aborted_blocks", Message: &transcriptMessage{Role: "assistant", StopReason: "aborted", Content: json.RawMessage(`[{"type":"text","text":"halted"}]`)}}, []string{"aborted_blocks:message:0"}},
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
			if test.name == "execution" {
				if raw, ok := events[0].ToolInput.(json.RawMessage); !ok || string(raw) != `{"command":"pwd"}` {
					t.Fatalf("execution ToolInput = %v (%T), want json.RawMessage", events[0].ToolInput, events[0].ToolInput)
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

	abortedStop := transcriptEntry{Type: "message", ID: "a_stop", Message: &transcriptMessage{Role: "assistant", StopReason: "aborted"}}.events("agent")
	if len(abortedStop) != 1 || !abortedStop[0].Aborted {
		t.Fatalf("abortedStop result = %+v", abortedStop)
	}
}

func TestTranscriptTailerPartialWritesBeforeNewline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	tailer := NewTranscriptTailer("a1", path, nil)

	// write #1
	if _, err := f.WriteString(`{"type":"message"`); err != nil {
		t.Fatal(err)
	}
	events, err := tailer.Read()
	if err != nil || len(events) != 0 {
		t.Fatalf("write #1: events=%+v, err=%v", events, err)
	}

	// write #2
	if _, err := f.WriteString(`,"id":"m1"`); err != nil {
		t.Fatal(err)
	}
	events, err = tailer.Read()
	if err != nil || len(events) != 0 {
		t.Fatalf("write #2: events=%+v, err=%v", events, err)
	}

	// write #3
	if _, err := f.WriteString(`,"message":{"role":"user","content":"hello"}}`); err != nil {
		t.Fatal(err)
	}
	events, err = tailer.Read()
	if err != nil || len(events) != 0 {
		t.Fatalf("write #3: events=%+v, err=%v", events, err)
	}

	// write #4
	if _, err := f.WriteString("\n"); err != nil {
		t.Fatal(err)
	}
	events, err = tailer.Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("write #4: expected 1 event, got %d: %+v", len(events), events)
	}
	if events[0].EventID != "m1:message" {
		t.Fatalf("expected EventID 'm1:message', got %q", events[0].EventID)
	}
	if events[0].Text != "hello" {
		t.Fatalf("expected Text 'hello', got %q", events[0].Text)
	}

	// Read again -> 0 events
	events, err = tailer.Read()
	if err != nil || len(events) != 0 {
		t.Fatalf("read after completion: events=%+v, err=%v", events, err)
	}
}

func TestTranscriptTailerByteByByteGrowth(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	tailer := NewTranscriptTailer("a1", path, nil)
	payload := []byte(`{"type":"message","id":"b1","message":{"role":"user","content":"byte-by-byte"}}` + "\n")

	for i, b := range payload {
		if _, err := f.Write([]byte{b}); err != nil {
			t.Fatal(err)
		}
		events, err := tailer.Read()
		if err != nil {
			t.Fatalf("byte %d (%c): err=%v", i, b, err)
		}
		if i < len(payload)-1 {
			if len(events) != 0 {
				t.Fatalf("byte %d: expected 0 events, got %d", i, len(events))
			}
		} else {
			if len(events) != 1 {
				t.Fatalf("final byte: expected 1 event, got %d", len(events))
			}
			if events[0].EventID != "b1:message" {
				t.Fatalf("expected EventID 'b1:message', got %q", events[0].EventID)
			}
			if events[0].Text != "byte-by-byte" {
				t.Fatalf("expected Text 'byte-by-byte', got %q", events[0].Text)
			}
		}
	}

	events, err := tailer.Read()
	if err != nil || len(events) != 0 {
		t.Fatalf("expected 0 events after complete line, got %+v, %v", events, err)
	}
}

func TestTranscriptTailerMultiplePartialWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	tailer := NewTranscriptTailer("a1", path, nil)
	chunks := []string{
		`{"type":"message",`,
		`"id":"m2",`,
		`"message":{"role":"user",`,
		`"content":"multiple chunks"}}`,
		"\n",
	}

	for i, chunk := range chunks {
		if _, err := f.WriteString(chunk); err != nil {
			t.Fatal(err)
		}
		events, err := tailer.Read()
		if err != nil {
			t.Fatalf("chunk %d: err=%v", i, err)
		}
		if i < len(chunks)-1 {
			if len(events) != 0 {
				t.Fatalf("chunk %d: expected 0 events, got %d", i, len(events))
			}
		} else {
			if len(events) != 1 {
				t.Fatalf("chunk %d: expected 1 event, got %d", i, len(events))
			}
			if events[0].EventID != "m2:message" || events[0].Text != "multiple chunks" {
				t.Fatalf("unexpected event: %+v", events[0])
			}
		}
	}
}

func TestTranscriptTailerUTF8SplitAcrossWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	tailer := NewTranscriptTailer("a1", path, nil)
	chunk1 := []byte(`{"type":"message","id":"u1","message":{"role":"user","content":"caf` + "\xc3")
	chunk2 := []byte("\xa9 and \xe6\x97")
	chunk3 := []byte("\xa5\xe6\x9c\xac\xe8\xaa\x9e\"}}\n")

	if _, err := f.Write(chunk1); err != nil {
		t.Fatal(err)
	}
	events, err := tailer.Read()
	if err != nil || len(events) != 0 {
		t.Fatalf("chunk1: events=%+v, err=%v", events, err)
	}

	if _, err := f.Write(chunk2); err != nil {
		t.Fatal(err)
	}
	events, err = tailer.Read()
	if err != nil || len(events) != 0 {
		t.Fatalf("chunk2: events=%+v, err=%v", events, err)
	}

	if _, err := f.Write(chunk3); err != nil {
		t.Fatal(err)
	}
	events, err = tailer.Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].EventID != "u1:message" {
		t.Fatalf("expected EventID 'u1:message', got %q", events[0].EventID)
	}
	if events[0].Text != "café and 日本語" {
		t.Fatalf("expected Text 'café and 日本語', got %q", events[0].Text)
	}
}

func TestTranscriptTailerNewlineInSeparateWrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	tailer := NewTranscriptTailer("a1", path, nil)

	if _, err := f.WriteString(`{"type":"message","id":"nl1","message":{"role":"user","content":"nonewline"}}`); err != nil {
		t.Fatal(err)
	}
	events, err := tailer.Read()
	if err != nil || len(events) != 0 {
		t.Fatalf("expected 0 events, got %+v, %v", events, err)
	}

	if _, err := f.WriteString("\n"); err != nil {
		t.Fatal(err)
	}
	events, err = tailer.Read()
	if err != nil || len(events) != 1 {
		t.Fatalf("expected 1 event, got %+v, %v", events, err)
	}
	if events[0].EventID != "nl1:message" || events[0].Text != "nonewline" {
		t.Fatalf("unexpected event: %+v", events[0])
	}
}

func TestTranscriptTailerCompleteLineFollowedByPartialLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	tailer := NewTranscriptTailer("a1", path, nil)

	line1 := `{"type":"message","id":"c1","message":{"role":"user","content":"first"}}` + "\n"
	line2Part := `{"type":"message","id":"c2","message":{"role":"user","content":"sec`

	if _, err := f.WriteString(line1 + line2Part); err != nil {
		t.Fatal(err)
	}

	events, err := tailer.Read()
	if err != nil || len(events) != 1 {
		t.Fatalf("expected 1 event for line 1, got %+v, %v", events, err)
	}
	if events[0].EventID != "c1:message" || events[0].Text != "first" {
		t.Fatalf("unexpected event for line 1: %+v", events[0])
	}

	events, err = tailer.Read()
	if err != nil || len(events) != 0 {
		t.Fatalf("expected 0 events for partial line 2, got %+v, %v", events, err)
	}

	if _, err := f.WriteString(`ond"}}` + "\n"); err != nil {
		t.Fatal(err)
	}

	events, err = tailer.Read()
	if err != nil || len(events) != 1 {
		t.Fatalf("expected 1 event for line 2, got %+v, %v", events, err)
	}
	if events[0].EventID != "c2:message" || events[0].Text != "second" {
		t.Fatalf("unexpected event for line 2: %+v", events[0])
	}
}

func TestTranscriptTailerTruncateWhilePartialBytesExist(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	tailer := NewTranscriptTailer("a1", path, nil)

	if err := os.WriteFile(path, []byte(`{"type":"message","id":"part","message":{"role":"user","content":"partial`), 0o644); err != nil {
		t.Fatal(err)
	}
	events, err := tailer.Read()
	if err != nil || len(events) != 0 {
		t.Fatalf("expected 0 events, got %+v, %v", events, err)
	}

	if err := os.WriteFile(path, []byte(`{"type":"message","id":"t1","message":{"role":"user","content":"after truncate"}}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	events, err = tailer.Read()
	if err != nil || len(events) != 1 {
		t.Fatalf("expected 1 event, got %+v, %v", events, err)
	}
	if events[0].EventID != "t1:message" || events[0].Text != "after truncate" {
		t.Fatalf("unexpected event: %+v", events[0])
	}
}

func TestTranscriptTailerInodeChangeWhilePartialBytesExist(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	tailer := NewTranscriptTailer("a1", path, nil)

	if err := os.WriteFile(path, []byte(`{"type":"message","id":"part`), 0o644); err != nil {
		t.Fatal(err)
	}
	events, err := tailer.Read()
	if err != nil || len(events) != 0 {
		t.Fatalf("expected 0 events, got %+v, %v", events, err)
	}

	replacement := filepath.Join(dir, "replacement.jsonl")
	if err := os.WriteFile(replacement, []byte(`{"type":"message","id":"i1","message":{"role":"user","content":"new inode"}}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}

	events, err = tailer.Read()
	if err != nil || len(events) != 1 {
		t.Fatalf("expected 1 event, got %+v, %v", events, err)
	}
	if events[0].EventID != "i1:message" || events[0].Text != "new inode" {
		t.Fatalf("unexpected event: %+v", events[0])
	}
}

func TestTranscriptTailerEqualSizeRewriteDetection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	tailer := NewTranscriptTailer("a1", path, nil)

	line1 := []byte(`{"type":"message","id":"e1","message":{"role":"user","content":"aaaa"}}` + "\n")
	line2 := []byte(`{"type":"message","id":"e2","message":{"role":"user","content":"bbbb"}}` + "\n")
	if len(line1) != len(line2) {
		t.Fatalf("line lengths must match: %d vs %d", len(line1), len(line2))
	}

	if err := os.WriteFile(path, line1, 0o644); err != nil {
		t.Fatal(err)
	}
	events, err := tailer.Read()
	if err != nil || len(events) != 1 || events[0].EventID != "e1:message" {
		t.Fatalf("expected e1 event, got %+v, %v", events, err)
	}

	if err := os.WriteFile(path, line2, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, time.Now(), time.Now().Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}

	events, err = tailer.Read()
	if err != nil || len(events) != 1 || events[0].EventID != "e2:message" {
		t.Fatalf("expected e2 event after rewrite, got %+v, %v", events, err)
	}
}

func TestTranscriptTailerInvalidJSONFollowedByValidLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	content := "{invalid json line\n" + `{"type":"message","id":"v1","message":{"role":"user","content":"valid"}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	tailer := NewTranscriptTailer("a1", path, nil)
	events, err := tailer.Read()
	if err != nil || len(events) != 1 {
		t.Fatalf("expected 1 event, got %+v, %v", events, err)
	}
	if events[0].EventID != "v1:message" || events[0].Text != "valid" {
		t.Fatalf("unexpected event: %+v", events[0])
	}

	events, err = tailer.Read()
	if err != nil || len(events) != 0 {
		t.Fatalf("expected 0 events on second read, got %+v, %v", events, err)
	}
}

func TestTranscriptTailerRepeatedReadsNoGrowth(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	content := `{"type":"message","id":"r1","message":{"role":"user","content":"hello"}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	tailer := NewTranscriptTailer("a1", path, nil)
	events, err := tailer.Read()
	if err != nil || len(events) != 1 || events[0].EventID != "r1:message" {
		t.Fatalf("first read: %+v, %v", events, err)
	}

	for i := range 10 {
		events, err := tailer.Read()
		if err != nil || len(events) != 0 {
			t.Fatalf("poll %d: expected 0 events, got %+v, %v", i, events, err)
		}
	}
}

func TestTranscriptTailerReconstructionBetweenWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	storeDir := t.TempDir()
	store, err := runtimestore.Open(storeDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	agentID := "agent_rec"
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	// Write partial line
	if _, err := f.WriteString(`{"type":"message","id":"rec1","message":{"role":"user","content":"resto`); err != nil {
		t.Fatal(err)
	}

	tailer1 := NewTranscriptTailer(agentID, path, store)
	events, err := tailer1.Read()
	if err != nil || len(events) != 0 {
		t.Fatalf("tailer1 read: %+v, %v", events, err)
	}
	if err := tailer1.SaveState(); err != nil {
		t.Fatal(err)
	}

	// Reconstruct tailer
	tailer2 := NewTranscriptTailer(agentID, path, store)
	if err := tailer2.RestoreState(); err != nil {
		t.Fatal(err)
	}

	// Append remaining bytes
	if _, err := f.WriteString(`red"}}` + "\n"); err != nil {
		t.Fatal(err)
	}

	events, err = tailer2.Read()
	if err != nil || len(events) != 1 {
		t.Fatalf("tailer2 read: expected 1 event, got %+v, %v", events, err)
	}
	if events[0].EventID != "rec1:message" || events[0].Text != "restored" {
		t.Fatalf("unexpected event: %+v", events[0])
	}

	events, err = tailer2.Read()
	if err != nil || len(events) != 0 {
		t.Fatalf("tailer2 subsequent read: %+v, %v", events, err)
	}
}

func TestTranscriptTailerAtomicCommitAndRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	storeDir := t.TempDir()
	store, err := runtimestore.Open(storeDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	agentID := "agent_atomic"
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	// Write line 1
	if _, err := f.WriteString(`{"type":"message","id":"m1","message":{"role":"user","content":"first"}}` + "\n"); err != nil {
		t.Fatal(err)
	}

	tailer := NewTranscriptTailer(agentID, path, store)
	events, err := tailer.Read()
	if err != nil || len(events) != 1 {
		t.Fatalf("first read: %+v, %v", events, err)
	}

	// Commit atomically with checkpoint
	inputs := []runtimestore.AgentTranscriptEvent{
		{EventID: events[0].EventID, Kind: events[0].Type, Payload: []byte(`{"text":"first"}`)},
	}
	committed, err := store.RecordAgentTranscript(agentID, inputs, tailer.checkpoint())
	if err != nil || len(committed) != 1 {
		t.Fatalf("record transcript: committed=%+v, err=%v", committed, err)
	}

	// Restart: create new tailer, restore state
	restartedTailer := NewTranscriptTailer(agentID, path, store)
	if err := restartedTailer.RestoreState(); err != nil {
		t.Fatal(err)
	}

	// Next read should return 0 events (m1 not duplicated)
	events, err = restartedTailer.Read()
	if err != nil || len(events) != 0 {
		t.Fatalf("restarted read: expected 0 events, got %+v, %v", events, err)
	}

	// Write line 2
	if _, err := f.WriteString(`{"type":"message","id":"m2","message":{"role":"user","content":"second"}}` + "\n"); err != nil {
		t.Fatal(err)
	}

	events, err = restartedTailer.Read()
	if err != nil || len(events) != 1 {
		t.Fatalf("second read: expected 1 event, got %+v, %v", events, err)
	}
	if events[0].EventID != "m2:message" || events[0].Text != "second" {
		t.Fatalf("unexpected event: %+v", events[0])
	}
}

func TestTranscriptTailerRestartBeforeNewline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	storeDir := t.TempDir()
	store, err := runtimestore.Open(storeDir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	agentID := "agent_restart_partial"
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	// Write partial line
	if _, err := f.WriteString(`{"type":"message","id":"p1","message":{"role":"user","content":"partial-before-restart`); err != nil {
		t.Fatal(err)
	}

	tailer1 := NewTranscriptTailer(agentID, path, store)
	events, err := tailer1.Read()
	if err != nil || len(events) != 0 {
		t.Fatalf("tailer1 read: %+v, %v", events, err)
	}

	// Process restarts without committing checkpoint (store state empty)
	tailer2 := NewTranscriptTailer(agentID, path, store)
	if err := tailer2.RestoreState(); err != nil {
		t.Fatal(err)
	}

	// Complete the line
	if _, err := f.WriteString(`"}}` + "\n"); err != nil {
		t.Fatal(err)
	}

	// Read on restarted tailer
	events, err = tailer2.Read()
	if err != nil || len(events) != 1 {
		t.Fatalf("tailer2 read: expected 1 event, got %+v, %v", events, err)
	}
	if events[0].EventID != "p1:message" || events[0].Text != "partial-before-restart" {
		t.Fatalf("unexpected event: %+v", events[0])
	}

	// Subsequent read returns 0
	events, err = tailer2.Read()
	if err != nil || len(events) != 0 {
		t.Fatalf("subsequent read: %+v, %v", events, err)
	}
}
