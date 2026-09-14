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
	overflowed := make(chan struct{}, 1)
	s.Subscribe(func(Event) {
		started <- struct{}{}
		<-release
	}, func() {
		select {
		case overflowed <- struct{}{}:
		default:
		}
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
	select {
	case <-overflowed:
	case <-time.After(time.Second):
		t.Fatal("overflow callback was not invoked")
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

func TestMigrateAgentIDWithMixedHistory(t *testing.T) {
	s := makeTestDB(t)
	now := time.Now().UTC()
	termID := "legacy-terminal-123"
	agentID := "agent-456"
	newAgentID := "agent-789"

	// Record a terminal with its events
	term := TerminalSummary{ID: termID, Name: "shell", CWD: "/home", Seq: 1, CreatedAt: now, UpdatedAt: now}
	if err := s.RecordTerminal(term, "terminal.created"); err != nil {
		t.Fatalf("RecordTerminal: %v", err)
	}

	// Record agent as if it reused the terminal ID (legacy behavior)
	agent := AgentSummary{ID: agentID, Adapter: "omp", TerminalSessionID: termID, CWD: "/workspace", State: "idle", Capabilities: []byte(`[{"name":"chat"}]`), CreatedAt: now, UpdatedAt: now}
	if err := s.RecordAgent(agent, "agent.created"); err != nil {
		t.Fatalf("RecordAgent: %v", err)
	}

	// Record mixed events on the old agent ID: terminal, agent, message, tool, canonical state
	if _, err := s.RecordEvent(agentID, "terminal.output", "some output"); err != nil {
		t.Fatalf("terminal.output: %v", err)
	}
	if _, err := s.RecordEvent(agentID, "agent.init", "{}"); err != nil {
		t.Fatalf("agent.init: %v", err)
	}
	if _, err := s.RecordEvent(agentID, "message.created", `{"role":"user"}`); err != nil {
		t.Fatalf("message.created: %v", err)
	}
	if _, err := s.RecordEvent(agentID, "tool.call", `{"name":"read_file"}`); err != nil {
		t.Fatalf("tool.call: %v", err)
	}
	if _, err := s.RecordEvent(agentID, "agent.state", `{"state":"working"}`); err != nil {
		t.Fatalf("agent.state: %v", err)
	}
	if _, err := s.RecordEvent(agentID, "message.delta", `{"delta":"text"}`); err != nil {
		t.Fatalf("message.delta: %v", err)
	}

	// Migrate the agent to a new ID
	if err := s.MigrateAgentID(agentID, newAgentID); err != nil {
		t.Fatalf("MigrateAgentID: %v", err)
	}

	// Check that agent_sessions was updated
	snapshot, err := s.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	found := false
	for _, a := range snapshot.Agents {
		if a.ID == newAgentID {
			found = true
			if a.TerminalSessionID != termID {
				t.Fatalf("agent TerminalSessionID mismatch: %s != %s", a.TerminalSessionID, termID)
			}
			break
		}
	}
	if !found {
		t.Fatalf("new agent ID %s not found in snapshot", newAgentID)
	}

	// Verify old agent ID is gone
	for _, a := range snapshot.Agents {
		if a.ID == agentID {
			t.Fatalf("old agent ID %s still present after migrate", agentID)
		}
	}

	// Verify events: agent/message/tool/agent.state moved to new ID, terminal.output stayed with old ID
	events, _, err := s.Events(0, 100)
	if err != nil {
		t.Fatalf("Events: %v", err)
	}

	oldIDEventCount := 0
	newIDEventCount := 0
	for _, e := range events {
		if e.SurfaceID == agentID {
			oldIDEventCount++
			// Only terminal events should still reference old ID
			if e.Kind != "terminal.output" && e.Kind != "terminal.created" {
				t.Fatalf("unexpected event kind %s still on old ID %s", e.Kind, agentID)
			}
		}
		if e.SurfaceID == newAgentID {
			newIDEventCount++
			// agent.*, message.*, tool.*, agent.state should be on new ID
			switch e.Kind {
			case "agent.init", "agent.created", "agent.state", "message.created", "message.delta", "tool.call":
				// expected
			default:
				t.Fatalf("unexpected event kind %s on new ID %s", e.Kind, newAgentID)
			}
		}
	}

	// Verify counts: 6 agent-owned events moved to new ID (agent.created, agent.init, agent.state, message.created, message.delta, tool.call)
	// 1 terminal event stayed with old ID (terminal.output)
	if newIDEventCount != 6 {
		t.Fatalf("new ID event count: got %d, want 6 (agent.created, agent.init, agent.state, message.created, message.delta, tool.call)", newIDEventCount)
	}
	if oldIDEventCount != 1 {
		t.Fatalf("old ID event count: got %d, want 1 (terminal.output)", oldIDEventCount)
	}
}

func TestRecordAgentTranscriptPreservesSameKindCursors(t *testing.T) {
	s := makeTestDB(t)
	state := TranscriptState{AgentID: "agent", TranscriptPath: "/tmp/session.jsonl", FileOffset: 42}
	commits, err := s.RecordAgentTranscript("agent", []AgentTranscriptEvent{
		{EventID: "one", Kind: "message.assistant", Payload: []byte(`{"eventId":"one"}`)},
		{EventID: "two", Kind: "message.assistant", Payload: []byte(`{"eventId":"two"}`)},
	}, state)
	if err != nil {
		t.Fatal(err)
	}
	if len(commits) != 2 || commits[0].EventID != "one" || commits[1].EventID != "two" || commits[0].Event.Cursor == 0 || commits[1].Event.Cursor <= commits[0].Event.Cursor {
		t.Fatalf("unexpected commits: %+v", commits)
	}
	events, _, err := s.Events(0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Cursor != commits[0].Event.Cursor || events[1].Cursor != commits[1].Event.Cursor {
		t.Fatalf("unexpected replay: %+v", events)
	}
}

func TestAgentHistory(t *testing.T) {
	s := makeTestDB(t)

	// Record some transcript events
	state := TranscriptState{AgentID: "agent-hist", TranscriptPath: "/tmp/session.jsonl", FileOffset: 100}
	_, err := s.RecordAgentTranscript("agent-hist", []AgentTranscriptEvent{
		{EventID: "evt-1", Kind: "message.user", Payload: []byte(`{"eventId":"evt-1","kind":"message.user"}`)},
		{EventID: "evt-2", Kind: "message.assistant", Payload: []byte(`{"eventId":"evt-2","kind":"message.assistant"}`)},
	}, state)
	if err != nil {
		t.Fatalf("RecordAgentTranscript error: %v", err)
	}

	// Also record an unrelated runtime event to advance global_seq
	_, err = s.RecordEvent("other-stream", "other.kind", []byte(`{}`))
	if err != nil {
		t.Fatalf("RecordEvent error: %v", err)
	}

	events, cursor, err := s.AgentHistory("agent-hist")
	if err != nil {
		t.Fatalf("AgentHistory error: %v", err)
	}
	if cursor == 0 {
		t.Fatalf("expected positive cursor, got %d", cursor)
	}
	if len(events) != 2 {
		t.Fatalf("expected 2 history events, got %d", len(events))
	}
	if events[0].EventID != "evt-1" || events[1].EventID != "evt-2" {
		t.Fatalf("unexpected events ordering: %+v", events)
	}

	// Non-existent agent returns empty events and high-water cursor
	emptyEvents, emptyCursor, err := s.AgentHistory("non-existent")
	if err != nil {
		t.Fatalf("AgentHistory for non-existent agent error: %v", err)
	}
	if len(emptyEvents) != 0 {
		t.Fatalf("expected 0 events, got %d", len(emptyEvents))
	}
	if emptyCursor != cursor {
		t.Fatalf("expected cursor %d, got %d", cursor, emptyCursor)
	}
}
