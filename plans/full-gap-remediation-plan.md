<!-- omp-source-branch: main -->
<!-- omp-work-branch: omp/full-gap-remediation-plan -->
# Full Gap Remediation Plan

## Executive Summary
This plan redesigns the agenticRemote mobile application to align with the recorded Termius UX (Vaults, Connections, Settings), eliminate all hardcoded mock paths (like the `agent-${Date.now()}` fallback and artificial `setTimeout` in the `noVNC` bridge), and fully wire the frontend to realistic daemon capabilities for Agent Chat, Terminal, Desktop (VNC), and the Filesystem.

## Context
The current implementation possesses three principal issues:
1. **Daemon-Coupled Main UI**: A fresh install defaults to a pairing flow, forcing a daemon dependency before the user can see the AppShell.
2. **Fake Agent Discoveries/Fallbacks**: `client/src/lib/daemon-channel.ts` intercepts agent creation failures and returns fake IDs (`agent-${Date.now()}`). Agent parameters (like `cwd` and harness command) aren't dynamically selected by the user.
3. **Broken VNC Lifecycles**: `client/app/desktop.tsx` and the `noVNC` BridgeWebSocket wrapper report `readyState = 1` immediately using an artificial `setTimeout`, leading to VNC RFB handshake desynchronization before the underlying WSS proxy responds.

## Approach

### Phase 1: AppShell Decoupling & Navigation
- Repurpose the root layout to always land on `Vaults`, removing global dependencies on daemon endpoints.
- Introduce a Termius-style Connections runtime deck to enumerate active daemon instances.
- Introduce a "New Connection" flow when clicking on a daemon host, bringing up the launchers for: Agent Session, Terminal, Files, Desktop.

### Phase 2: Termius-style Connections Runtime Model
- Retain horizontal mapping in `client/src/lib/tabs/tab-store.ts`, but pivot it from a daemon-specific tab deck to an active task workspace.
- Ensure that tapping "Back" from a tab (`/agent/[id]`) returns to Connections rather than killing the remote session.
- Close actions explicitly invoke `closeTab()`.

### Phase 3: Directory Picker & Filesystem Unification
- Unify directory browsing in `client/src/components/DirectoryPicker.tsx` using the `DaemonFileProvider`.
- Fetch real `cwd` values through `GET /v1/fs/list` mapped to workspace roots instead of allowing empty string defaults.

### Phase 4: Agent Session Wiring & Adapters (No Fake Responses)
- Remove `agent-${Date.now()}` fallbacks in `openChannel()` in `client/src/lib/daemon-channel.ts`.
- Refactor the daemon backend to expose an `AgentHarnessDescriptor` slice on `GET /v1/agents`.
- Expand agent session metadata mapping (`meta: Record<string, unknown>`) to capture exact CLI interfaces for `claude` and `omp` (discovering them by path rather than assuming an open string command execution path).
- Rework `AgentScreen` UI interaction to launch sessions based exclusively on choices (Harness + DirectoryPicker `cwd`).

### Phase 5: noVNC and Desktop Repair
- Eradicate the fake `setTimeout` logic inside `BridgeWebSocket` (found in `desktop.tsx` / `desktop.web.tsx`).
- Delay signaling `readyState = 1` and triggering `noVNC.connect()` until the daemon WSS endpoint (`/v1/ws/vnc`) completely negotiates over TCP.
- Suppress injecting JavaScript proxy framing (`injectJavaScript`) in mobile targets, replacing it with a deterministic React Native WebView messaging bridge for binary streams.

### Phase 6: E2E and Visual Tests
- Use deterministic processes for verifying E2E connections. Launch a local TCP server acting as an RFB fixture on `make backend-test`.
- Create a test harness loop for `claude`/`omp` binary mock tests enforcing stdout payload stream.

## Critical files & anchors
- `client/app/index.tsx`: Revamp root connection view to `Vaults` view instead of automatically binding a tab-store daemon layout.
- `client/src/lib/daemon-channel.ts`: Purge the `agent-${Date.now()}` fallback from `openChannel` and handle explicit `command`, `cwd` selections seamlessly without defaulting to `"omp"` silently.
- `client/app/desktop.tsx` and `client/app/desktop.web.tsx`: Redesign `BridgeWebSocket` to correctly delay RFB negotiations until daemon `v1/ws/vnc` is verified open.
- `backend/internal/server/server.go`: Expose `GET /v1/agents` capabilities endpoints and map the `AgentHarnessDescriptor`.

## Verification
- **App Startup**: Boot the app with zero daemons configured in the local store. Validate `Vaults` and `Connections` panels are reachable natively.
- **Agent Harness Discovery**: Validate `GET /v1/agents` returns real system executables. Start an Agent Session in a specific directory using the generalized `DirectoryPicker`. Confirm actual remote `cwd` matches.
- **noVNC Handshake**: Launch a bare `rfb` service backend. Connect via `desktop.tsx`, trace WSS `/v1/ws/vnc` proxy, and guarantee `ServerInit` populates `noVNC` without desync crashes.
- **Persistence Checks**: Instantiate a Terminal and Agent workspace tab. Tab away to `Vaults` via back navigation. Tab back; sessions remain strictly persistent and do not terminate arbitrarily.
