package security

import (
	"sync"
	"time"
)

type desktopTicketRecord struct {
	Scope     string
	IssuedAt  time.Time
	ExpiresAt time.Time
	Consumed  bool
}

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
		IssuedAt:  now,
		ExpiresAt: expiresAt,
		Consumed:  false,
	}

	return plain, expiresAt, nil
}
// Valid checks whether the plaintext ticket is currently valid for the required scope at the given timestamp.
// It does not mutate the ticket state or mark it consumed.
func (s *DesktopTicketStore) Valid(plaintext, requiredScope string, now time.Time) bool {
	if plaintext == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// ponytail: sweep expired or consumed entries on access; unbounded growth only if issued faster than expired/consumed
	s.sweepLocked(now)

	hash := hashToken(plaintext)
	rec, ok := s.tickets[hash]
	if !ok {
		return false
	}
	return !rec.Consumed && !now.After(rec.ExpiresAt) && rec.Scope == requiredScope
}


// Consume validates the plaintext ticket for the required scope at the given timestamp.
// If valid and unconsumed, it atomically marks the ticket as consumed and returns true.
// Subsequent attempts to consume the same ticket will return false.
func (s *DesktopTicketStore) Consume(plaintext string, requiredScope string, now time.Time) bool {
	if plaintext == "" {
		return false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	// ponytail: sweep expired or consumed entries on access; unbounded growth only if issued faster than expired/consumed
	s.sweepLocked(now)

	hash := hashToken(plaintext)
	rec, ok := s.tickets[hash]
	if !ok {
		return false
	}
	if rec.Consumed || now.After(rec.ExpiresAt) || rec.Scope != requiredScope {
		return false
	}

	rec.Consumed = true
	s.tickets[hash] = rec
	return true
}

func (s *DesktopTicketStore) sweepLocked(now time.Time) {
	for k, v := range s.tickets {
		if v.Consumed || now.After(v.ExpiresAt) {
			delete(s.tickets, k)
		}
	}
}
