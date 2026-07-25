package security

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
)

type PairingPayload struct {
	Version                     int       `json:"v"`
	Endpoint                    string    `json:"endpoint"`
	Fingerprint                 string    `json:"fingerprint"`
	SkipFingerprintVerification bool      `json:"skipFingerprintVerification,omitempty"`
	PairingID                   string    `json:"pairingId"`
	Token                       string    `json:"token"`
	ExpiresAt                   time.Time `json:"expiresAt"`
}

// PairingSnapshot publishes the latest pairing payload for presentation without
// exposing the mutable rotation state.
type PairingSnapshot struct {
	mu      sync.RWMutex
	payload *PairingPayload
}

func (s *PairingSnapshot) Store(payload *PairingPayload) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if payload == nil {
		s.payload = nil
		return
	}
	clone := *payload
	s.payload = &clone
}

func (s *PairingSnapshot) Load() (*PairingPayload, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.payload == nil {
		return nil, false
	}
	clone := *s.payload
	return &clone, true
}

type PairingRecord struct {
	PairingID  string    `json:"pairingId"`
	Salt       string    `json:"salt"`
	Verifier   string    `json:"verifier"`
	ExpiresAt  time.Time `json:"expiresAt"`
	ClientName string    `json:"clientName,omitempty"`
}

type PairingStore struct {
	Path     string
	mu       sync.Mutex
	Pairings []PairingRecord
}

func LoadPairingStore(stateDir string) (*PairingStore, error) {
	path := filepath.Join(stateDir, "auth", "pairings.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	store := &PairingStore{Path: path}
	data, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(data, &store.Pairings); err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return store, nil
}

func (s *PairingStore) Create(endpoint, fingerprint string, skipFingerprintVerification bool, now time.Time) (*PairingPayload, error) {
	pairingID, err := randomEncoded(16)
	if err != nil {
		return nil, err
	}
	token, err := randomEncoded(32)
	if err != nil {
		return nil, err
	}
	saltRaw := make([]byte, 16)
	if _, err := rand.Read(saltRaw); err != nil {
		return nil, err
	}
	expiresAt := now.UTC().Add(2 * time.Minute)
	verifier := deriveVerifier(token, saltRaw)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupLocked(now)
	s.Pairings = append(s.Pairings, PairingRecord{
		PairingID: pairingID,
		Salt:      base64.RawURLEncoding.EncodeToString(saltRaw),
		Verifier:  base64.RawURLEncoding.EncodeToString(verifier),
		ExpiresAt: expiresAt,
	})
	if err := s.saveLocked(); err != nil {
		return nil, err
	}
	return &PairingPayload{Version: 2, Endpoint: endpoint, Fingerprint: fingerprint, SkipFingerprintVerification: skipFingerprintVerification, PairingID: pairingID, Token: token, ExpiresAt: expiresAt}, nil
}

func (s *PairingStore) Save() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked()
}

func (s *PairingStore) Find(pairingID string, now time.Time) (*PairingRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.Pairings {
		if s.Pairings[i].PairingID == pairingID && now.Before(s.Pairings[i].ExpiresAt) {
			record := s.Pairings[i]
			return &record, true
		}
	}
	return nil, false
}

func (s *PairingStore) Cleanup(now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupLocked(now)
	return s.saveLocked()
}

func (s *PairingStore) Consume(pairingID, clientName string, now time.Time) (*PairingRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupLocked(now)
	for i := range s.Pairings {
		if s.Pairings[i].PairingID != pairingID {
			continue
		}
		record := s.Pairings[i]
		record.ClientName = clientName
		s.Pairings = append(s.Pairings[:i], s.Pairings[i+1:]...)
		return &record, s.saveLocked()
	}
	return nil, os.ErrNotExist
}

func (s *PairingStore) cleanupLocked(now time.Time) {
	kept := s.Pairings[:0]
	for _, pairing := range s.Pairings {
		if now.Before(pairing.ExpiresAt) {
			kept = append(kept, pairing)
		}
	}
	s.Pairings = kept
}

func (s *PairingStore) saveLocked() error {
	data, err := json.MarshalIndent(s.Pairings, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(s.Path, data, 0o600)
}

func deriveVerifier(token string, salt []byte) []byte {
	return argon2.IDKey([]byte(token), salt, 3, 64*1024, 1, 32)
}

func randomEncoded(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("random bytes: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
