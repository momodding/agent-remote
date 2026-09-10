package agent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTranscriptTailerReadsCompleteAppendsOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(path, []byte(`{"type":"title","v":1}`+"\n"+`{"type":"session","id":"s1"}`+"\n"+`{"type":"message","id":"u1","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	tailer := NewTranscriptTailer("a1", path)
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
	if len(events) != 1 || events[0].Type != "message.user" || events[0].Text != "hello" {
		t.Fatalf("events = %+v", events)
	}
	if events, err := tailer.Read(); err != nil || len(events) != 0 {
		t.Fatalf("duplicate read = %+v, %v", events, err)
	}
}
