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
	payload, err := store.Create("https://127.0.0.1:8765", "AA:BB", false, time.Now().UTC())
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
	payload, err := store.Create("https://127.0.0.1:8765", "AA:BB", true, time.Now().UTC())
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
	payload, err := pairings.Create("https://127.0.0.1:8765", "AA:BB", false, now)
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
	payload, _ := pairings.Create("https://127.0.0.1:8765", "AA:BB", false, time.Now().UTC())
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
	payload, _ := pairings.Create("https://127.0.0.1:8765", "AA:BB", false, now)
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
	payload, _ := pairings.Create("https://127.0.0.1:8765", "AA:BB", false, now)
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
	if _, err := pairings.Create("https://127.0.0.1:8765", "AA:BB", false, now); err != nil {
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
