package security

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPairingStoreDoesNotPersistRawToken(t *testing.T) {
	stateDir := t.TempDir()
	store, err := LoadPairingStore(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := store.Create("https://127.0.0.1:8765", "AA:BB", false, 2*time.Minute, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(stateDir, "auth", "pairings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), payload.Token) || strings.Contains(string(data), "token") {
		t.Fatal("pairing store must not persist raw token")
	}
}

func TestPairingPayloadCarriesFingerprintBypass(t *testing.T) {
	store, err := LoadPairingStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	payload, err := store.Create("https://127.0.0.1:8765", "AA:BB", true, 2*time.Minute, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if !payload.SkipFingerprintVerification {
		t.Fatal("expected fingerprint bypass in payload")
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"skipFingerprintVerification":true`) {
		t.Fatalf("expected fingerprint bypass in json: %s", data)
	}
}

func TestValidProofPasses(t *testing.T) {
	stateDir := t.TempDir()
	pairings, _ := LoadPairingStore(stateDir)
	sessions, _ := LoadSessionStore(stateDir)
	auth := NewAuthService(pairings, sessions)
	now := time.Now().UTC()
	auth.now = func() time.Time { return now }
	payload, err := pairings.Create("https://127.0.0.1:8765", "AA:BB", false, 2*time.Minute, now)
	if err != nil {
		t.Fatal(err)
	}
	challenge, err := auth.Begin(HelloMessage{PairingID: payload.PairingID, ClientNonce: strings.Repeat("A", 43), ClientName: "phone"})
	if err != nil {
		t.Fatal(err)
	}
	proof, err := ClientProof(payload.Token, payload.PairingID, challenge.Salt, strings.Repeat("A", 43), challenge.ServerNonce, challenge.ChallengeID)
	if err != nil {
		t.Fatal(err)
	}
	token, err := auth.Complete(payload.PairingID, challenge.ChallengeID, proof)
	if err != nil {
		t.Fatal(err)
	}
	if token == "" || !sessions.Verify(token) {
		t.Fatal("expected issued session token to verify")
	}
}

func TestWrongProofFails(t *testing.T) {
	stateDir := t.TempDir()
	pairings, _ := LoadPairingStore(stateDir)
	sessions, _ := LoadSessionStore(stateDir)
	auth := NewAuthService(pairings, sessions)
	payload, _ := pairings.Create("https://127.0.0.1:8765", "AA:BB", false, 2*time.Minute, time.Now().UTC())
	challenge, _ := auth.Begin(HelloMessage{PairingID: payload.PairingID, ClientNonce: strings.Repeat("A", 43), ClientName: "phone"})
	if _, err := auth.Complete(payload.PairingID, challenge.ChallengeID, strings.Repeat("B", 43)); err == nil {
		t.Fatal("expected wrong proof to fail")
	}
}

func TestExpiredPairingFails(t *testing.T) {
	stateDir := t.TempDir()
	pairings, _ := LoadPairingStore(stateDir)
	sessions, _ := LoadSessionStore(stateDir)
	auth := NewAuthService(pairings, sessions)
	now := time.Now().UTC()
	payload, _ := pairings.Create("https://127.0.0.1:8765", "AA:BB", false, 2*time.Minute, now)
	auth.now = func() time.Time { return now.Add(20 * time.Minute) }
	if _, err := auth.Begin(HelloMessage{PairingID: payload.PairingID, ClientNonce: strings.Repeat("A", 43), ClientName: "phone"}); err == nil {
		t.Fatal("expected expired pairing to fail")
	}
	data, _ := os.ReadFile(filepath.Join(stateDir, "auth", "pairings.json"))
	var records []PairingRecord
	if err := json.Unmarshal(data, &records); err != nil {
		t.Fatal(err)
	}
}

func TestClientNameValidationAndConsumption(t *testing.T) {
	stateDir := t.TempDir()
	pairings, _ := LoadPairingStore(stateDir)
	sessions, _ := LoadSessionStore(stateDir)
	auth := NewAuthService(pairings, sessions)
	now := time.Now().UTC()
	auth.now = func() time.Time { return now }
	payload, _ := pairings.Create("https://127.0.0.1:8765", "AA:BB", false, 2*time.Minute, now)
	if _, err := auth.Begin(HelloMessage{PairingID: payload.PairingID, ClientNonce: strings.Repeat("A", 43), ClientName: "   "}); err == nil {
		t.Fatal("expected empty client name to fail")
	}
	if _, err := auth.Begin(HelloMessage{PairingID: payload.PairingID, ClientNonce: strings.Repeat("A", 43), ClientName: strings.Repeat("x", 65)}); err == nil {
		t.Fatal("expected long client name to fail")
	}
	challenge, err := auth.Begin(HelloMessage{PairingID: payload.PairingID, ClientNonce: strings.Repeat("A", 43), ClientName: " phone "})
	if err != nil {
		t.Fatal(err)
	}
	proof, _ := ClientProof(payload.Token, payload.PairingID, challenge.Salt, strings.Repeat("A", 43), challenge.ServerNonce, challenge.ChallengeID)
	token, err := auth.Complete(payload.PairingID, challenge.ChallengeID, proof)
	if err != nil || token == "" {
		t.Fatalf("expected token, got %q err=%v", token, err)
	}
	if _, ok := pairings.Find(payload.PairingID, now); ok {
		t.Fatal("expected pairing consumed")
	}
	if sessions.Sessions[0].ClientName != "phone" {
		t.Fatalf("expected trimmed client name, got %q", sessions.Sessions[0].ClientName)
	}
	if _, err := auth.Complete(payload.PairingID, challenge.ChallengeID, proof); err == nil {
		t.Fatal("expected second proof to fail")
	}
}

func TestPairingCleanupDropsExpiredRecords(t *testing.T) {
	stateDir := t.TempDir()
	pairings, _ := LoadPairingStore(stateDir)
	now := time.Now().UTC()
	if _, err := pairings.Create("https://127.0.0.1:8765", "AA:BB", false, 2*time.Minute, now); err != nil {
		t.Fatal(err)
	}
	if len(pairings.Pairings) != 1 {
		t.Fatalf("expected one pairing, got %d", len(pairings.Pairings))
	}
	if err := pairings.Cleanup(now.Add(3 * time.Minute)); err != nil {
		t.Fatal(err)
	}
	if len(pairings.Pairings) != 0 {
		t.Fatalf("expected cleanup to remove expired pairing, got %d", len(pairings.Pairings))
	}
}

func TestPendingChallengeSweepOnExpiry(t *testing.T) {
	stateDir := t.TempDir()
	pairings, _ := LoadPairingStore(stateDir)
	sessions, _ := LoadSessionStore(stateDir)
	auth := NewAuthService(pairings, sessions)
	t0 := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	currentTime := t0
	auth.now = func() time.Time { return currentTime }

	// Create first pairing with 1 minute lifetime
	payload1, err := pairings.Create("https://127.0.0.1:8765", "AA:BB", false, 1*time.Minute, t0)
	if err != nil {
		t.Fatal(err)
	}
	ch1, err := auth.Begin(HelloMessage{PairingID: payload1.PairingID, ClientNonce: strings.Repeat("A", 43), ClientName: "phone1"})
	if err != nil {
		t.Fatal(err)
	}
	proof1, _ := ClientProof(payload1.Token, payload1.PairingID, ch1.Salt, strings.Repeat("A", 43), ch1.ServerNonce, ch1.ChallengeID)

	// Advance time past payload1 expiration
	currentTime = t0.Add(2 * time.Minute)

	// Create second pairing with 5 minute lifetime
	payload2, err := pairings.Create("https://127.0.0.1:8765", "AA:BB", false, 5*time.Minute, currentTime)
	if err != nil {
		t.Fatal(err)
	}

	// Begin on second pairing should sweep expired ch1 from pending
	ch2, err := auth.Begin(HelloMessage{PairingID: payload2.PairingID, ClientNonce: strings.Repeat("B", 43), ClientName: "phone2"})
	if err != nil {
		t.Fatal(err)
	}
	proof2, _ := ClientProof(payload2.Token, payload2.PairingID, ch2.Salt, strings.Repeat("B", 43), ch2.ServerNonce, ch2.ChallengeID)

	// ch1 completion must fail (expired and swept)
	if _, err := auth.Complete(payload1.PairingID, ch1.ChallengeID, proof1); err == nil {
		t.Fatal("expected expired and swept challenge 1 to fail completion")
	}

	// ch2 completion must succeed
	token2, err := auth.Complete(payload2.PairingID, ch2.ChallengeID, proof2)
	if err != nil || token2 == "" {
		t.Fatalf("expected challenge 2 to complete successfully, got token=%q err=%v", token2, err)
	}
}

func TestPendingChallengeCapRejectsNewAndPreservesValid(t *testing.T) {
	stateDir := t.TempDir()
	pairings, _ := LoadPairingStore(stateDir)
	sessions, _ := LoadSessionStore(stateDir)
	auth := NewAuthService(pairings, sessions)
	now := time.Now().UTC()
	auth.now = func() time.Time { return now }

	payload, err := pairings.Create("https://127.0.0.1:8765", "AA:BB", false, 10*time.Minute, now)
	if err != nil {
		t.Fatal(err)
	}

	type challengeItem struct {
		nonce string
		ch    *ChallengeMessage
	}
	var challenges []challengeItem

	// Fill pending map up to maxPendingChallenges (64)
	for i := 0; i < maxPendingChallenges; i++ {
		nonce, err := randomEncoded(32)
		if err != nil {
			t.Fatal(err)
		}
		ch, err := auth.Begin(HelloMessage{PairingID: payload.PairingID, ClientNonce: nonce, ClientName: "client"})
		if err != nil {
			t.Fatalf("expected Begin %d to succeed, got %v", i, err)
		}
		challenges = append(challenges, challengeItem{nonce: nonce, ch: ch})
	}

	// 65th Begin must be rejected due to cap
	extraNonce, _ := randomEncoded(32)
	if _, err := auth.Begin(HelloMessage{PairingID: payload.PairingID, ClientNonce: extraNonce, ClientName: "client"}); err == nil {
		t.Fatal("expected Begin beyond cap to fail")
	}

	// Existing valid challenge (e.g. index 0) must still be valid and completable
	first := challenges[0]
	proof, err := ClientProof(payload.Token, payload.PairingID, first.ch.Salt, first.nonce, first.ch.ServerNonce, first.ch.ChallengeID)
	if err != nil {
		t.Fatal(err)
	}
	token, err := auth.Complete(payload.PairingID, first.ch.ChallengeID, proof)
	if err != nil || token == "" {
		t.Fatalf("expected first valid challenge to complete, got %v", err)
	}
}

func TestCompleteAtomicallyConsumesChallengeOnWrongProofAndPreventsReplay(t *testing.T) {
	stateDir := t.TempDir()
	pairings, _ := LoadPairingStore(stateDir)
	sessions, _ := LoadSessionStore(stateDir)
	auth := NewAuthService(pairings, sessions)
	now := time.Now().UTC()
	auth.now = func() time.Time { return now }

	payload, err := pairings.Create("https://127.0.0.1:8765", "AA:BB", false, 5*time.Minute, now)
	if err != nil {
		t.Fatal(err)
	}
	nonce := strings.Repeat("A", 43)
	ch1, err := auth.Begin(HelloMessage{PairingID: payload.PairingID, ClientNonce: nonce, ClientName: "phone"})
	if err != nil {
		t.Fatal(err)
	}

	// Attempt complete with wrong proof
	if _, err := auth.Complete(payload.PairingID, ch1.ChallengeID, strings.Repeat("Z", 43)); err == nil {
		t.Fatal("expected wrong proof to fail")
	}

	// Attempting with correct proof for ch1 MUST now fail because challenge was consumed on first attempt
	validProof1, err := ClientProof(payload.Token, payload.PairingID, ch1.Salt, nonce, ch1.ServerNonce, ch1.ChallengeID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := auth.Complete(payload.PairingID, ch1.ChallengeID, validProof1); err == nil {
		t.Fatal("expected second attempt on consumed challenge to fail even with correct proof")
	}

	// Pairing itself was not consumed, so a new Begin must succeed
	ch2, err := auth.Begin(HelloMessage{PairingID: payload.PairingID, ClientNonce: nonce, ClientName: "phone"})
	if err != nil {
		t.Fatalf("expected new Begin to succeed on unconsumed pairing, got %v", err)
	}

	// Complete with correct proof for ch2 must succeed
	validProof2, err := ClientProof(payload.Token, payload.PairingID, ch2.Salt, nonce, ch2.ServerNonce, ch2.ChallengeID)
	if err != nil {
		t.Fatal(err)
	}
	token, err := auth.Complete(payload.PairingID, ch2.ChallengeID, validProof2)
	if err != nil || token == "" {
		t.Fatalf("expected valid proof to succeed on new challenge, got token=%q err=%v", token, err)
	}

	// Replay of ch2 with valid proof must fail
	if _, err := auth.Complete(payload.PairingID, ch2.ChallengeID, validProof2); err == nil {
		t.Fatal("expected replay of completed challenge to fail")
	}
}
