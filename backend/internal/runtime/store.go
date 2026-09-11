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

type Store struct {
	db   *sql.DB
	lock sync.Mutex // ponytail: SQLite is daemon-local; serialize store mutations.
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
	Topology  []any             `json:"topology"`
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
	store := &Store{db: db}
	if err := store.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) migrate() error {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)`); err != nil {
		return err
	}
	for _, migration := range []migration{{version: 1, apply: migrate0001}, {version: 2, apply: migrate0002}} {
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

func (s *Store) RecordTerminal(term TerminalSummary, kind string) error {
	payload, err := json.Marshal(term)
	if err != nil {
		return err
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT INTO terminal_sessions (id, name, cwd, seq, exited, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, cwd=excluded.cwd, seq=excluded.seq, exited=excluded.exited, updated_at=excluded.updated_at`, term.ID, term.Name, term.CWD, term.Seq, boolToInt(term.Exited), term.CreatedAt.Unix(), term.UpdatedAt.Unix()); err != nil {
		return err
	}
	if _, err = tx.Exec(`INSERT INTO runtime_events (surface_id, kind, payload, created_at) VALUES (?, ?, ?, ?)`, term.ID, kind, payload, time.Now().Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) RecordAgent(agent AgentSummary, kind string) error {
	payload, err := json.Marshal(agent)
	if err != nil {
		return err
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT INTO agent_sessions (id, adapter, terminal_session_id, cwd, state, capabilities, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET adapter=excluded.adapter, terminal_session_id=excluded.terminal_session_id, cwd=excluded.cwd, state=excluded.state, capabilities=excluded.capabilities, updated_at=excluded.updated_at`, agent.ID, agent.Adapter, agent.TerminalSessionID, agent.CWD, agent.State, agent.Capabilities, agent.CreatedAt.Unix(), agent.UpdatedAt.Unix()); err != nil {
		return err
	}
	if _, err = tx.Exec(`INSERT INTO runtime_events (surface_id, kind, payload, created_at) VALUES (?, ?, ?, ?)`, agent.ID, kind, payload, time.Now().Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

// RecordEvent appends a replayable surface event and returns its daemon-wide cursor.
func (s *Store) RecordEvent(surfaceID, kind string, payload any) (int64, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	s.lock.Lock()
	defer s.lock.Unlock()
	result, err := s.db.Exec(`INSERT INTO runtime_events (surface_id, kind, payload, created_at) VALUES (?, ?, ?, ?)`, surfaceID, kind, data, time.Now().Unix())
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
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
	snapshot := &Snapshot{Cursor: cursor, Terminals: []TerminalSummary{}, Agents: []AgentSummary{}, Topology: []any{}, Desktops: []any{}}
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
	return snapshot, agents.Err()
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

func (s *Store) Close() error { return s.db.Close() }

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
