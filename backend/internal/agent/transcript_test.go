package agent

import (
	"os"
	"path/filepath"
	"testing"
	"time"
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
