<!-- omp-source-branch: main -->
<!-- omp-work-branch: omp/android-novnc-runtime-debug -->
## Context

Continue the Android Remote Desktop noVNC investigation from the verified transport boundary: the backend connects to `127.0.0.1:5900`, then the Android-side WebSocket disappears without a close frame; the later TCP “use of closed network connection” is teardown noise, not the root cause. Instrument the full VNC path without exposing credentials or framebuffer data, identify the last successful RFB stage, fix only the first verified failure, and iterate against the real Android/VNC runtime until the framebuffer and controls work or an environmental boundary is proven.

## Approach

1. Keep the native raw channel’s lifecycle visible without logging credentials or framebuffer bytes: expose only noVNC’s current RFB initialization state and close/error events to the route status.
2. Deliver queued native frames on a macrotask, not a microtask, so noVNC completes its attachment/open transition before the first server frame is dispatched.
3. Run the VNC TCP and WebSocket pumps independently. A client close half-closes the TCP write side and leaves the read pump alive until the VNC server reaches EOF.

## Critical files & anchors

- `client/app/desktop.tsx`: native WebView raw-channel bridge and React Native WebSocket adapter.
- `backend/internal/server/server.go`: `/v1/ws/vnc` transport bridge.
- `backend/internal/server/server_test.go`: VNC bridge integration tests with a local goroutine TCP server.

## Verification

- `go test ./internal/server` exercises byte flow and downstream data after the WebSocket peer closes.
- Client route tests cover the channel scheduling contract.
- `BROWSER=none make run-client-web` starts the web client without a desktop browser launch.

## Assumptions & contingencies

- No Android runtime is available because `adb` is not installed. The native bridge is therefore verified by unit tests and the web runtime; the visible RFB stage identifies the first remaining Android-only failure.
