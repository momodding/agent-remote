package runtime

import (
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync"
	"time"

	_ "github.com/glebarez/go-sqlite"
)

var ErrCursorExpired = errors.New("runtime cursor expired")

const maxRuntimeEvents = 5_000

type Store struct {
	db            *sql.DB
	lock          sync.Mutex // ponytail: SQLite is daemon-local; serialize store mutations.
	watchMu       sync.Mutex
	watchers      map[uint64]func(Event)
	nextWatcher   uint64
	publishMu     sync.Mutex
	publishWake   *sync.Cond
	publishQueue  []Event
	publishClosed bool
	publishDone   chan struct{}
}

type TerminalSummary struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CWD       string    `json:"cwd"`
	Seq       int64     `json:"seq"`
	Exited    bool      `json:"exited"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type AgentSummary struct {
	ID                string          `json:"id"`
	Adapter           string          `json:"adapter"`
	TerminalSessionID string          `json:"terminalSessionId"`
	CWD               string          `json:"cwd"`
	State             string          `json:"state"`
	Capabilities      json.RawMessage `json:"capabilities"`
	CreatedAt         time.Time       `json:"createdAt"`
	UpdatedAt         time.Time       `json:"updatedAt"`
}

type TopologyPane struct {
	TerminalSessionID string    `json:"terminalSessionId"`
	ServerID          string    `json:"serverId"`
	SessionID         string    `json:"sessionId"`
	WindowID          string    `json:"windowId"`
	PaneID            string    `json:"paneId"`
	SessionName       string    `json:"sessionName"`
	WindowName        string    `json:"windowName"`
	WindowIndex       int       `json:"windowIndex"`
	PaneIndex         int       `json:"paneIndex"`
	CWD               string    `json:"cwd"`
	Active            bool      `json:"active"`
	UpdatedAt         time.Time `json:"updatedAt"`
}

type Event struct {
	Cursor    int64           `json:"cursor"`
	SurfaceID string          `json:"surfaceId"`
	Kind      string          `json:"kind"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"createdAt"`
}

type Snapshot struct {
	Cursor    int64             `json:"cursor"`
	Terminals []TerminalSummary `json:"terminals"`
	Agents    []AgentSummary    `json:"agents"`
	Topology  []TopologyPane    `json:"topology"`
	Desktops  []any             `json:"desktops"`
}

type migration struct {
	version int
	apply   func(*sql.Tx) error
}

func Open(stateDir string) (*Store, error) {
	db, err := sql.Open("sqlite", filepath.Join(stateDir, "runtime.db"))
	if err != nil {
		return nil, err
	}
	store := &Store{db: db, watchers: make(map[uint64]func(Event)), publishDone: make(chan struct{})}
	store.publishWake = sync.NewCond(&store.publishMu)
	if err := store.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	go store.dispatchPublished()
	return store, nil
}

func (s *Store) migrate() error {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)`); err != nil {
		return err
	}
	for _, migration := range []migration{{version: 1, apply: migrate0001}, {version: 2, apply: migrate0002}, {version: 3, apply: migrate0003}, {version: 4, apply: migrate0004}} {
		var applied bool
		if err := s.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?)`, migration.version).Scan(&applied); err != nil {
			return err
		}
		if applied {
			continue
		}
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		if err := migration.apply(tx); err != nil {
			_ = tx.Rollback()
			return err
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations (version) VALUES (?)`, migration.version); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func migrate0001(tx *sql.Tx) error {
	for _, query := range []string{
		`CREATE TABLE terminal_sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, seq INTEGER NOT NULL, exited INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
		`CREATE TABLE runtime_events (global_seq INTEGER PRIMARY KEY AUTOINCREMENT, surface_id TEXT NOT NULL, kind TEXT NOT NULL, payload BLOB NOT NULL, created_at INTEGER NOT NULL)`,
	} {
		if _, err := tx.Exec(query); err != nil {
			return err
		}
	}
	return nil
}

func migrate0002(tx *sql.Tx) error {
	_, err := tx.Exec(`CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, adapter TEXT NOT NULL, terminal_session_id TEXT NOT NULL, cwd TEXT NOT NULL, state TEXT NOT NULL, capabilities BLOB NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
	return err
}
func migrate0003(tx *sql.Tx) error {
	_, err := tx.Exec(`CREATE TABLE tmux_panes (pane_id TEXT PRIMARY KEY, terminal_session_id TEXT NOT NULL UNIQUE, server_id TEXT NOT NULL, session_id TEXT NOT NULL, window_id TEXT NOT NULL, session_name TEXT NOT NULL, window_name TEXT NOT NULL, window_index INTEGER NOT NULL, pane_index INTEGER NOT NULL, cwd TEXT NOT NULL, active INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
	return err
}

func migrate0004(tx *sql.Tx) error {
	for _, query := range []string{
		`CREATE TABLE tmux_panes_v4 (pane_id TEXT NOT NULL, terminal_session_id TEXT NOT NULL UNIQUE, server_id TEXT NOT NULL, session_id TEXT NOT NULL, window_id TEXT NOT NULL, session_name TEXT NOT NULL, window_name TEXT NOT NULL, window_index INTEGER NOT NULL, pane_index INTEGER NOT NULL, cwd TEXT NOT NULL, active INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (server_id, pane_id))`,
		`INSERT INTO tmux_panes_v4 (pane_id, terminal_session_id, server_id, session_id, window_id, session_name, window_name, window_index, pane_index, cwd, active, updated_at) SELECT pane_id, terminal_session_id, server_id, session_id, window_id, session_name, window_name, window_index, pane_index, cwd, active, updated_at FROM tmux_panes`,
		`DROP TABLE tmux_panes`,
		`ALTER TABLE tmux_panes_v4 RENAME TO tmux_panes`,
	} {
		if _, err := tx.Exec(query); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) RecordTerminal(term TerminalSummary, kind string) error {
	payload, err := json.Marshal(term)
	if err != nil {
		return err
	}
	s.lock.Lock()
	locked := true
	defer func() {
		if locked {
			s.lock.Unlock()
		}
	}()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT INTO terminal_sessions (id, name, cwd, seq, exited, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, cwd=excluded.cwd, seq=excluded.seq, exited=excluded.exited, updated_at=excluded.updated_at`, term.ID, term.Name, term.CWD, term.Seq, boolToInt(term.Exited), term.CreatedAt.Unix(), term.UpdatedAt.Unix()); err != nil {
		return err
	}
	result, err := appendRuntimeEvent(tx, term.ID, kind, payload)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	cursor, err := result.LastInsertId()
	if err == nil {
		s.enqueuePublished(Event{Cursor: cursor, SurfaceID: term.ID, Kind: kind, Payload: payload, CreatedAt: time.Now().UTC()})
	}
	s.lock.Unlock()
	locked = false
	return err
}

func (s *Store) RecordAgent(agent AgentSummary, kind string) error {
	payload, err := json.Marshal(agent)
	if err != nil {
		return err
	}
	s.lock.Lock()
	locked := true
	defer func() {
		if locked {
			s.lock.Unlock()
		}
	}()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT INTO agent_sessions (id, adapter, terminal_session_id, cwd, state, capabilities, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET adapter=excluded.adapter, terminal_session_id=excluded.terminal_session_id, cwd=excluded.cwd, state=excluded.state, capabilities=excluded.capabilities, updated_at=excluded.updated_at`, agent.ID, agent.Adapter, agent.TerminalSessionID, agent.CWD, agent.State, agent.Capabilities, agent.CreatedAt.Unix(), agent.UpdatedAt.Unix()); err != nil {
		return err
	}
	result, err := appendRuntimeEvent(tx, agent.ID, kind, payload)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	cursor, err := result.LastInsertId()
	if err == nil {
		s.enqueuePublished(Event{Cursor: cursor, SurfaceID: agent.ID, Kind: kind, Payload: payload, CreatedAt: time.Now().UTC()})
	}
	s.lock.Unlock()
	locked = false
	return err
}

// MigrateAgentID separates legacy agent rows that reused a terminal ID. Only
// agent-owned event kinds move; terminal history stays on the terminal surface.
func (s *Store) MigrateAgentID(oldID, newID string) error {
	s.lock.Lock()
	defer s.lock.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`UPDATE agent_sessions SET id = ? WHERE id = ?`, newID, oldID); err != nil {
		return err
	}
	if _, err = tx.Exec(`UPDATE runtime_events SET surface_id = ? WHERE surface_id = ? AND kind LIKE 'agent.%'`, newID, oldID); err != nil {
		return err
	}
	return tx.Commit()
}

// RemoveTerminal removes a materialized terminal after a later create-stage failure.
func (s *Store) RemoveTerminal(id string) error {
	s.lock.Lock()
	locked := true
	defer func() {
		if locked {
			s.lock.Unlock()
		}
	}()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM terminal_sessions WHERE id = ?`, id); err != nil {
		return err
	}
	payload, err := json.Marshal(struct {
		ID string `json:"id"`
	}{ID: id})
	if err != nil {
		return err
	}
	result, err := appendRuntimeEvent(tx, id, "terminal.removed", payload)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	cursor, err := result.LastInsertId()
	if err == nil {
		s.enqueuePublished(Event{Cursor: cursor, SurfaceID: id, Kind: "terminal.removed", Payload: payload, CreatedAt: time.Now().UTC()})
	}
	s.lock.Unlock()
	locked = false
	return err
}

// RecordEvent appends a replayable surface event and returns its daemon-wide cursor.
func (s *Store) RecordEvent(surfaceID, kind string, payload any) (int64, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	s.lock.Lock()
	locked := true
	defer func() {
		if locked {
			s.lock.Unlock()
		}
	}()
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	result, err := appendRuntimeEvent(tx, surfaceID, kind, data)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	cursor, err := result.LastInsertId()
	if err == nil {
		s.enqueuePublished(Event{Cursor: cursor, SurfaceID: surfaceID, Kind: kind, Payload: data, CreatedAt: time.Now().UTC()})
	}
	s.lock.Unlock()
	locked = false
	return cursor, err
}

func appendRuntimeEvent(tx *sql.Tx, surfaceID, kind string, payload []byte) (sql.Result, error) {
	result, err := tx.Exec(`INSERT INTO runtime_events (surface_id, kind, payload, created_at) VALUES (?, ?, ?, ?)`, surfaceID, kind, payload, time.Now().Unix())
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(`DELETE FROM runtime_events WHERE global_seq <= COALESCE((SELECT global_seq FROM runtime_events ORDER BY global_seq DESC LIMIT 1 OFFSET ?), 0)`, maxRuntimeEvents)
	return result, err
}

func (s *Store) RecordTopology(panes []TopologyPane) error {
	payload, err := json.Marshal(panes)
	if err != nil {
		return err
	}
	s.lock.Lock()
	locked := true
	defer func() {
		if locked {
			s.lock.Unlock()
		}
	}()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`DELETE FROM tmux_panes`); err != nil {
		return err
	}
	for _, pane := range panes {
		if _, err = tx.Exec(`INSERT INTO tmux_panes (pane_id, terminal_session_id, server_id, session_id, window_id, session_name, window_name, window_index, pane_index, cwd, active, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, pane.PaneID, pane.TerminalSessionID, pane.ServerID, pane.SessionID, pane.WindowID, pane.SessionName, pane.WindowName, pane.WindowIndex, pane.PaneIndex, pane.CWD, boolToInt(pane.Active), pane.UpdatedAt.Unix()); err != nil {
			return err
		}
	}
	result, err := appendRuntimeEvent(tx, "topology", "tmux.topology", payload)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	cursor, err := result.LastInsertId()
	if err == nil {
		s.enqueuePublished(Event{Cursor: cursor, SurfaceID: "topology", Kind: "tmux.topology", Payload: payload, CreatedAt: time.Now().UTC()})
	}
	s.lock.Unlock()
	locked = false
	return err
}

func (s *Store) Snapshot() (*Snapshot, error) {
	s.lock.Lock()
	defer s.lock.Unlock()
	var cursor int64
	if err := s.db.QueryRow(`SELECT COALESCE(MAX(global_seq), 0) FROM runtime_events`).Scan(&cursor); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(`SELECT id, name, cwd, seq, exited, created_at, updated_at FROM terminal_sessions ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	snapshot := &Snapshot{Cursor: cursor, Terminals: []TerminalSummary{}, Agents: []AgentSummary{}, Topology: []TopologyPane{}, Desktops: []any{}}
	for rows.Next() {
		var term TerminalSummary
		var exited, created, updated int64
		if err := rows.Scan(&term.ID, &term.Name, &term.CWD, &term.Seq, &exited, &created, &updated); err != nil {
			return nil, err
		}
		term.Exited = exited != 0
		term.CreatedAt, term.UpdatedAt = time.Unix(created, 0), time.Unix(updated, 0)
		snapshot.Terminals = append(snapshot.Terminals, term)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	agents, err := s.db.Query(`SELECT id, adapter, terminal_session_id, cwd, state, capabilities, created_at, updated_at FROM agent_sessions ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer agents.Close()
	for agents.Next() {
		var agent AgentSummary
		var created, updated int64
		if err := agents.Scan(&agent.ID, &agent.Adapter, &agent.TerminalSessionID, &agent.CWD, &agent.State, &agent.Capabilities, &created, &updated); err != nil {
			return nil, err
		}
		agent.CreatedAt, agent.UpdatedAt = time.Unix(created, 0), time.Unix(updated, 0)
		snapshot.Agents = append(snapshot.Agents, agent)
	}
	if err := agents.Err(); err != nil {
		return nil, err
	}
	panes, err := s.db.Query(`SELECT terminal_session_id, server_id, session_id, window_id, pane_id, session_name, window_name, window_index, pane_index, cwd, active, updated_at FROM tmux_panes ORDER BY session_id, window_index, pane_index`)
	if err != nil {
		return nil, err
	}
	defer panes.Close()
	for panes.Next() {
		var pane TopologyPane
		var active, updated int64
		if err := panes.Scan(&pane.TerminalSessionID, &pane.ServerID, &pane.SessionID, &pane.WindowID, &pane.PaneID, &pane.SessionName, &pane.WindowName, &pane.WindowIndex, &pane.PaneIndex, &pane.CWD, &active, &updated); err != nil {
			return nil, err
		}
		pane.Active = active != 0
		pane.UpdatedAt = time.Unix(updated, 0)
		snapshot.Topology = append(snapshot.Topology, pane)
	}
	return snapshot, panes.Err()
}

func (s *Store) Events(after int64, limit int) ([]Event, int64, error) {
	if after < 0 {
		return nil, 0, ErrCursorExpired
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	var earliest int64
	if err := s.db.QueryRow(`SELECT COALESCE(MIN(global_seq), 0) FROM runtime_events`).Scan(&earliest); err != nil {
		return nil, 0, err
	}
	if earliest > 0 && after < earliest-1 {
		return nil, 0, ErrCursorExpired
	}
	rows, err := s.db.Query(`SELECT global_seq, surface_id, kind, payload, created_at FROM runtime_events WHERE global_seq > ? ORDER BY global_seq LIMIT ?`, after, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	events := []Event{}
	next := after
	for rows.Next() {
		var event Event

		var created int64
		if err := rows.Scan(&event.Cursor, &event.SurfaceID, &event.Kind, &event.Payload, &created); err != nil {
			return nil, 0, err
		}
		event.CreatedAt = time.Unix(created, 0)
		next = event.Cursor
		events = append(events, event)
	}
	return events, next, rows.Err()
}

func (s *Store) Close() error {
	s.publishMu.Lock()
	s.publishClosed = true
	s.publishWake.Signal()
	s.publishMu.Unlock()
	<-s.publishDone
	return s.db.Close()
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

// Subscribe receives events only after their transaction commits.
func (s *Store) Subscribe(fn func(Event)) func() {
	s.watchMu.Lock()
	id := s.nextWatcher
	s.nextWatcher++
	s.watchers[id] = fn
	s.watchMu.Unlock()
	return func() {
		s.watchMu.Lock()
		delete(s.watchers, id)
		s.watchMu.Unlock()
	}
}

func (s *Store) enqueuePublished(event Event) {
	s.publishMu.Lock()
	s.publishQueue = append(s.publishQueue, event)
	s.publishWake.Signal()
	s.publishMu.Unlock()
}

func (s *Store) dispatchPublished() {
	defer close(s.publishDone)
	for {
		s.publishMu.Lock()
		for len(s.publishQueue) == 0 && !s.publishClosed {
			s.publishWake.Wait()
		}
		if len(s.publishQueue) == 0 {
			s.publishMu.Unlock()
			return
		}
		event := s.publishQueue[0]
		s.publishQueue = s.publishQueue[1:]
		s.publishMu.Unlock()
		s.publish(event)
	}
}

func (s *Store) publish(event Event) {
	s.watchMu.Lock()
	watchers := make([]func(Event), 0, len(s.watchers))
	for _, watcher := range s.watchers {
		watchers = append(watchers, watcher)
	}
	s.watchMu.Unlock()
	for _, watcher := range watchers {
		watcher(event)
	}
}
