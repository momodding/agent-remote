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

func TestSubscribeReceivesCommittedRuntimeEvent(t *testing.T) {
	s := makeTestDB(t)
	events := make(chan Event, 1)
	defer s.Subscribe(func(event Event) { events <- event })()
	term := TerminalSummary{ID: "t1", Name: "shell", CWD: "/workspace", CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := s.RecordTerminal(term, "terminal.created"); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-events:
		if event.Cursor == 0 || event.SurfaceID != term.ID || event.Kind != "terminal.created" {
			t.Fatalf("unexpected event: %+v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("did not receive committed event")
	}
}

func TestRemoveTerminalRemovesSnapshotProjection(t *testing.T) {
	s := makeTestDB(t)
	now := time.Now().UTC()
	if err := s.RecordTerminal(TerminalSummary{ID: "terminal", Name: "shell", CWD: "/workspace", CreatedAt: now, UpdatedAt: now}, "terminal.created"); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveTerminal("terminal"); err != nil {
		t.Fatal(err)
	}
	snapshot, err := s.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Terminals) != 0 {
		t.Fatalf("terminals = %+v", snapshot.Terminals)
	}
	events, _, err := s.Events(0, 10)
	if err != nil || len(events) != 2 || events[1].Kind != "terminal.removed" {
		t.Fatalf("events = %+v, err=%v", events, err)
	}
}
func TestRecordAgentSnapshotAndEvents(t *testing.T) {
	s := makeTestDB(t)
	now := time.Now().UTC()
	agent := AgentSummary{ID: "a1", Adapter: "omp", TerminalSessionID: "t1", CWD: "/workspace", State: "idle", Capabilities: []byte(`[{"name":"chat","enabled":true}]`), CreatedAt: now, UpdatedAt: now}
	if err := s.RecordAgent(agent, "agent.created"); err != nil {
		t.Fatalf("record: %v", err)
	}
	snapshot, err := s.Snapshot()
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if len(snapshot.Agents) != 1 || snapshot.Agents[0].ID != agent.ID || snapshot.Agents[0].TerminalSessionID != agent.TerminalSessionID {
		t.Fatalf("unexpected snapshot: %+v", snapshot.Agents)
	}
	events, _, err := s.Events(snapshot.Cursor-1, 1)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	if len(events) != 1 || events[0].Kind != "agent.created" {
		t.Fatalf("unexpected events: %+v", events)
	}
}

func TestRecordTopologySnapshotAndEvents(t *testing.T) {
	s := makeTestDB(t)
	now := time.Now().UTC()
	pane := TopologyPane{TerminalSessionID: "t1", ServerID: "server", SessionID: "$1", WindowID: "@1", PaneID: "%1", SessionName: "main", WindowName: "shell", CWD: "/workspace", Active: true, UpdatedAt: now}
	if err := s.RecordTopology([]TopologyPane{pane}); err != nil {
		t.Fatalf("record: %v", err)
	}
	snapshot, err := s.Snapshot()
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if len(snapshot.Topology) != 1 || snapshot.Topology[0].PaneID != pane.PaneID || !snapshot.Topology[0].Active {
		t.Fatalf("unexpected topology: %+v", snapshot.Topology)
	}
	events, _, err := s.Events(snapshot.Cursor-1, 1)
	if err != nil || len(events) != 1 || events[0].Kind != "tmux.topology" {
		t.Fatalf("unexpected events: %+v, err=%v", events, err)
	}
}

func TestRecordTopologyKeepsSamePaneIDFromDifferentServers(t *testing.T) {
	s := makeTestDB(t)
	now := time.Now().UTC()
	panes := []TopologyPane{
		{TerminalSessionID: "t1", ServerID: "server-a", SessionID: "$1", WindowID: "@1", PaneID: "%1", SessionName: "a", WindowName: "shell", CWD: "/a", UpdatedAt: now},
		{TerminalSessionID: "t2", ServerID: "server-b", SessionID: "$1", WindowID: "@1", PaneID: "%1", SessionName: "b", WindowName: "shell", CWD: "/b", UpdatedAt: now},
	}
	if err := s.RecordTopology(panes); err != nil {
		t.Fatal(err)
	}
	snapshot, err := s.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Topology) != 2 {
		t.Fatalf("topology = %+v, want both servers", snapshot.Topology)
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
