package server

import "github.com/agenticremote/agenticremote/backend/internal/security"

// DesktopCloseCategory is a stable close reason exposed by the desktop WebSocket.
type DesktopCloseCategory string

const (
	DesktopCloseWebSocketClosed  DesktopCloseCategory = "websocket_closed"
	DesktopCloseTargetDialFailed DesktopCloseCategory = "target_dial_failed"
	DesktopCloseTargetClosed     DesktopCloseCategory = "target_closed"
	DesktopCloseClientClosed     DesktopCloseCategory = "client_closed"
	DesktopCloseProtocolFailure  DesktopCloseCategory = "protocol_failure"
	DesktopCloseTicketExpired    DesktopCloseCategory = "ticket_expired"
	DesktopCloseTicketInvalid    DesktopCloseCategory = "ticket_invalid"
)

func desktopCloseCategory(reason string) DesktopCloseCategory {
	switch reason {
	case "target_dial_failed":
		return DesktopCloseTargetDialFailed
	case "target_eof", "target_read_error", "target_write_error":
		return DesktopCloseTargetClosed
	case "websocket_read_error", "websocket_write_error", "client_non_binary_frame", "handler_returned":
		return DesktopCloseWebSocketClosed
	case "client_normal_close":
		return DesktopCloseClientClosed
	default:
		return DesktopCloseProtocolFailure
	}
}

func desktopTicketCloseCategory(state security.DesktopTicketState) DesktopCloseCategory {
	if state == security.DesktopTicketExpired {
		return DesktopCloseTicketExpired
	}
	return DesktopCloseTicketInvalid
}
