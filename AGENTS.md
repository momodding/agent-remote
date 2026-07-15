# Repository Guidelines

## Project Overview

agenticRemote provides remote control of AI terminal sessions through a host daemon plus a Flutter client. The backend lives in `backend/` as a Go module and builds a single daemon/CLI binary named `agenticRemote`. The client lives in `client/` as a Flutter app using `shadcn_ui` and `xterm`.

## Architecture & Data Flow

The daemon exposes HTTPS REST endpoints plus authenticated WSS session streams. Pairing creates one-time client credentials; the client scans a QR payload, validates the daemon certificate fingerprint, completes Auth-v2, then uses a bearer session token for REST and WSS access. PTY session state, pairing verifier material, session bearer-token hashes, notification tokens, and scrollback persist under the daemon state directory. Backend protocol types are defined once in `backend/internal/protocol` and mirrored in `client/lib/src/protocol`.

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
- `client/lib/src`: protocol models, services, state, theme, features.
- `client/test`: Flutter unit and widget tests.
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

Go packages live under `backend/internal/<behavior>`. Keep exported Go symbols PascalCase. Keep JSON wire fields lowerCamelCase. Put API and wire-contract types in `backend/internal/protocol` and mirror them in `client/lib/src/protocol`. Dart filenames use snake_case. Prefer direct, boring packages over cross-cutting abstraction. Never store raw pairing tokens; persist only verifier material. Reject unauthenticated filesystem and session endpoints.

## Important Files

- `AGENTS.md`: repository operating guidance for future assistants.
- `Makefile`: root development entrypoints.
- `backend/internal/protocol/protocol.go`: canonical server message schema.
- `backend/internal/security/auth.go`: Auth-v2 proof verification and session-token issuance.
- `backend/internal/session/manager.go`: PTY orchestration and scrollback lifecycle.
- `client/lib/src/protocol/messages.dart`: Dart mirror of backend protocol messages.
- `client/lib/src/features/terminal/shortcut_keyboard.dart`: custom mobile terminal keyboard mappings.

## Runtime/Tooling Preferences

Use the Go standard library first; add dependencies only where the plan already requires them. The backend should remain a single compiled binary per target OS/arch. The Flutter client may use standard Flutter ecosystem packages named in the plan. Keep daemon state in `.agenticremote/` by default. Treat HTTPS/WSS as mandatory; do not introduce plaintext control paths.

## Testing & QA

Go tests live beside their packages as `*_test.go`. Flutter tests live under `client/test/`. Run `make backend-test` for backend proof, `make client-test` for Dart/Flutter proof, `make client-build-web` for web build proof, and `make lint` for vet/analyze. Verify auth, filesystem safety, detector behavior, and keyboard mappings through observable tests rather than snapshots.
