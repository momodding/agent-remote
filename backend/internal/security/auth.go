package security

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const authContext = "agenticRemote-auth-v2"

type HelloMessage struct {
	PairingID   string `json:"pairingId"`
	ClientNonce string `json:"clientNonce"`
	ClientName  string `json:"clientName"`
}

type ChallengeMessage struct {
	ServerNonce string `json:"serverNonce"`
	ChallengeID string `json:"challengeId"`
	Salt        string `json:"salt"`
}

type SessionTokenRecord struct {
	TokenHash  string    `json:"tokenHash"`
	IssuedAt   time.Time `json:"issuedAt"`
	PairingID  string    `json:"pairingId"`
	ClientName string    `json:"clientName"`
}

type SessionStore struct {
	path     string
	mu       sync.Mutex
	Sessions []SessionTokenRecord
}

type AuthService struct {
	pairings *PairingStore
	sessions *SessionStore
	mu       sync.Mutex
	pending  map[string]pendingChallenge
	now      func() time.Time
	onPaired func()
}

type pendingChallenge struct {
	Pairing     PairingRecord
	ClientNonce string
	ClientName  string
	ServerNonce string
	ChallengeID string
	CreatedAt   time.Time
}

func LoadSessionStore(stateDir string) (*SessionStore, error) {
	path := filepath.Join(stateDir, "auth", "sessions.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	store := &SessionStore{path: path}
	data, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(data, &store.Sessions); err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return store, nil
}

func NewAuthService(pairings *PairingStore, sessions *SessionStore) *AuthService {
	return &AuthService{pairings: pairings, sessions: sessions, pending: map[string]pendingChallenge{}, now: time.Now}
}

func (a *AuthService) SetPairedHook(fn func()) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.onPaired = fn
}

func (a *AuthService) NewPairing(endpoint, fingerprint string, skipFingerprintVerification bool, now time.Time) (*PairingPayload, error) {
	return a.pairings.Create(endpoint, fingerprint, skipFingerprintVerification, now)
}

func (a *AuthService) Begin(msg HelloMessage) (*ChallengeMessage, error) {
	if _, err := decodeNonce(msg.ClientNonce); err != nil {
		return nil, errors.New("authentication failed")
	}
	clientName, err := validateClientName(msg.ClientName)
	if err != nil {
		return nil, errors.New("authentication failed")
	}
	if err := a.pairings.Cleanup(a.now()); err != nil {
		return nil, err
	}
	record, ok := a.pairings.Find(msg.PairingID, a.now())
	if !ok {
		return nil, errors.New("authentication failed")
	}
	serverNonce, err := randomEncoded(32)
	if err != nil {
		return nil, err
	}
	challengeID, err := randomEncoded(16)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	a.pending[challengeID] = pendingChallenge{Pairing: *record, ClientNonce: msg.ClientNonce, ClientName: clientName, ServerNonce: serverNonce, ChallengeID: challengeID, CreatedAt: a.now()}
	a.mu.Unlock()
	return &ChallengeMessage{ServerNonce: serverNonce, ChallengeID: challengeID, Salt: record.Salt}, nil
}

func (a *AuthService) Complete(pairingID, challengeID, proof string) (string, error) {
	if err := a.pairings.Cleanup(a.now()); err != nil {
		return "", err
	}
	a.mu.Lock()
	pending, ok := a.pending[challengeID]
	a.mu.Unlock()
	if !ok || pending.Pairing.PairingID != pairingID || a.now().After(pending.Pairing.ExpiresAt) {
		return "", errors.New("authentication failed")
	}
	expected, err := expectedProof(pending.Pairing, pending.ClientNonce, pending.ServerNonce, challengeID)
	if err != nil {
		return "", err
	}
	provided, err := base64.RawURLEncoding.DecodeString(proof)
	if err != nil || !hmac.Equal(expected, provided) {
		return "", errors.New("authentication failed")
	}
	consumed, err := a.pairings.Consume(pairingID, pending.ClientName, a.now())
	if err != nil {
		return "", errors.New("authentication failed")
	}
	a.mu.Lock()
	delete(a.pending, challengeID)
	onPaired := a.onPaired
	a.mu.Unlock()
	token, err := randomEncoded(32)
	if err != nil {
		return "", err
	}
	if err := a.sessions.SaveToken(token, consumed.PairingID, pending.ClientName, a.now()); err != nil {
		return "", err
	}
	if onPaired != nil {
		onPaired()
	}
	return token, nil
}

func (a *AuthService) Verify(token string) bool {
	if token == "" {
		return false
	}
	return a.sessions.Verify(token)
}

func (s *SessionStore) SaveToken(token, pairingID, clientName string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Sessions = append(s.Sessions, SessionTokenRecord{TokenHash: hashToken(token), IssuedAt: now.UTC(), PairingID: pairingID, ClientName: clientName})
	data, err := json.MarshalIndent(s.Sessions, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(s.path, data, 0o600)
}

func (s *SessionStore) Verify(token string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	hash := hashToken(token)
	for _, session := range s.Sessions {
		if hmac.Equal([]byte(session.TokenHash), []byte(hash)) {
			return true
		}
	}
	return false
}

func expectedProof(record PairingRecord, clientNonce, serverNonce, challengeID string) ([]byte, error) {
	verifier, err := base64.RawURLEncoding.DecodeString(record.Verifier)
	if err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, verifier)
	mac.Write([]byte(authContext))
	mac.Write([]byte(record.PairingID))
	mac.Write([]byte(clientNonce))
	mac.Write([]byte(serverNonce))
	mac.Write([]byte(challengeID))
	return mac.Sum(nil), nil
}

func ClientProof(token, pairingID, salt, clientNonce, serverNonce, challengeID string) (string, error) {
	saltRaw, err := base64.RawURLEncoding.DecodeString(salt)
	if err != nil {
		return "", err
	}
	verifier := deriveVerifier(token, saltRaw)
	mac := hmac.New(sha256.New, verifier)
	mac.Write([]byte(authContext))
	mac.Write([]byte(pairingID))
	mac.Write([]byte(clientNonce))
	mac.Write([]byte(serverNonce))
	mac.Write([]byte(challengeID))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func decodeNonce(raw string) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, err
	}
	if len(decoded) != 32 {
		return nil, errors.New("nonce must be 32 bytes")
	}
	return decoded, nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func validateClientName(name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "", errors.New("invalid client name")
	}
	if utf8.RuneCountInString(trimmed) > 64 {
		return "", errors.New("invalid client name")
	}
	return trimmed, nil
}
