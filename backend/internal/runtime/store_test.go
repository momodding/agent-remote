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
	t.Cleanup(func() { _ = s.Close() })
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

func TestSubscriberCanRecordEvent(t *testing.T) {
	s := makeTestDB(t)
	result := make(chan error, 1)
	var unsubscribe func()
	unsubscribe = s.Subscribe(func(Event) {
		unsubscribe()
		_, err := s.RecordEvent("nested", "agent.updated", "nested")
		result <- err
	})
	defer unsubscribe()

	go func() {
		_, err := s.RecordEvent("outer", "agent.updated", "outer")
		result <- err
	}()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("subscriber mutation deadlocked")
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("outer mutation did not finish")
	}
}

func TestSlowSubscriberDoesNotBlockWriters(t *testing.T) {
	s := makeTestDB(t)
	release := make(chan struct{})
	unsubscribe := s.Subscribe(func(Event) { <-release })
	defer unsubscribe()

	first := make(chan error, 1)
	go func() {
		_, err := s.RecordEvent("first", "agent.updated", "first")
		first <- err
	}()
	select {
	case err := <-first:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("first writer blocked on subscriber")
	}

	second := make(chan error, 1)
	go func() {
		_, err := s.RecordEvent("second", "agent.updated", "second")
		second <- err
	}()
	select {
	case err := <-second:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("slow subscriber blocked a later writer")
	}
	close(release)
}

func TestStalledSubscriberIsDetached(t *testing.T) {
	s := makeTestDB(t)
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	s.Subscribe(func(Event) {
		started <- struct{}{}
		<-release
	})
	if _, err := s.RecordEvent("first", "agent.updated", 0); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("subscriber did not start")
	}
	for i := 1; i <= maxSubscriberEvents+1; i++ {
		if _, err := s.RecordEvent("event", "agent.updated", i); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(time.Second)
	for {
		s.watchMu.Lock()
		remaining := len(s.watchers)
		s.watchMu.Unlock()
		if remaining == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stalled subscriber was not detached")
		}
		time.Sleep(time.Millisecond)
	}
	close(release)
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

func TestEventsExpireCursorsBeforeRetention(t *testing.T) {
	s := makeTestDB(t)
	if _, err := s.db.Exec(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM seq WHERE n < ?) INSERT INTO runtime_events (surface_id, kind, payload, created_at) SELECT 'terminal', 'terminal.updated', '{}', 0 FROM seq`, maxRuntimeEvents); err != nil {
		t.Fatalf("seed events: %v", err)
	}
	if _, err := s.RecordEvent("terminal", "terminal.updated", "latest"); err != nil {
		t.Fatalf("record retained event: %v", err)
	}
	if _, _, err := s.Events(0, 1); err != ErrCursorExpired {
		t.Fatalf("Events before retention = %v, want %v", err, ErrCursorExpired)
	}
	events, cursor, err := s.Events(maxRuntimeEvents, 1)
	if err != nil || len(events) != 1 || cursor != maxRuntimeEvents+1 {
		t.Fatalf("Events at retained cursor = %+v, %d, %v", events, cursor, err)
	}
}
