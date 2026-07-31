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

	"github.com/skip2/go-qrcode"
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

// PairingPresentation publishes canonical rotating snapshot with JSON/QR/TTY derivatives.
// All three representations (JSON, PNG QR, terminal QR) derive from the same
// compact canonical JSON bytes, ensuring byte-for-byte consistency.
type PairingPresentation struct {
	Payload       *PairingPayload `json:"-"`
	CanonicalJSON []byte          `json:"-"`
	QRPng         []byte          `json:"-"`
	QRTerminal    string          `json:"-"`
}

// PairingSnapshot publishes the latest pairing presentation for web/console without
// exposing the mutable rotation state. Load/Store deeply clone all byte slices.
type PairingSnapshot struct {
	mu           sync.RWMutex
	presentation *PairingPresentation
}

func (s *PairingSnapshot) Store(presentation *PairingPresentation) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if presentation == nil {
		s.presentation = nil
		return
	}
	clone := &PairingPresentation{
		CanonicalJSON: append([]byte(nil), presentation.CanonicalJSON...),
		QRPng:         append([]byte(nil), presentation.QRPng...),
		QRTerminal:    presentation.QRTerminal,
	}
	if presentation.Payload != nil {
		p := *presentation.Payload
		clone.Payload = &p
	}
	s.presentation = clone
}

func (s *PairingSnapshot) Load() (*PairingPresentation, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.presentation == nil {
		return nil, false
	}
	clone := &PairingPresentation{
		CanonicalJSON: append([]byte(nil), s.presentation.CanonicalJSON...),
		QRPng:         append([]byte(nil), s.presentation.QRPng...),
		QRTerminal:    s.presentation.QRTerminal,
	}
	if s.presentation.Payload != nil {
		p := *s.presentation.Payload
		clone.Payload = &p
	}
	return clone, true
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

func (s *PairingStore) Create(endpoint, fingerprint string, skipFingerprintVerification bool, lifetime time.Duration, now time.Time) (*PairingPayload, error) {
	if lifetime <= 0 {
		return nil, fmt.Errorf("lifetime must be positive")
	}
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
	expiresAt := now.UTC().Add(lifetime)
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

// BuildPresentation creates an immutable canonical presentation from a payload.
// The canonical JSON is marshaled once; QR PNG and terminal renderings derive from it.
// If any step fails, returns an error without creating a partial presentation.
func BuildPresentation(payload *PairingPayload) (*PairingPresentation, error) {
	if payload == nil {
		return nil, fmt.Errorf("payload required")
	}
	// Marshal once to canonical compact JSON
	canonicalJSON, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("canonical marshal: %w", err)
	}
	// Generate QR PNG from canonical bytes
	qrPng, err := qrcode.Encode(string(canonicalJSON), qrcode.Medium, 384)
	if err != nil {
		return nil, fmt.Errorf("qr png: %w", err)
	}
	// Generate QR terminal rendering from canonical bytes
	qrObj, err := qrcode.New(string(canonicalJSON), qrcode.Medium)
	if err != nil {
		return nil, fmt.Errorf("qr object: %w", err)
	}
	qrTerminal := qrObj.ToSmallString(false)
	// Clone payload
	payloadClone := *payload
	return &PairingPresentation{
		Payload:       &payloadClone,
		CanonicalJSON: canonicalJSON,
		QRPng:         qrPng,
		QRTerminal:    qrTerminal,
	}, nil
}
