<!-- omp-source-branch: main -->
<!-- omp-work-branch: omp/config-reinit-terminal -->
## Context

Two tasks: (1) Make `agenticRemote config init` update an existing config instead of erroring, and when re-initializing remove TLS certificates, session tokens, and pairing state so stale credentials don't silently point at the old server identity. (2) Fix the Android client so tapping a session card opens an interactive terminal — currently the client pairs and creates sessions successfully but the terminal never displays.

## Approach

### Step 1 — Backend config init: support file-or-directory target and re-init cleanup

**1a. Normalize `--path` before every config init action.**

In `backend/cmd/agenticRemote/main.go`, inside `run`, `case "config"`, after validating `*path != ""`, resolve the user-supplied value to a config file path:

```go
		configPath := *path
		if info, err := os.Stat(configPath); err == nil && info.IsDir() {
			configPath = filepath.Join(configPath, "config.json")
		} else if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
```

Use `configPath` for all remaining init work. This keeps existing `--path examples/config.local.json` behavior and adds the requested directory case: `--path /some/dir` writes `/some/dir/config.json`.

**1b. Make `config.WriteSample` overwrite.**

In `backend/internal/config/config.go`, function `WriteSample` (line 114), delete the `os.Stat` guard that returns `"config already exists"` (lines 115-119). Keep the existing JSON marshal and `os.WriteFile(path, data, 0o644)`. The final behavior: creating a new config and replacing an existing config use the same function.

**1c. Add `config.CleanState(configPath string) error`.**

In `backend/internal/config/config.go`, add this exported function after `Load` or after `WriteSample`:

```go
func CleanState(configPath string) error {
	cfg := Default()
	if data, err := os.ReadFile(configPath); err == nil {
		if err := json.Unmarshal(data, &cfg); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	stateDir := filepath.Join(filepath.Dir(configPath), cfg.StateDir)
	for _, name := range []string{"tls", "auth", "sessions"} {
		if err := os.RemoveAll(filepath.Join(stateDir, name)); err != nil {
			return err
		}
	}
	return nil
}
```

This removes exactly the state that can make a re-init stale or misleading:

- `tls/` — `backend/internal/security/tls.go` stores `cert.pem` and `key.pem` there.
- `auth/` — `backend/internal/security/pairing.go` and `auth.go` store `pairings.json` and `sessions.json` there.
- `sessions/` — `backend/internal/session/manager.go` stores `sessions.json` and `*.scrollback` there.

Do not remove `notify/`; push token registrations are not certificate, pairing, auth-session, or PTY session state.

**1d. Wire cleanup before overwrite.**

In `backend/cmd/agenticRemote/main.go`, replace the existing config init tail (currently `cfg := config.Default()`, `os.MkdirAll(filepath.Dir(*path), 0o755)`, `config.WriteSample(*path, cfg)`) with:

```go
		if _, err := os.Stat(configPath); err == nil {
			if err := config.CleanState(configPath); err != nil {
				return fmt.Errorf("cleaning state: %w", err)
			}
			fmt.Fprintln(os.Stderr, "existing config found; TLS certificates, pairings, auth sessions, and PTY sessions removed")
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		cfg := config.Default()
		if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
			return err
		}
		return config.WriteSample(configPath, cfg)
```

No new flag. No backup file. Re-init means overwrite the config and clear stale identity/session state.

**1e. Add backend tests.**

Add tests in `backend/internal/config/config_test.go`:

- `TestWriteSampleOverwritesExistingFile`: create a temp `config.json` with junk JSON, call `WriteSample(path, Default())`, read it back with `Load(path)`, expect no error and `ListenScheme == "https"`.
- `TestCleanStateRemovesIdentityAndSessionState`: create temp `config.json` with `{"stateDir":"state"}`, create files under `state/tls/cert.pem`, `state/auth/sessions.json`, `state/sessions/sessions.json`, and `state/notify/tokens.json`; call `CleanState(path)`; assert `tls`, `auth`, and `sessions` paths no longer exist and `state/notify/tokens.json` still exists.

Add one CLI-level test in `backend/cmd/agenticRemote/main_test.go`:

- `TestConfigInitAcceptsDirectoryAndReinitializes`: create temp directory, call `run([]string{"config", "init", "--path", dir})`, assert `dir/config.json` exists. Create `dir/.agenticremote/tls/cert.pem`, `dir/.agenticremote/auth/sessions.json`, and `dir/.agenticremote/sessions/sessions.json`; call the same `run` again; assert those three directories are removed and `dir/config.json` still loads via `config.Load`.

### Step 2 — Backend terminal websocket: decode input bytes

In `backend/internal/server/server.go`, import `encoding/base64`.

In `handleSessionWS`, case `"pty.input"` (lines 298-302), the server currently passes `[]byte(env.Data)` into `s.sessions.Input`, but `env.Data` is documented and emitted by the client as base64 text. Replace that case body with base64 decoding before calling the session manager:

```go
		case "pty.input":
			var env protocol.PTYInputEnvelope
			if err := mapToStruct(frame, &env); err == nil {
				data, err := base64.StdEncoding.DecodeString(env.Data)
				if err != nil {
					_ = wsWriteJSON(ctx, conn, protocol.ErrorEnvelope{Type: "error", Code: "bad_request", Message: "invalid pty input data"})
					continue
				}
				_ = s.sessions.Input(sessionID, data)
			}
```

This matches `docs/protocol.md`, which defines `pty.input.data` as base64 bytes, and matches the existing Dart client `sendInput`, which already calls `base64Encode(bytes)`.

Add/adjust a server test in `backend/internal/server/server_test.go`: keep `TestBootstrapAcceptsSessionFramesWithoutAuth` for the current auth placeholder, and add `TestSessionWSDecodesBase64Input` that creates a real session through `newTestServer(t).sessions.Create`, connects to `/v1/ws/sessions/<id>`, sends `{"type":"pty.input","sessionId":"<id>","data":"aGk="}`, then asserts `srv.sessions.List(context.Background())[0].Preview` contains `"hi"` rather than the literal base64 text `"aGk="`.

### Step 2 — Client terminal: open session screen and use per-session websocket

**2a. Remove the bootstrap websocket from `_authenticate`.**

In `client/lib/src/services/agentic_remote_api.dart`, `_authenticate` currently opens `/v1/ws/sessions/bootstrap` and stores it in `_channel`. Delete that websocket setup from `_authenticate`; leave `bearerToken = 'dev-no-auth';` as the current auth placeholder because HTTP session creation already works in this codebase and the server currently uses `authed := true` in `handleSessionWS`.

Delete the `_channel` field if no longer used. Add `WebSocketChannel? _sessionChannel;` as the only websocket field.

**2b. Add per-session websocket connection.**

In `client/lib/src/services/agentic_remote_api.dart`, add:

```dart
  void connectSession(String sessionId) {
    final endpoint = agenticEndpointUri(
      pairing!.endpoint,
      '/v1/ws/sessions/$sessionId',
      scheme: agenticWebSocketScheme(pairing!.endpoint),
    );
    _sessionChannel?.sink.close();
    _sessionChannel = connectWebSocket(
      endpoint,
      trustedFingerprint: _trustedFingerprint,
      formatFingerprint: formatCertificateFingerprint,
      skipFingerprintVerification: _skipFingerprintVerification,
    );
    _sessionChannel!.stream.listen((raw) {
      final msg = jsonDecode(raw as String) as Map<String, dynamic>;
      if (msg['type'] == 'pty.output') {
        terminalOutput.add(msg);
      }
    });
  }
```

The server route at `backend/internal/server/server.go:269` strips `/v1/ws/sessions/` and subscribes to that suffix as the session ID, so `/v1/ws/sessions/$sessionId` is the required path. Keep one active terminal websocket; opening a different terminal closes the previous one. No multi-terminal manager — not requested.

**2c. Send input and resize through the session websocket.**

In `client/lib/src/services/agentic_remote_api.dart`:

- In `resizeSession`, change `_channel?.sink.add(...)` to `_sessionChannel?.sink.add(...)`.
- In `sendInput`, change `_channel?.sink.add(...)` to `_sessionChannel?.sink.add(...)`.

Keep the JSON envelopes unchanged: `type: "pty.resize"` and `type: "pty.input"` with base64-encoded input bytes.

**2d. Subscribe `TerminalScreen` to terminal output.**

In `client/lib/src/features/terminal/terminal_screen.dart`:

- Add `import 'dart:async';`.
- Add `StreamSubscription<Map<String, dynamic>>? _sub;` as a field on `_TerminalScreenState`.
- In `initState`, after setting `terminal.onResize`, call `widget.api.connectSession(widget.sessionId);` and subscribe to `widget.api.terminalOutput.stream`.
- In the subscription, ignore messages whose `sessionId` is not `widget.sessionId`. For matching messages, decode the base64 `data` field and write UTF-8 text to xterm:

```dart
      _sub = widget.api.terminalOutput.stream.listen((msg) {
        if (msg['sessionId'] != widget.sessionId) {
          return;
        }
        final bytes = base64Decode(msg['data'] as String);
        terminal.write(utf8.decode(bytes, allowMalformed: true));
      });
```

- Add `dispose` to cancel `_sub` before `super.dispose()`.

The xterm package has `Terminal.write(String data)` in `xterm-4.0.0/lib/src/terminal.dart`, so write decoded text, not bytes.

**2e. Navigate from session cards to `TerminalScreen`.**

In `client/lib/src/features/dashboard/session_dashboard.dart`:

- Add imports:
  - `../../services/agentic_remote_api.dart`
  - `../terminal/terminal_screen.dart`
- Update the grid item builder at line 118 to pass the API:

```dart
_SessionCard(session: filtered[index], api: widget.state.api)
```

- Change `_SessionCard` to:

```dart
class _SessionCard extends StatelessWidget {
  const _SessionCard({required this.session, required this.api});

  final SessionSummary session;
  final AgenticRemoteApi api;
```

- Wrap the returned `ShadCard` in `GestureDetector`:

```dart
    return GestureDetector(
      onTap: () {
        Navigator.of(context).push(
          PageRouteBuilder(
            pageBuilder: (_, __, ___) => Directionality(
              textDirection: TextDirection.ltr,
              child: TerminalScreen(api: api, sessionId: session.id),
            ),
          ),
        );
      },
      child: ShadCard(
        ...existing child...
      ),
    );
```

Do not wire the existing `Close` button yet; it currently does nothing and the request is to show a terminal, not close sessions.

**2f. Add lightweight client tests.**

In `client/test/agentic_remote_api_test.dart`, add one URI test:

```dart
test('agenticEndpointUri builds session websocket path', () {
  expect(
    agenticEndpointUri(
      'https://host.example',
      '/v1/ws/sessions/session-1',
      scheme: 'wss',
    ).toString(),
    'wss://host.example/v1/ws/sessions/session-1',
  );
});
```

In `client/test/session_dashboard_test.dart`, extend `search filters cards...` to assert session cards are tappable without changing filtering behavior:

- Find `find.text('alpha')` after filtering and assert it still exists.
- Do not tap in this test because tapping opens `TerminalScreen`, which immediately calls `connectSession` and would require a real websocket. The end-to-end Android smoke test below covers the tap.

## Critical files & anchors

- `backend/internal/config/config.go:114` — `WriteSample`; add overwrite behavior and `CleanState`.
- `backend/cmd/agenticRemote/main.go:124-140` — `config init`; normalize directory path, call `CleanState`, overwrite config.
- `backend/internal/server/server.go:263-333` — websocket `pty.input`; decode base64 before passing bytes to the session manager.
- `client/lib/src/services/agentic_remote_api.dart:73-159` — websocket fields, `_authenticate`, `connectSession`, `sendInput`, `resizeSession`.
- `client/lib/src/features/terminal/terminal_screen.dart:19-42` — connect session websocket, listen for `pty.output`, write to xterm.
- `client/lib/src/features/dashboard/session_dashboard.dart:117-276` — pass API into cards and navigate to `TerminalScreen` on tap.

## Verification

Backend proof:

```bash
make backend-test
make backend-build
```

Backend manual smoke after `make backend-build`:

```bash
tmpdir=$(mktemp -d)
backend/bin/agenticRemote config init --path "$tmpdir"
mkdir -p "$tmpdir/.agenticremote/tls" "$tmpdir/.agenticremote/auth" "$tmpdir/.agenticremote/sessions" "$tmpdir/.agenticremote/notify"
touch "$tmpdir/.agenticremote/tls/cert.pem" "$tmpdir/.agenticremote/auth/sessions.json" "$tmpdir/.agenticremote/sessions/sessions.json" "$tmpdir/.agenticremote/notify/tokens.json"
backend/bin/agenticRemote config init --path "$tmpdir"
test -f "$tmpdir/config.json"
test ! -e "$tmpdir/.agenticremote/tls"
test ! -e "$tmpdir/.agenticremote/auth"
test ! -e "$tmpdir/.agenticremote/sessions"
test -f "$tmpdir/.agenticremote/notify/tokens.json"
```

Client proof:

```bash
make client-test
make client-build CLIENT_TARGETS=android
```

Client manual Android smoke:

1. Start daemon with a fresh or re-initialized config: `backend/bin/agenticRemote serve --config <config.json>`.
2. Pair the Android app from the daemon QR payload.
3. Tap `New session`.
4. Tap the new session card.
5. Expected: app navigates to a terminal screen; shell output appears; typing through the terminal or shortcut keyboard sends input and changes terminal output.

## Assumptions & contingencies

- `--path` now accepts either a file path or an existing directory. If the path is an existing directory, the config file is exactly `<dir>/config.json`; if the path does not exist, it is treated as a file path, matching current behavior.
- Re-init cleanup reads existing config to honor a custom `stateDir`. If existing config JSON is invalid, `CleanState` returns the JSON error and does not overwrite; the user must fix/remove that file first so the code does not guess the wrong state directory and leave stale identity material behind.
- One active terminal websocket is enough: the mobile UI opens one terminal screen at a time. If multi-terminal tabs are added later, replace `_sessionChannel` with a map keyed by session ID.
