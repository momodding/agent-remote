<!-- source-branch: main -->
<!-- work-branch: omp/architecture-refactor -->

# Architecture refactor plan

## Goal
Convert the client to host-first, daemon-mediated remote access while retaining Expo Managed and Expo Go compatibility. Repair daemon VNC on web and native by letting noVNC establish its authenticated WebSocket directly inside the WebView; do not maintain a native byte bridge.

## Assumptions
- Direct SSH/SFTP from React Native requires native TCP/cryptography code and therefore a custom development client or prebuilt app; it cannot satisfy Expo Go compatibility.
- Resolution: retain Expo Managed and Expo Go compatibility. Do not add a direct SSH/SFTP client. Route SSH/PTY, file transfer, VNC, and agent discovery through the authenticated daemon.

## Decisions
- Persist and route with `hostId`, `connectionId`, and `sessionId`; migrate every endpoint-keyed caller in one cutover.
- The daemon owns SSH/PTY, files, VNC, and agent session creation. Do not add a native SSH/SFTP dependency.
- Define daemon capabilities and agent discovery in `backend/internal/protocol`, expose authenticated endpoints, and mirror their wire types in `client/src/protocol.ts`.
- Model terminal, files, desktop, and agents behind capability-oriented client providers. Providers consume daemon APIs, not routes or transport internals.
- noVNC 1.7.0 uses a direct authenticated WebSocket URL in WebView on both platforms. This is the only Expo-Go-compatible bidirectional transport without per-frame JavaScript injection.
- Desktop availability derives from host capabilities. Remove build-time `EXPO_PUBLIC_ENABLE_NOVNC` gating.

## Execution
1. Inspect current contracts, routes, persistence, and package resolution; add precise compatibility tests first where current coverage exists.
2. Add capabilities and agent-discovery contracts to Go and TypeScript; register authenticated server handlers and test authorization/result behavior.
3. Replace endpoint identity with host/connection/session identity in connection persistence, API calls, routes, multi-session state, and existing tests.
4. Add minimal capability providers and migrate terminal, files, desktop, and agents to their boundaries.
5. Upgrade noVNC to 1.7.0. Replace the React Native VNC byte bridge with direct authenticated WebSocket initialization inside the WebView. Use capability-based Desktop navigation on web and native.
6. Apply the dense operational host UI only where the identity/capability migration touches existing screens; preserve existing visual system elsewhere.
7. Run targeted Go and client tests, then the prescribed build/lint checks affected by the refactor. Record a PR description with behavior, protocol changes, and verification.

## Acceptance
- Android and web noVNC connect through daemon-authenticated WSS without `injectJavaScript` data forwarding or a custom native module.
- An Expo Go client requires no direct SSH/SFTP native dependency.
- Desktop and agent affordances are driven by authenticated daemon capabilities, not build flags.
- No endpoint-keyed client routing/persistence caller remains.
- Daemon APIs reject unauthenticated access and use existing session lifecycle for agent launches.
- Go and client contract tests pass; client web build and lint complete.
