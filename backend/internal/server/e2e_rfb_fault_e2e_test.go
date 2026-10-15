//go:build e2e

package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestE2ERFBUnavailableTargetClosesUpgradedSocket(t *testing.T) {
	t.Setenv("AGENTICREMOTE_E2E_DESKTOP_TARGET", "127.0.0.1:1")
	srv, _ := newBootstrapServer(t)
	const attemptID = "550e8400-e29b-41d4-a716-446655440003"
	ticket, _, err := srv.desktopTickets.IssueForAttempt("desktop:connect", attemptID, time.Minute, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewTLSServer(srv.Handler())
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, ts.URL+"/v1/ws/rfb?ticket="+url.QueryEscape(ticket), &websocket.DialOptions{HTTPClient: ts.Client()})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	_, _, err = conn.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusTryAgainLater {
		t.Fatalf("expected unavailable-target close, got %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/ws/rfb?ticket="+url.QueryEscape(ticket), nil)
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("expected consumed ticket rejection, got %d", resp.Code)
	}
}
