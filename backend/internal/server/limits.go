package server

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"time"
)

var ErrTooManyConnections = errors.New("too many websocket connections")
var ErrTooManySessions = errors.New("too many sessions")

type Limits struct {
	wsSem          chan struct{}
	maxSessions    int64
	activeSessions atomic.Int64
}

func NewLimits(maxConnections, maxSessions int) *Limits {
	return &Limits{wsSem: make(chan struct{}, maxConnections), maxSessions: int64(maxSessions)}
}

func (l *Limits) AcquireWS(ctx context.Context) error {
	select {
	case l.wsSem <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ErrTooManyConnections
	}
}

func (l *Limits) ReleaseWS() {
	select {
	case <-l.wsSem:
	default:
	}
}

func (l *Limits) TryStartSession() bool {
	for {
		current := l.activeSessions.Load()
		if current >= l.maxSessions {
			return false
		}
		if l.activeSessions.CompareAndSwap(current, current+1) {
			return true
		}
	}
}

func (l *Limits) EndSession() {
	l.activeSessions.Add(-1)
}

func ServerTimeouts(handler http.Handler, addr string) *http.Server {
	return &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 120 * time.Second}
}
