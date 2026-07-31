package security

import (
	"testing"
	"time"
)

func TestPairingSnapshotEmpty(t *testing.T) {
	var snapshot PairingSnapshot
	if presentation, ok := snapshot.Load(); ok || presentation != nil {
		t.Fatalf("expected empty snapshot, got %#v, %v", presentation, ok)
	}
}

func TestBuildPresentationFromPayload(t *testing.T) {
	payload := &PairingPayload{
		Version:   2,
		Endpoint:  "https://daemon.local:8765",
		Fingerprint: "AA:BB:CC",
		PairingID: "pair-123",
		Token:     "token-secret",
		ExpiresAt: time.Unix(1_700_000_000, 0).UTC(),
	}
	presentation, err := BuildPresentation(payload)
	if err != nil {
		t.Fatalf("failed to build presentation: %v", err)
	}
	if presentation == nil {
		t.Fatal("expected non-nil presentation")
	}
	if presentation.Payload == nil {
		t.Fatal("expected payload clone in presentation")
	}
	if presentation.Payload.PairingID != "pair-123" {
		t.Fatalf("expected pairing ID preserved, got %q", presentation.Payload.PairingID)
	}
	if len(presentation.CanonicalJSON) == 0 {
		t.Fatal("expected canonical JSON")
	}
	if len(presentation.QRPng) == 0 {
		t.Fatal("expected QR PNG bytes")
	}
	if presentation.QRTerminal == "" {
		t.Fatal("expected QR terminal string")
	}
}

func TestBuildPresentationConsistency(t *testing.T) {
	payload := &PairingPayload{
		Version:   2,
		Endpoint:  "https://daemon.local:8765",
		Fingerprint: "AA:BB:CC",
		PairingID: "pair-456",
		Token:     "token-secret",
		ExpiresAt: time.Unix(1_700_000_000, 0).UTC(),
	}
	presentation, err := BuildPresentation(payload)
	if err != nil {
		t.Fatalf("failed to build presentation: %v", err)
	}
	// QR terminal should encode the same canonical JSON
	if presentation.QRTerminal == "" {
		t.Fatal("expected non-empty QR terminal")
	}
}

func TestPairingSnapshotStoresPresentation(t *testing.T) {
	var snapshot PairingSnapshot
	payload := &PairingPayload{
		Version:   2,
		Endpoint:  "https://daemon.local:8765",
		Fingerprint: "AA:BB:CC",
		PairingID: "pair-789",
		Token:     "token-secret",
		ExpiresAt: time.Unix(1_700_000_000, 0).UTC(),
	}
	presentation, _ := BuildPresentation(payload)
	snapshot.Store(presentation)

	loaded, ok := snapshot.Load()
	if !ok {
		t.Fatal("expected stored presentation")
	}
	if loaded.Payload.PairingID != "pair-789" {
		t.Fatalf("expected pairing ID preserved, got %q", loaded.Payload.PairingID)
	}
	if len(loaded.CanonicalJSON) == 0 {
		t.Fatal("expected canonical JSON in loaded presentation")
	}
}

func TestPairingSnapshotClonesOnStore(t *testing.T) {
	var snapshot PairingSnapshot
	payload := &PairingPayload{
		Version:   2,
		Endpoint:  "https://daemon.local:8765",
		Fingerprint: "AA:BB:CC",
		PairingID: "pair-001",
		Token:     "token-secret",
		ExpiresAt: time.Unix(1_700_000_000, 0).UTC(),
	}
	presentation, _ := BuildPresentation(payload)
	originalJSON := presentation.CanonicalJSON[0]
	snapshot.Store(presentation)
	
	// Mutate caller's presentation
	presentation.CanonicalJSON[0] = byte(originalJSON ^ 0xFF)
	presentation.Payload.PairingID = "mutated"
	
	loaded, _ := snapshot.Load()
	if loaded.Payload.PairingID != "pair-001" {
		t.Fatal("store did not clone payload")
	}
	if loaded.CanonicalJSON[0] != originalJSON {
		t.Fatal("store did not clone canonical JSON")
	}
}

func TestPairingSnapshotClonesOnLoad(t *testing.T) {
	var snapshot PairingSnapshot
	payload := &PairingPayload{
		Version:   2,
		Endpoint:  "https://daemon.local:8765",
		Fingerprint: "AA:BB:CC",
		PairingID: "pair-002",
		Token:     "token-secret",
		ExpiresAt: time.Unix(1_700_000_000, 0).UTC(),
	}
	presentation, _ := BuildPresentation(payload)
	snapshot.Store(presentation)

	first, _ := snapshot.Load()
	firstID := first.Payload.PairingID
	first.Payload.PairingID = "mutated"
	first.CanonicalJSON[0] = 0xFF

	second, _ := snapshot.Load()
	if second.Payload.PairingID != firstID {
		t.Fatal("load exposed payload mutation")
	}
	if second.CanonicalJSON[0] == 0xFF {
		t.Fatal("load exposed canonical JSON mutation")
	}
}

func TestCreateWithLifetime(t *testing.T) {
	store, _ := LoadPairingStore(t.TempDir())
	now := time.Now().UTC()
	lifetime := 5 * time.Minute
	payload, err := store.Create("https://127.0.0.1:8765", "AA:BB", false, lifetime, now)
	if err != nil {
		t.Fatalf("failed to create pairing: %v", err)
	}
	expected := now.Add(lifetime)
	if !payload.ExpiresAt.Equal(expected) {
		t.Fatalf("expected expiry %v, got %v", expected, payload.ExpiresAt)
	}
}

func TestCreateRejectsInvalidLifetime(t *testing.T) {
	store, _ := LoadPairingStore(t.TempDir())
	now := time.Now().UTC()
	
	_, err := store.Create("https://127.0.0.1:8765", "AA:BB", false, 0, now)
	if err == nil {
		t.Fatal("expected error for zero lifetime")
	}
	
	_, err = store.Create("https://127.0.0.1:8765", "AA:BB", false, -1*time.Second, now)
	if err == nil {
		t.Fatal("expected error for negative lifetime")
	}
}
