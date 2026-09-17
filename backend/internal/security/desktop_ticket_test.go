package security

import (
	"encoding/base64"
	"testing"
	"time"
)

func TestDesktopTicketStore_IssueAndConsume(t *testing.T) {
	store := NewDesktopTicketStore()
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	ttl := 60 * time.Second

	plain1, exp1, err := store.Issue("desktop:connect", ttl, now)
	if err != nil {
		t.Fatalf("unexpected Issue error: %v", err)
	}
	if plain1 == "" {
		t.Fatal("expected non-empty plaintext ticket")
	}
	if !exp1.Equal(now.Add(ttl)) {
		t.Fatalf("expected expiresAt %v, got %v", now.Add(ttl), exp1)
	}

	decoded, err := base64.RawURLEncoding.DecodeString(plain1)
	if err != nil {
		t.Fatalf("failed to decode plaintext ticket as base64url: %v", err)
	}
	if len(decoded) != 32 {
		t.Fatalf("expected 32 decoded bytes, got %d", len(decoded))
	}

	plain2, _, err := store.Issue("desktop:connect", ttl, now)
	if err != nil {
		t.Fatalf("unexpected Issue error: %v", err)
	}
	if plain1 == plain2 {
		t.Fatal("expected distinct plaintexts across issue calls")
	}

	// Verify hash-only storage property: internal map key is hashToken(plain1), not plain1
	store.mu.Lock()
	if _, plainKeyExists := store.tickets[plain1]; plainKeyExists {
		t.Fatal("security violation: plaintext ticket stored directly as map key")
	}
	hash1 := hashToken(plain1)
	if _, hashKeyExists := store.tickets[hash1]; !hashKeyExists {
		t.Fatal("expected ticket to be indexed by hashToken(plain)")
	}
	store.mu.Unlock()

	// Consume succeeds first time
	if !store.Consume(plain1, "desktop:connect", now.Add(10*time.Second)) {
		t.Fatal("expected first consume to succeed")
	}

	// Replay fails
	if store.Consume(plain1, "desktop:connect", now.Add(15*time.Second)) {
		t.Fatal("expected replay consume to fail")
	}
}
func TestDesktopTicketStore_ValidDoesNotMutate(t *testing.T) {
	store := NewDesktopTicketStore()
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	plain, _, err := store.Issue("desktop:connect", time.Minute, now)
	if err != nil {
		t.Fatalf("unexpected Issue error: %v", err)
	}

	// Valid returns true without consuming
	if !store.Valid(plain, "desktop:connect", now.Add(10*time.Second)) {
		t.Fatal("expected Valid to return true")
	}
	if !store.Valid(plain, "desktop:connect", now.Add(20*time.Second)) {
		t.Fatal("expected Valid to return true on second call")
	}

	// Consume succeeds
	if !store.Consume(plain, "desktop:connect", now.Add(30*time.Second)) {
		t.Fatal("expected Consume to return true")
	}

	// Valid returns false after Consume
	if store.Valid(plain, "desktop:connect", now.Add(35*time.Second)) {
		t.Fatal("expected Valid to return false after consumption")
	}

	// Invalid inputs to Valid
	if store.Valid("", "desktop:connect", now) {
		t.Fatal("expected Valid to return false for empty string")
	}
	if store.Valid("bogus", "desktop:connect", now) {
		t.Fatal("expected Valid to return false for bogus ticket")
	}
	if store.Valid(plain, "other:scope", now) {
		t.Fatal("expected Valid to return false for wrong scope")
	}
	if store.Valid(plain, "desktop:connect", now.Add(2*time.Hour)) {
		t.Fatal("expected Valid to return false for expired ticket")
	}
}


func TestDesktopTicketStore_WrongScope(t *testing.T) {
	store := NewDesktopTicketStore()
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)

	plain, _, err := store.Issue("desktop:connect", time.Minute, now)
	if err != nil {
		t.Fatalf("unexpected issue error: %v", err)
	}

	if store.Consume(plain, "other:scope", now.Add(time.Second)) {
		t.Fatal("expected consume with wrong scope to fail")
	}

	// Correct scope still works (since wrong scope did not consume it)
	if !store.Consume(plain, "desktop:connect", now.Add(time.Second)) {
		t.Fatal("expected consume with correct scope to succeed after rejected wrong scope")
	}
}

func TestDesktopTicketStore_ExpiredTicket(t *testing.T) {
	store := NewDesktopTicketStore()
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)

	plain, _, err := store.Issue("desktop:connect", 30*time.Second, now)
	if err != nil {
		t.Fatalf("unexpected issue error: %v", err)
	}

	// Attempt consume after expiry
	if store.Consume(plain, "desktop:connect", now.Add(31*time.Second)) {
		t.Fatal("expected consume on expired ticket to fail")
	}
}

func TestDesktopTicketStore_UnknownOrMalformedTicket(t *testing.T) {
	store := NewDesktopTicketStore()
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)

	if store.Consume("", "desktop:connect", now) {
		t.Fatal("expected empty ticket to fail")
	}
	if store.Consume("random-non-existent-ticket", "desktop:connect", now) {
		t.Fatal("expected non-existent ticket to fail")
	}
}
