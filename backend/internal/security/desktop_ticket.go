package security

import (
	"sync"
	"time"
)

type desktopTicketRecord struct {
	Scope     string
	AttemptID string
	IssuedAt  time.Time
	ExpiresAt time.Time
	Consumed  bool
}

// DesktopTicketState describes a ticket check without exposing its plaintext.
type DesktopTicketState string

const (
	DesktopTicketValid         DesktopTicketState = "valid"
	DesktopTicketUnknown       DesktopTicketState = "unknown"
	DesktopTicketExpired       DesktopTicketState = "expired"
	DesktopTicketScopeMismatch DesktopTicketState = "scope_mismatch"
	DesktopTicketConsumed      DesktopTicketState = "consumed"
)

// DesktopTicketStore manages ephemeral single-use tickets for desktop (RFB) sessions.
// Plaintext tickets are never stored; only their SHA-256 hex hashes are kept in memory.
type DesktopTicketStore struct {
	mu      sync.Mutex
	tickets map[string]desktopTicketRecord
}

func NewDesktopTicketStore() *DesktopTicketStore {
	return &DesktopTicketStore{
		tickets: make(map[string]desktopTicketRecord),
	}
}

// Issue generates a 32-byte cryptographically random base64url ticket, records its hash,
// and returns the plaintext ticket along with its expiration timestamp.
func (s *DesktopTicketStore) Issue(scope string, ttl time.Duration, now time.Time) (string, time.Time, error) {
	return s.IssueForAttempt(scope, "", ttl, now)
}

// IssueForAttempt binds an optional opaque diagnostic correlation ID to a ticket.
func (s *DesktopTicketStore) IssueForAttempt(scope, attemptID string, ttl time.Duration, now time.Time) (string, time.Time, error) {
	plain, err := randomEncoded(32)
	if err != nil {
		return "", time.Time{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// ponytail: sweep expired or consumed entries on access; unbounded growth only if issued faster than expired/consumed
	s.sweepLocked(now)

	hash := hashToken(plain)
	expiresAt := now.Add(ttl)
	s.tickets[hash] = desktopTicketRecord{
		Scope:     scope,
		AttemptID: attemptID,
		IssuedAt:  now,
		ExpiresAt: expiresAt,
		Consumed:  false,
	}

	return plain, expiresAt, nil
}

// Valid checks whether the plaintext ticket is currently valid for the required scope at the given timestamp.
// It does not mutate the ticket state or mark it consumed.
func (s *DesktopTicketStore) Valid(plaintext, requiredScope string, now time.Time) bool {
	_, state := s.Status(plaintext, requiredScope, now)
	return state == DesktopTicketValid
}

// Status returns a safe diagnostic state for a ticket without exposing its plaintext.
func (s *DesktopTicketStore) Status(plaintext, requiredScope string, now time.Time) (string, DesktopTicketState) {
	if plaintext == "" {
		return "", DesktopTicketUnknown
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	rec, ok := s.tickets[hashToken(plaintext)]
	if !ok {
		return "", DesktopTicketUnknown
	}
	if rec.Consumed {
		return rec.AttemptID, DesktopTicketConsumed
	}
	if now.After(rec.ExpiresAt) {
		return rec.AttemptID, DesktopTicketExpired
	}
	if rec.Scope != requiredScope {
		return rec.AttemptID, DesktopTicketScopeMismatch
	}
	return rec.AttemptID, DesktopTicketValid
}

// Consume validates the plaintext ticket for the required scope at the given timestamp.
// If valid and unconsumed, it atomically marks the ticket as consumed and returns true.
// Subsequent attempts to consume the same ticket will return false.
func (s *DesktopTicketStore) Consume(plaintext string, requiredScope string, now time.Time) bool {
	return s.ConsumeWithStatus(plaintext, requiredScope, now) == DesktopTicketValid
}

// ConsumeWithStatus atomically consumes a valid ticket and returns its safe diagnostic state.
func (s *DesktopTicketStore) ConsumeWithStatus(plaintext string, requiredScope string, now time.Time) DesktopTicketState {
	if plaintext == "" {
		return DesktopTicketUnknown
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	hash := hashToken(plaintext)
	rec, ok := s.tickets[hash]
	if !ok {
		return DesktopTicketUnknown
	}
	if rec.Consumed {
		return DesktopTicketConsumed
	}
	if now.After(rec.ExpiresAt) {
		return DesktopTicketExpired
	}
	if rec.Scope != requiredScope {
		return DesktopTicketScopeMismatch
	}

	rec.Consumed = true
	s.tickets[hash] = rec
	return DesktopTicketValid
}

// Attempt returns a valid ticket's diagnostic correlation ID without consuming it.
func (s *DesktopTicketStore) Attempt(plaintext, requiredScope string, now time.Time) (string, bool) {
	attemptID, state := s.Status(plaintext, requiredScope, now)
	return attemptID, state == DesktopTicketValid
}

func (s *DesktopTicketStore) sweepLocked(now time.Time) {
	for k, v := range s.tickets {
		if v.Consumed || now.After(v.ExpiresAt) {
			delete(s.tickets, k)
		}
	}
}
