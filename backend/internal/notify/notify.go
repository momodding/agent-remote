package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/agenticremote/agenticremote/backend/internal/protocol"
)

type Notifier interface {
	Notify(context.Context, Event) error
}

type Event struct {
	SessionID   string    `json:"sessionId"`
	SessionName string    `json:"sessionName"`
	Kind        string    `json:"kind"`
	Title       string    `json:"title"`
	Body        string    `json:"body"`
	At          time.Time `json:"at"`
}

type LogNotifier struct{}

type ExpoNotifier struct {
	Endpoint string
	Client   *http.Client
	Tokens   *TokenStore
}

type Fanout struct {
	Log  *LogNotifier
	Expo *ExpoNotifier
}

type TokenRecord struct {
	Provider string `json:"provider"`
	Token    string `json:"token"`
}

type TokenStore struct {
	path   string
	mu     sync.Mutex
	Tokens []TokenRecord
}

func LoadTokenStore(stateDir string) (*TokenStore, error) {
	path := filepath.Join(stateDir, "notify", "tokens.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	store := &TokenStore{path: path}
	data, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(data, &store.Tokens); err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return store, nil
}

func (n *LogNotifier) Notify(_ context.Context, event Event) error {
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	log.Print(string(data))
	return nil
}

func (n *ExpoNotifier) Notify(ctx context.Context, event Event) error {
	if n == nil || n.Tokens == nil || len(n.Tokens.Tokens) == 0 {
		return nil
	}
	for _, token := range n.Tokens.Tokens {
		payload := map[string]any{"to": token.Token, "title": event.Title, "body": event.Body, "data": event}
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, n.Endpoint, bytes.NewReader(data))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := n.Client.Do(req)
		if err != nil {
			return err
		}
		resp.Body.Close()
	}
	return nil
}

func (f *Fanout) Notify(ctx context.Context, event Event) error {
	if f.Log != nil {
		if err := f.Log.Notify(ctx, event); err != nil {
			return err
		}
	}
	if f.Expo != nil {
		_ = f.Expo.Notify(ctx, event)
	}
	return nil
}

func (t *TokenStore) RegisterToken(_ context.Context, req protocol.NotifyRegisterRequest) error {
	if req.Provider != "expo" || req.Token == "" {
		return errors.New("unsupported notification provider")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, existing := range t.Tokens {
		if existing.Provider == req.Provider && existing.Token == req.Token {
			return nil
		}
	}
	t.Tokens = append(t.Tokens, TokenRecord{Provider: req.Provider, Token: req.Token})
	data, err := json.MarshalIndent(t.Tokens, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(t.path, data, 0o600)
}
