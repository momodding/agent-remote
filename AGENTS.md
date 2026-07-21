# Repository Guidelines

## Project Overview

agenticRemote provides remote control of AI terminal sessions through a host daemon plus a managed Expo/React Native client. The backend lives in `backend/` as a Go module and builds a single daemon/CLI binary named `agenticRemote`. The client lives in `client/` as an Expo Router TypeScript app using NativeWind, React Native Reusables patterns, and an xterm WebView.

## Architecture & Data Flow

The daemon exposes HTTPS REST endpoints plus authenticated WSS session streams. Pairing creates one-time client credentials; the client scans a QR payload, completes Auth-v2, then uses a bearer session token for REST and WSS access. Expo Go cannot dynamically pin a daemon certificate; self-signed/direct-LAN payloads must opt in with `skipFingerprintVerification:true`. PTY session state, pairing verifier material, session bearer-token hashes, notification tokens, and scrollback persist under the daemon state directory. Backend protocol types are defined once in `backend/internal/protocol` and mirrored in `client/src/protocol.ts`.

## Key Directories

- `backend/cmd/agenticRemote`: CLI entrypoint and subcommands.
- `backend/internal/config`: config loading, defaults, validation.
- `backend/internal/protocol`: canonical Go wire types.
- `backend/internal/security`: TLS, pairing, Auth-v2, session token hashing.
- `backend/internal/server`: HTTP/WSS handlers, auth gates, limits.
- `backend/internal/session`: PTY lifecycle, persistence, previews.
- `backend/internal/detect`: ANSI stripping and wait-state detection.
- `backend/internal/notify`: local/log and Expo push notifications.
- `backend/internal/fs`: workspace-safe filesystem operations.
- `client/app`, `client/src`: Expo Router routes, protocol models, services, state, and terminal components.
- `client/src/**/*.test.ts`: TypeScript unit tests.
- `scripts`: install, uninstall, and release-integrity helpers.
- `docs`: implementation docs, especially protocol behavior.
- `examples`: runnable local config examples.

## Development Commands

- `make backend-test`
- `make backend-build`
- `make client-test`
- `make client-build-web`
- `make test`
- `make lint`
- `make run-daemon`
- `make run-client`

## Code Conventions & Common Patterns

Go packages live under `backend/internal/<behavior>`. Keep exported Go symbols PascalCase. Keep JSON wire fields lowerCamelCase. Put API and wire-contract types in `backend/internal/protocol` and mirror them in `client/src/protocol.ts`. TypeScript filenames use snake_case only for non-component modules; Expo route/component files follow React conventions. Prefer direct, boring packages over cross-cutting abstraction. Never store raw pairing tokens in backend state; persist only verifier material. Reject unauthenticated filesystem and session endpoints.

## Important Files

- `client/app/index.tsx`: pairing flow and session dashboard.
- `client/src/lib/api.ts`: Auth-v2 pairing and authenticated REST client.
- `client/src/lib/session-socket.ts`: authenticated PTY WebSocket protocol.
- `client/src/components/ShortcutKeyboard.tsx`: mobile terminal keyboard mappings.
- `client/src/components/Terminal.tsx`: local xterm WebView bridge.
- `client/src/protocol.ts`: TypeScript mirror of backend protocol messages.

## Runtime/Tooling Preferences

Use the Go standard library first; add dependencies only where the plan already requires them. The backend should remain a single compiled binary per target OS/arch. The client must remain in Expo Managed workflow and Expo-Go-compatible. Keep daemon state in `.agenticremote/` by default. Treat HTTPS/WSS as mandatory; do not introduce plaintext control paths.

## Testing & QA

Go tests live beside their packages as `*_test.go`. Client tests live as `client/src/**/*.test.ts`. Run `make backend-test` for backend proof, `make client-test` for TypeScript/Jest proof, `make client-build-web` for Expo web export proof, and `make lint` for vet/typecheck. Verify auth, filesystem safety, detector behavior, and keyboard mappings through observable tests rather than snapshots.
