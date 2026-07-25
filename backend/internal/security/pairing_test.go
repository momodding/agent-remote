package security

import (
	"testing"
	"time"
)

func TestPairingSnapshotEmpty(t *testing.T) {
	var snapshot PairingSnapshot
	if payload, ok := snapshot.Load(); ok || payload != nil {
		t.Fatalf("expected empty snapshot, got %#v, %v", payload, ok)
	}
}

func TestPairingSnapshotCopiesOnStore(t *testing.T) {
	var snapshot PairingSnapshot
	original := &PairingPayload{
		Version:     2,
		Endpoint:    "https://daemon.local:8765",
		Fingerprint: "original",
		PairingID:   "pairing-id",
		Token:       "token",
		ExpiresAt:   time.Unix(1_700_000_000, 0).UTC(),
	}
	snapshot.Store(original)
	original.Endpoint = "https://mutated.invalid"

	loaded, ok := snapshot.Load()
	if !ok {
		t.Fatal("expected published payload")
	}
	if loaded.Endpoint != "https://daemon.local:8765" {
		t.Fatalf("store retained caller mutation: %q", loaded.Endpoint)
	}
}

func TestPairingSnapshotCopiesOnLoad(t *testing.T) {
	var snapshot PairingSnapshot
	snapshot.Store(&PairingPayload{Version: 2, Endpoint: "https://daemon.local:8765"})

	first, ok := snapshot.Load()
	if !ok {
		t.Fatal("expected published payload")
	}
	first.Endpoint = "https://mutated.invalid"
	second, ok := snapshot.Load()
	if !ok {
		t.Fatal("expected published payload")
	}
	if second.Endpoint != "https://daemon.local:8765" {
		t.Fatalf("load exposed snapshot mutation: %q", second.Endpoint)
	}
}
