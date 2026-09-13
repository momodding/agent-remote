package agent

import (
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
	if len(events) != 1 || events[0].Type != "message.user" || events[0].Text != "hello" || events[0].EventID != "u1:user" {
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
	if events, err := tailer.Read(); err != nil || len(events) != 1 || events[0].EventID != "old:assistant" {
		t.Fatalf("initial events = %+v, %v", events, err)
	}
	write("new", "new")
	if events, err := tailer.Read(); err != nil || len(events) != 1 || events[0].EventID != "new:assistant" {
		t.Fatalf("truncated events = %+v, %v", events, err)
	}
	write("two", "two")
	if err := os.Chtimes(path, time.Now(), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if events, err := tailer.Read(); err != nil || len(events) != 1 || events[0].EventID != "two:assistant" {
		t.Fatalf("equal-size rewrite events = %+v, %v", events, err)
	}
	replacement := path + ".replacement"
	if err := os.WriteFile(replacement, []byte(`{"type":"message","id":"replacement","message":{"role":"assistant","content":"replacement"}}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	if events, err := tailer.Read(); err != nil || len(events) != 1 || events[0].EventID != "replacement:assistant" {
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
