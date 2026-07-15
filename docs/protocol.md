# agenticRemote Protocol

## Rolling QR pairing and Auth-v2

1. `agenticRemote serve --config ...` prints a QR payload containing `v`, `endpoint`, `fingerprint`, `pairingId`, `token`, and `expiresAt`, plus the same raw JSON line for paste/debug.
2. The visible QR rolls every 45 seconds. Each token expires 2 minutes after creation, so a scan just before rotation can still complete.
3. Pairing tokens are single-use. The server persists only `pairingId`, `salt`, `verifier`, and `expiresAt`; never the raw `token`. A successful proof consumes the pairing and immediately triggers the daemon to print the next QR.
4. Client opens `/v1/ws/sessions/bootstrap` without a bearer token and sends `auth.hello` with `pairingId`, a base64url 32-byte `clientNonce`, and `clientName`.
5. Server trims `clientName`, rejects empty names and names over 64 Unicode code points, then responds with `auth.challenge` carrying `serverNonce`, `challengeId`, and the stored `salt`.
6. Client derives `verifier = Argon2id(token, salt, time=3, memory=64 MiB, threads=1, keyLen=32)` and sends `auth.proof = HMAC-SHA256(verifier, "agenticRemote-auth-v2" || pairingId || clientNonce || serverNonce || challengeId)`.
7. Server verifies the proof and returns `auth.ok` with a bearer `sessionToken`. The server stores only `sha256(sessionToken)` and the accepted `clientName` at rest.
8. Bootstrap WebSocket accepts only auth frames until `auth.ok`. All REST filesystem/session endpoints, and non-bootstrap session WebSockets, require `Authorization: Bearer <sessionToken>`.
## REST endpoints

- `GET /healthz` → `{"ok":true,"version":"dev"}`.
- `GET /v1/sessions` → session summaries.
- `POST /v1/sessions` → create PTY session from `{name,command,args,cwd,cols,rows}`.
- `POST /v1/sessions/{id}/resize` → resize session.
- `POST /v1/sessions/{id}/input` → send base64 input bytes.
- `POST /v1/sessions/{id}/close` → terminate PTY process tree.
- `GET /v1/fs/list?path=<relative>` → directory entries under `workspaceRoot`.
- `GET /v1/fs/search?q=<name>&path=<relative>` → case-insensitive name search, capped at 200 results.
- `GET /v1/fs/read?path=<relative>` → UTF-8 text only, max 1 MiB.
- `PUT /v1/fs/write` with `{path,content,expectedSha256}` → conditional text write.
- `DELETE /v1/fs/delete` and `POST /v1/fs/rename` → `403` unless destructive actions are enabled.
- `POST /v1/fs/upload?path=<relative-dir>` → multipart upload, max 50 MiB, rooted at `uploadDir`.
- `GET /v1/git/status?path=<relative>` → git short status when available.
- `POST /v1/notify/register` with `{provider:"expo",token:"ExponentPushToken[...]"}` → store push token.

## WSS frames

- `{"type":"pty.input","sessionId":"...","data":"base64 bytes"}`
- `{"type":"pty.output","sessionId":"...","data":"base64 bytes","seq":123}`
- `{"type":"pty.resize","sessionId":"...","cols":120,"rows":34}`
- `{"type":"session.state","sessionId":"...","state":"running|exited|waiting|idle","waitState":{...}}`
- `{"type":"error","code":"...","message":"..."}`

## Filesystem safety rules

All filesystem paths are cleaned with `filepath.Clean`, joined to `workspaceRoot`, converted to absolute paths, then rejected if the path back to the root is absolute or starts with `..`. Listing may surface symlinks, but writes and uploads must not follow symlink targets. Text reads are limited to valid UTF-8 up to 1 MiB. Uploads stay within `uploadDir`.
