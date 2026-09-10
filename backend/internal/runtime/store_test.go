package runtime

import (
	"testing"
	"time"
)

func makeTestDB(t *testing.T) *Store {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return s
}

func TestOpenMigrateAndClose(t *testing.T) {
	s := makeTestDB(t)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestRecordTerminalSnapshotAndEvents(t *testing.T) {
	s := makeTestDB(t)
	term := TerminalSummary{ID: "t1", Name: "foo", CWD: "/home/test", Seq: 1, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := s.RecordTerminal(term, "terminal.created"); err != nil {
		t.Fatalf("record: %v", err)
	}
	snapshot, err := s.Snapshot()
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if len(snapshot.Terminals) != 1 || snapshot.Terminals[0].ID != term.ID || snapshot.Cursor == 0 {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}
	events, cursor, err := s.Events(0, 1)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	if len(events) != 1 || cursor != events[0].Cursor || events[0].Kind != "terminal.created" {
		t.Fatalf("unexpected events: %+v, cursor=%d", events, cursor)
	}
}

func TestOpenReusesAppliedMigration(t *testing.T) {
	dir := t.TempDir()
	first, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
}
