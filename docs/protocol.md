# agenticRemote Protocol

## 1. Rolling QR Pairing & Auth-v2

1. `agenticRemote serve --config ...` prints a QR payload containing `v`, `endpoint`, `fingerprint`, `pairingId`, `token`, and `expiresAt`, plus the same raw JSON line for paste/debug.
   `endpoint` is one HTTPS root base URL for this daemon run; it may be loopback, VPN/Tailscale, or a public-CA hostname. Native clients first accept platform-trusted TLS, otherwise they require the QR `fingerprint` to match the presented daemon certificate. Web clients require a browser-trusted certificate.
2. The visible QR rolls every 45 seconds. Each token expires 2 minutes after creation.
3. Pairing tokens are single-use. The server persists only `pairingId`, `salt`, `verifier`, and `expiresAt`; never the raw `token`. A successful proof consumes the pairing and triggers the daemon to print the next QR.
4. Client opens `/v1/ws/sessions/bootstrap` without a bearer token and sends `auth.hello` with `pairingId`, base64url 32-byte `clientNonce`, and `clientName`.
5. Server responds with `auth.challenge` carrying `serverNonce`, `challengeId`, and stored `salt`.
6. Client derives `verifier = HMAC-SHA256(key=token, message=salt)` and sends `auth.proof = HMAC-SHA256(verifier, "agenticRemote-auth-v2" || pairingId || clientNonce || serverNonce || challengeId)`.
7. Server verifies the proof and returns `auth.ok` with a bearer `sessionToken`. The server stores only `sha256(sessionToken)` and the accepted `clientName` at rest.
8. Optional browser pairing page at `GET /pairing` (Basic Auth via `pairingPageUsername`/`pairingPagePassword`) renders the current rotating QR code and raw JSON payload.

## 2. Authentication & Authorization

- **REST Endpoints**: All non-bootstrap REST endpoints require `Authorization: Bearer <sessionToken>`.
- **Control & Terminal WebSockets (`/v1/ws/runtime`, `/v1/ws/sessions/:id`)**: Require an initial authentication envelope sent as the first WebSocket frame: `{"type": "auth.token", "token": "<sessionToken>"}` (`AuthTokenEnvelope`). The server validates the token against active sessions and closes the connection with an `auth_failed` error envelope if missing or invalid.
- **Desktop RFB Proxy Exception (`/v1/ws/rfb`)**: The desktop RFB proxy WebSocket (`/v1/ws/rfb?ticket=<ticket>`) does NOT accept long-lived bearer tokens or `auth.token` frames. It requires a single-use ephemeral ticket issued via `POST /v1/desktop/sessions` passed in the `ticket` query parameter (60-second TTL, SHA-256 hash storage, consumed on connection). Bearer session tokens supplied to `/v1/ws/rfb` are rejected.

Sensitive query parameters (`token` and `ticket`) and authorization headers are automatically redacted in server request logging (`[REDACTED]`).

## 3. REST API Endpoints

### Identity & Health
- `GET /healthz`: Public service health check (`{"status":"ok"}`).
- `GET /ping`: Public simple ping (`pong`).
- `GET /v1/daemon/identity`: Authenticated host identity and daemon capabilities (`HostIdentity` + `capabilities: []`).
- `GET /v1/shells`: Authenticated list of available login shells on the host (`{"shells": ["/bin/bash", ...]}`).

### Terminal Sessions
- `GET /v1/sessions`: List active terminal session summaries.
- `POST /v1/sessions`: Create a new terminal session (`CreateSessionRequest`: `name`, `command`, `args`, `cwd`, `cols`, `rows`, optional `backend`).
- `GET /v1/sessions/:id`: Get session summary.
- `DELETE /v1/sessions/:id`: Terminate session.
- `POST /v1/sessions/:id/restart`: Restart terminal session.
- `WS /v1/ws/sessions/:id`: Raw interactive terminal WebSocket.

### Agent Sessions
- `GET /v1/agents`: List active agent sessions.
- `POST /v1/agents`: Create a new agent session (`CreateSessionRequest`: `name`, `command`, `args`, `cwd`, `cols`, `rows`).
- `GET /v1/agents/:id`: Get agent metadata, capabilities (`chat`, `prompt`, `abort`, `model`, `thinking`), current state (`working`, `idle`, `needsYou`, `exited`), active model, and thinking level.
- `GET /v1/agents/:id/history`: Get full chronological event history (`AgentHistoryResponse`: `cursor`, `events`).
- `POST /v1/agents/:id/prompt`: Submit user message to agent (`{"prompt": "..."}`).
- `POST /v1/agents/:id/abort`: Abort active turn (`{"reason": "..."}`).
- `POST /v1/agents/:id/model`: Switch active model (`{"model": "..."}`).
- `POST /v1/agents/:id/thinking`: Set thinking level (`{"level": "..."}`).
- `DELETE /v1/agents/:id`: Terminate agent session.

### Runtime Snapshot & Events
- `GET /v1/runtime/snapshot`: Get aggregate runtime snapshot containing cursor, terminals, agents, tmux topology, and desktop sessions.
- `GET /v1/runtime/events?after=<cursor>`: Replay runtime lifecycle events since cursor.

### Desktop Sessions
- `POST /v1/desktop/sessions`: Create a single-use ephemeral desktop ticket (60s TTL, SHA-256 hash storage). Returns `DesktopSessionResponse`:
  ```json
  {
    "ticket": "<base64url-ticket>",
    "wsUrl": "wss://<endpoint>/v1/ws/rfb?ticket=<ticket>",
    "expiresAt": "2026-09-17T12:00:00Z"
  }
  ```

### Filesystem
- `GET /v1/fs/list?path=<relpath>`: Directory listing (`ListFilesResponse`).
- `GET /v1/fs/search?path=<relpath>&query=<term>`: Recursive file search.
- `GET /v1/fs/read?path=<relpath>`: Read file content and SHA256 (`ReadFileResponse`).
- `POST /v1/fs/write`: Atomic file write (`WriteFileRequest`: `path`, `content`, `expectedSha256`).
- `POST /v1/fs/delete`: Delete file or directory (`{"path": "..."}`).
- `POST /v1/fs/rename`: Rename path (`RenameFileRequest`: `path`, `newPath`).
- `POST /v1/fs/copy`: Copy path (`CopyFileRequest`: `path`, `newPath`).
- `GET /v1/fs/download?path=<relpath>`: Stream file download.
- `POST /v1/fs/upload`: Multipart file upload.

### Git Status
- `GET /v1/git/status?path=<relpath>`: Repository status (`GitStatusResponse`: `available`, `entries: [{ code, path }]`).

### Push Notifications
- `POST /v1/notify/register`: Register push notification device token (`NotifyRegisterRequest`: `provider`, `token`).

## 4. Runtime WebSocket Multiplexer (`/v1/ws/runtime`)

A single multiplexed WebSocket endpoint supporting multi-surface subscriptions and RPC commands.

### Multiplexed Framing
- **Open Channel**: Client sends `ChannelOpenEnvelope`:
  ```json
  {"type": "channel.open", "requestId": "req-1", "channelId": "ch-1", "kind": "terminal"|"agent"|"topology"|"desktops", "targetId": "session-id", "after": 0}
  ```
- **Channel Opened**: Server confirms with `ChannelOpenedEnvelope`:
  ```json
  {"type": "channel.opened", "requestId": "req-1", "channelId": "ch-1", "cursor": 12}
  ```
- **Stream Events**: Server pushes updates wrapped in `RuntimeEventEnvelope`:
  ```json
  {"type": "event", "channelId": "ch-1", "cursor": 13, "event": {...}}
  ```
  - `terminal` channel payloads: `pty.output` (`sessionId`, `data`, `seq`), `pty.baseline` (`sessionId`, `data`, `seq`), `session.state` (`sessionId`, `state`, `waitState`).
  - `agent` channel payloads: `AgentEvent` (`type`, `agentId`, `text`, `toolName`, `toolInput`, `toolOutput`, `state`, `isError`, etc.).
  - `topology` channel payloads: tmux pane layout snapshots.
- **Client Commands**: Client sends `CommandEnvelope`:
  ```json
  {"type": "command", "requestId": "cmd-1", "targetId": "session-id", "command": "pty.input"|"pty.resize"|"prompt"|"abort"|"model"|"thinking", "args": {...}}
  ```
- **Command Results**: Server responds with `CommandResultEnvelope`:
  ```json
  {"type": "command.result", "requestId": "cmd-1", "ok": true, "result": {...}}
  ```
- **Close Channel**: Client sends `ChannelCloseEnvelope` (`{"type": "channel.close", "channelId": "ch-1"}`); server responds with `ChannelClosedEnvelope` (`{"type": "channel.closed", "channelId": "ch-1", "reason": "closed"}`).

## 5. Direct noVNC RFB Proxy (`/v1/ws/rfb?ticket=`)

Direct binary RFB 3.8 WebSocket transport connecting web and native noVNC clients to the desktop server.

1. **Authentication**: Single-use base64url ticket passed via `?ticket=` query parameter.
2. **Validation**: Non-destructive `Valid()` check prior to local VNC connection; single-use `Consume()` executed after successful WebSocket upgrade (`websocket.Accept`).
3. **Transport**:
   - Binary WebSocket frames only. Text frames rejected with `websocket.StatusUnsupportedData` (1003).
   - 32 MB per-connection frame read limit.
   - Proxies raw RFB protocol frames (handshake, security negotiation, FramebufferUpdate requests/rectangles, pointer/key events) without daemon relay intermediate re-encoding.
