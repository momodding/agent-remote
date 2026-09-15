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
	agent := AgentSummary{ID: "a1", Adapter: "omp", TerminalSessionID: "t1", OMPSessionID: "omp-1", OMPSessionFile: "/sessions/omp-1.jsonl", CWD: "/workspace", State: "idle", Capabilities: []byte(`[{"name":"chat","enabled":true}]`), CreatedAt: now, UpdatedAt: now}
	if err := s.RecordAgent(agent, "agent.created"); err != nil {
		t.Fatalf("record: %v", err)
	}
	updated := agent
	updated.OMPSessionID = "other-omp"
	updated.OMPSessionFile = ""
	if err := s.RecordAgent(updated, "agent.updated"); err != nil {
		t.Fatalf("update: %v", err)
	}
	snapshot, err := s.Snapshot()
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if len(snapshot.Agents) != 1 || snapshot.Agents[0].ID != agent.ID || snapshot.Agents[0].TerminalSessionID != agent.TerminalSessionID || snapshot.Agents[0].OMPSessionID != agent.OMPSessionID || snapshot.Agents[0].OMPSessionFile != agent.OMPSessionFile {
		t.Fatalf("unexpected snapshot: %+v", snapshot.Agents)
	}
	events, _, err := s.Events(0, 10)
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	if len(events) != 2 || events[0].Kind != "agent.created" || events[1].Kind != "agent.updated" {
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
	legacyID := "legacy-1"
	newAgentID := "agent-2"

	// 1. Record a terminal with its lifecycle events on legacyID (sharing ID pre-separation)
	term := TerminalSummary{ID: legacyID, Name: "shell", CWD: "/home", Seq: 1, CreatedAt: now, UpdatedAt: now}
	if err := s.RecordTerminal(term, "terminal.created"); err != nil {
		t.Fatalf("RecordTerminal: %v", err)
	}
	if _, err := s.RecordEvent(legacyID, "terminal.updated", map[string]any{"seq": 2}); err != nil {
		t.Fatalf("terminal.updated: %v", err)
	}
	if _, err := s.RecordEvent(legacyID, "terminal.exited", map[string]any{"exitCode": 0}); err != nil {
		t.Fatalf("terminal.exited: %v", err)
	}

	// 2. Record Agent-owned data on legacyID
	agent := AgentSummary{ID: legacyID, Adapter: "omp", TerminalSessionID: legacyID, CWD: "/workspace", State: "idle", Capabilities: []byte(`[{"name":"chat"}]`), CreatedAt: now, UpdatedAt: now}
	if err := s.RecordAgent(agent, "agent.created"); err != nil {
		t.Fatalf("RecordAgent: %v", err)
	}
	if _, err := s.RecordEvent(legacyID, "agent.updated", map[string]any{"state": "working"}); err != nil {
		t.Fatalf("agent.updated: %v", err)
	}
	// Canonical state event kind is literally "state"
	if _, err := s.RecordEvent(legacyID, "state", map[string]any{"type": "state", "agentId": legacyID, "state": "working"}); err != nil {
		t.Fatalf("state event: %v", err)
	}
	if _, err := s.RecordEvent(legacyID, "message.user", map[string]any{"role": "user", "text": "hello"}); err != nil {
		t.Fatalf("message.user: %v", err)
	}
	if _, err := s.RecordEvent(legacyID, "message.assistant", map[string]any{"role": "assistant", "text": "hi"}); err != nil {
		t.Fatalf("message.assistant: %v", err)
	}
	if _, err := s.RecordEvent(legacyID, "tool.call", map[string]any{"toolName": "bash"}); err != nil {
		t.Fatalf("tool.call: %v", err)
	}
	if _, err := s.RecordEvent(legacyID, "tool.result", map[string]any{"toolOutput": "ok"}); err != nil {
		t.Fatalf("tool.result: %v", err)
	}

	// Record agent_history and transcript_state via RecordAgentTranscript
	transcriptState := TranscriptState{
		AgentID:             legacyID,
		TranscriptPath:      "/workspace/.remote/sessions/session.jsonl",
		FileOffset:          1024,
		FileInode:           54321,
		FileSize:            4096,
		FileMtime:           now.Unix(),
		BoundaryFingerprint: "fingerprint-abc",
	}
	_, err := s.RecordAgentTranscript(legacyID, []AgentTranscriptEvent{
		{EventID: "evt-hist-1", Kind: "message.user", Payload: []byte(`{"eventId":"evt-hist-1"}`)},
		{EventID: "evt-hist-2", Kind: "message.assistant", Payload: []byte(`{"eventId":"evt-hist-2"}`)},
	}, transcriptState)
	if err != nil {
		t.Fatalf("RecordAgentTranscript: %v", err)
	}

	// 3. Migrate Agent ID from legacyID to newAgentID
	if err := s.MigrateAgentID(legacyID, newAgentID); err != nil {
		t.Fatalf("MigrateAgentID: %v", err)
	}

	// 4. Assertions
	// a. agent_sessions: newAgentID exists, legacyID agent session is gone
	snapshot, err := s.Snapshot()
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	foundNewAgent := false
	for _, a := range snapshot.Agents {
		if a.ID == newAgentID {
			foundNewAgent = true
			if a.TerminalSessionID != legacyID {
				t.Fatalf("agent TerminalSessionID mismatch: %s != %s", a.TerminalSessionID, legacyID)
			}
		}
		if a.ID == legacyID {
			t.Fatalf("old agent session ID %s still present in agent_sessions", legacyID)
		}
	}
	if !foundNewAgent {
		t.Fatalf("new agent ID %s not found in snapshot", newAgentID)
	}

	// b. terminal_sessions: legacyID terminal session remains untouched
	if len(snapshot.Terminals) != 1 || snapshot.Terminals[0].ID != legacyID {
		t.Fatalf("terminals snapshot unexpected: %+v", snapshot.Terminals)
	}

	// c. transcript_state: migrated to newAgentID, gone from legacyID
	oldTS, err := s.LoadTranscriptState(legacyID)
	if err != nil {
		t.Fatal(err)
	}
	if oldTS != nil {
		t.Fatalf("transcript_state for legacyID %s should be nil, got %+v", legacyID, oldTS)
	}
	newTS, err := s.LoadTranscriptState(newAgentID)
	if err != nil {
		t.Fatal(err)
	}
	if newTS == nil || newTS.AgentID != newAgentID || newTS.FileOffset != 1024 || newTS.BoundaryFingerprint != "fingerprint-abc" {
		t.Fatalf("transcript_state for newAgentID not migrated correctly: %+v", newTS)
	}

	// d. agent_history: migrated to newAgentID, gone from legacyID
	oldHist, _, err := s.AgentHistory(legacyID)
	if err != nil {
		t.Fatal(err)
	}
	if len(oldHist) != 0 {
		t.Fatalf("agent_history for legacyID should be empty, got %d entries", len(oldHist))
	}
	newHist, _, err := s.AgentHistory(newAgentID)
	if err != nil {
		t.Fatal(err)
	}
	if len(newHist) != 2 {
		t.Fatalf("agent_history for newAgentID got %d entries, want 2", len(newHist))
	}
	for _, h := range newHist {
		if h.AgentID != newAgentID {
			t.Fatalf("agent_history entry agent_id mismatch: %s != %s", h.AgentID, newAgentID)
		}
	}

	// e. runtime_events: agent-owned events (agent.created, agent.updated, state, message.*, tool.*) migrated to newAgentID.
	// Terminal lifecycle events (terminal.created, terminal.updated, terminal.exited) stayed on legacyID.
	events, _, err := s.Events(0, 100)
	if err != nil {
		t.Fatalf("Events: %v", err)
	}

	legacyEventCount := 0
	newAgentEventCount := 0
	for _, e := range events {
		if e.SurfaceID == legacyID {
			legacyEventCount++
			switch e.Kind {
			case "terminal.created", "terminal.updated", "terminal.exited":
				// expected to stay on legacyID
			default:
				t.Fatalf("unexpected event kind %s remained on legacyID %s", e.Kind, legacyID)
			}
		} else if e.SurfaceID == newAgentID {
			newAgentEventCount++
			switch e.Kind {
			case "agent.created", "agent.updated", "state", "message.user", "message.assistant", "tool.call", "tool.result":
				// expected agent-owned kinds
			default:
				t.Fatalf("unexpected event kind %s migrated to newAgentID %s", e.Kind, newAgentID)
			}
		} else {
			t.Fatalf("event found on unexpected surface ID: %s (kind %s)", e.SurfaceID, e.Kind)
		}
	}

	// Total events: 3 terminal events (legacyID) + 7 direct agent events + 2 transcript history events = 12 total events.
	// legacyEventCount should be 3 (terminal.*), newAgentEventCount should be 9 (7 direct + 2 transcript).
	if legacyEventCount != 3 {
		t.Fatalf("legacyID event count: got %d, want 3 terminal events", legacyEventCount)
	}
	if newAgentEventCount != 9 {
		t.Fatalf("newAgentID event count: got %d, want 9 agent-owned events", newAgentEventCount)
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
