<!-- omp-source-branch: main -->
<!-- omp-work-branch: omp/recover-agent-architecture -->
# Agent Chat and Multi-Agent Runtime Recovery Plan

## Goal
Restore Agent Chat as a real daemon-backed surface and evolve the current single-PTY session manager into a multi-agent runtime without replacing working terminal behavior. Chat and Raw Terminal MUST address one `AgentSession`, one `TerminalRuntime`, and one OMP TUI process. Add tmux persistence, daemon-authoritative recovery, multi-daemon navigation, sandboxed Files links, and direct noVNC WebSockets incrementally.

## Grounded starting point
- `backend/internal/session/manager.go` owns `pty.StartWithSize`, `*exec.Cmd`, `*os.File`, output sequencing, scrollback files, detector state, subscribers, and metadata restore. Restart currently marks every restored PTY session exited.
- `backend/internal/protocol/protocol.go` has only PTY/state envelopes. `backend/internal/server/server.go` exposes REST sessions plus one WebSocket per `/v1/ws/sessions/:id`.
- `client/src/lib/tabs/types.ts` supports only `terminal | files | desktop`; `tab-store.ts` is process-memory UI state.
- `client/src/lib/daemon-channel.ts` claims daemon multiplexing but actually owns a `Map<channelId, WebSocket>` and uses the bearer token in `/v1/ws/vnc?token=`.
- `client/app/desktop.tsx` base64-bridges RFB bytes through `ReactNativeWebView.postMessage`; noVNC itself is not opening the WSS transport.
- `backend/internal/fs/fs.go:Resolve` deliberately returns absolute/out-of-root paths with `outside=true`, while callers do not reject that flag. This is the sandbox defect to close.
- OMP terminal identity prefers the actual stdin TTY (`/dev/pts/N` → `pts-N`); `TMUX_PANE=%N` is only a fallback when no TTY path is available. Breadcrumbs are `~/.omp/agent/terminal-sessions/<terminal-id>` with `cwd`, session JSONL path, and optional `fresh` line.
- OMP supports `-e/--extension`, extension events, `sendUserMessage`, `abort`, `setModel`, and `setThinkingLevel`. Its documented approval events are observational; they do not supply a remote approval response API.
- tmux Control Mode guarantees newline-delimited commands, correlated `%begin`→`%end|%error` blocks, notifications outside those blocks, octal-escaped `%output`, optional `%extended-output`, and stable `$session`, `@window`, `%pane` IDs.
- noVNC `RFB` expects a WebSocket carrying the raw RFB byte stream.

## Fixed architecture and wire contracts

### Runtime ownership
- Keep `session.Manager` as the public service. Move process-specific operations behind the smallest useful `TerminalBackend`: `Write([]byte)`, `Resize(cols, rows)`, `Close()`, `Alive()`, `Identity()`. Backend construction remains in `Manager.Create`; avoid a factory hierarchy.
- Rename `sessionRuntime` to `TerminalRuntime`. It continues owning metadata, detector, output recording, sequence allocation, subscribers, and scrollback. `PtyBackend` wraps the existing `cmd`/`ptmx`; this is a mechanical extraction before behavior changes.
- Add `AgentSession {ID, Adapter, TerminalSessionID, CWD, State, Capabilities}` beside the terminal runtime. It references, never embeds or duplicates, the `TerminalRuntime`. Closing an agent follows its terminal backend policy: direct PTY terminates; persistent tmux detaches/retains unless the explicit operation is “terminate process.”
- `OmpAdapter` owns OMP discovery, projection, and semantic commands. Views never parse ANSI or manufacture terminal control sequences.

### Daemon event store, snapshot, and cursor
- Add one daemon-local SQLite database under `stateDir/runtime.db` using a maintained pure-Go SQLite driver. Do not introduce Prisma or a client database. Migrate on daemon startup with numbered idempotent Go migrations; do not edit an old `0001_init` once released.
- Tables: `terminal_sessions`, `agent_sessions`, `runtime_events(global_seq INTEGER PRIMARY KEY AUTOINCREMENT, surface_id, kind, payload, created_at)`, plus the existing file scrollback retained for bounded raw terminal bytes. tmux identity rows persist stable server/session/window/pane IDs.
- All externally visible lifecycle and semantic mutations append `runtime_events` in the same DB transaction as their materialized session row. SQLite `global_seq` is the daemon replay cursor. It is monotonic, daemon-wide, survives restart, and is opaque to the client.
- `GET /v1/runtime/snapshot` returns `{cursor, terminals, agents, topology, desktops}`. `readEventSnapshot` reads materialized rows and performs compact projections; it MUST NOT replay the full event log to build a snapshot. The returned SQLite sequence is the replay cursor.
- `GET /v1/runtime/events?after=<cursor>&limit=<n>` returns ordered `{cursor, surfaceId, type, payload}` events and `nextCursor`. A cursor older than retained events returns `410 cursor_expired`, forcing a fresh snapshot. Terminal bytes remain on their terminal stream; snapshots carry `terminalSeq` and bounded scrollback metadata, not the entire event table.
- Reconnect algorithm: fetch snapshot and cursor, apply it, then subscribe with `after=cursor`; the server replays later events before live delivery. Client deduplicates only by cursor. Local storage keeps presentation preferences (active surface, pinned, Chat/Terminal mode), never authoritative existence/state.

### Control plane and stream routing
- Introduce one authenticated JSON control WebSocket per daemon at `/v1/ws/runtime`. Keep raw terminal WebSockets at `/v1/ws/sessions/:id` during migration and keep RFB on its dedicated binary socket; forcing bulk bytes through the control plane would add base64 cost and head-of-line blocking.
- Control envelopes are explicit:
  - client: `{type:"channel.open", requestId, channelId, kind, targetId, after?}`, `{type:"channel.close", channelId}`, `{type:"command", requestId, targetId, command, args}`;
  - server: `{type:"channel.opened", requestId, channelId, cursor}`, `{type:"event", channelId, cursor, event}`, `{type:"command.result", requestId, ok, result?, error?}`, `{type:"channel.closed", channelId, reason}`.
- Server routing: authenticated reader validates frame and target ownership → command registry resolves `(target kind, command)` → `TerminalRuntime`, `AgentSession/OmpAdapter`, tmux topology service, or desktop-ticket issuer executes → one writer goroutine serializes `command.result` by `requestId`; asynchronous state/event frames carry `channelId` and cursor. Unknown commands fail closed. Disconnect cancels request contexts but not persistent runtimes.
- Client migration: replace `WebSocketDaemonChannel.sockets` with one control socket, `pendingRequests: Map<requestId,...>`, and subscriber routing by `channelId`. Preserve `channelRegistry` as the one-channel-per-daemon registry. Terminal and RFB code stop using this JSON socket for bulk bytes.

### OMP process, transcript, and extension bridge
- Launch one TUI process: `omp --no-extensions -e <stateDir>/omp/agenticremote-bridge.ts` in the selected `TerminalRuntime`. `--no-extensions` excludes ambient extension factories while the explicit bridge still loads; this reduces unknown interception but does not claim whole-process isolation.
- The bridge writes newline-delimited semantic events to a per-agent Unix socket/FIFO in `stateDir` and accepts semantic commands there. Prefer the verified extension API over terminal keystrokes for `submitPrompt` (`sendUserMessage`), `abort`, `setModel`, and `setThinkingLevel`. This is not a second OMP or RPC process.
- The bridge emits session identity/path from `ctx.sessionManager.getSessionId()` and `getSessionFile()`, lifecycle, message deltas/finals, tool calls/results, and capability metadata. The daemon persists canonical events, so Chat recovery does not depend on reparsing every JSONL file after restart.
- Breadcrumb discovery remains a verification/fallback path: derive the PTY terminal ID from the child PTY slave path, not `TMUX_PANE`, because OMP prefers a real TTY. For tmux, resolve `pane_tty` from the stable `%pane` ID and derive the same `pts-N`; `tmux-%N` is valid only when OMP stdin is not a TTY. Honor `fresh` breadcrumbs whose JSONL does not yet exist and wait for bridge/session materialization. Canonical-CWD scanning is last-resort recovery and must reject ambiguous matches.
- Transcript tailing is fallback/recovery only. Persist byte offset plus inode/file identity, parse only complete appended JSONL lines, reset safely after truncate/replace, and project documented record shapes. The bridge is authoritative while connected.
- If the bridge is unavailable, expose only transcript-derived read-only Chat plus Raw Terminal. Do not imply semantic controls are supported.

### Safe prompt and interaction behavior
- Primary semantic submission is the OMP bridge’s `sendUserMessage`; it handles multiline, large, UTF-8, special characters, idle versus streaming queue semantics without terminal quoting.
- Terminal injection is a guarded fallback only when the adapter proves the editor is idle, focused, has no draft, and no modal/pending interaction is active. Direct PTY writes exact bytes `ESC[200~ + UTF-8 payload + ESC[201~`, then sends Enter only after the paste is accepted. For tmux, write payload to a mode-0600 temporary file, `load-buffer`, then `paste-buffer -p -d -t %pane`; issue `send-keys -t %pane Enter` only after the correlated paste command succeeds. This avoids command-line quoting and size limits.
- Each semantic command has `requestId`; adapter permits one in-flight terminal fallback per agent and returns `busy`, `needs_terminal`, or success. Never retry an uncertain submission: duplicate prompts are worse than a surfaced failure.
- Tool approval events are rendered informationally. Because upstream documents observation but no response API, approval controls are absent; state becomes `needsYou` with “Open Terminal.” `respondInteraction` is advertised only if a future adapter has a verified response API. Model and thinking controls appear only when the bridge reports those exact capabilities and command results confirm application.

### tmux Control Mode lifecycle
- Store the private socket at `<stateDir>/tmux/tmux.sock`; create its parent `0700`, reject symlinks/non-sockets, and require socket ownership by the daemon UID. Start/attach with argv (`tmux -S path -C ...`), never a shell. This isolated server does not touch the user’s default tmux server.
- One long-lived control client owns stdin/stdout, a FIFO of pending commands, stable-ID maps, and restart generation. Since notifications never occur inside a command block, parse `%begin` into the queue head and resolve only the matching `%end`/`%error`; protocol mismatch tears down and reconstructs rather than guessing.
- Decode `%output` octal escapes to bytes and route by `%pane`. Support `%extended-output` by ignoring future fields before the single `:` and decoding its value. Configure bounded `pause-after`; on `%pause`, stop accepting more pane output into the runtime queue, flush retained data, then issue `refresh-client -A %pane:continue`. Never silently drop a control/state event.
- Subscribe/query by stable IDs using `refresh-client -B` plus explicit `list-sessions`, `list-windows -a`, and `list-panes -a` refreshes after `%sessions-changed`, layout/window/session notifications, and reconnect. Treat names/indexes as labels only.
- Input targets `%pane`; resize uses `resize-pane` for pane geometry and `refresh-client -C` only for the control client. Ownership rule: the focused interactive client sets pane size; background viewers do not fight it. On viewer changes, elect the most recently focused client and debounce dimensions.
- Daemon loss: tmux server and panes survive. On restart, reconnect to the private socket, enumerate topology, map persisted stable IDs, run `capture-pane -p -e -S -` for bounded reconstruction, then resume `%output`. The capture is a replacement terminal baseline with a new `terminalSeq`, not replayed as incremental bytes.
- tmux server loss or `%exit`: mark mapped runtimes exited/lost, persist events, fail pending commands, and retry only read-only discovery with bounded backoff. Never recreate commands automatically.
- Tests use a real tmux binary and a local TCP/PTY fixture: parser fragmentation, octal and UTF-8 output, correlation errors, `%pause/%continue`, topology churn, multiple subscribers, focus resize, daemon kill/restart, and tmux server loss.

### Product topology and mobile UI
- Global `SessionSurface` is `{daemonId, kind: agent|terminal|files|desktop, targetId}`. It powers the Termius-style cross-daemon switcher and remains separate from tmux topology.
- Within one daemon, `TerminalWorkspace {tmuxSessionId}` → `TerminalWindow {tmuxWindowId}` → `TerminalPane {tmuxPaneId, terminalSessionId}`. Do not call tmux windows global tabs.
- Restore `AgentWorkspaceTab` in `client/src/lib/tabs/types.ts` with `agentSessionId`, shared `terminalSessionId`, `agentType`, state, and preferred `agentView: chat|terminal`. Do not create separate Chat and Terminal tabs for the same agent.
- Add `client/app/agent/[id].tsx`. Mobile canonical layout: compact session header, Chat/Terminal segmented control, chronological message/tool list, bottom composer, and a single “Open Terminal” action for `needsYou`. Raw Terminal reuses the existing terminal surface and same `terminalSessionId`.
- `client/app/index.tsx` keeps the application shell available with zero daemons. The Vault empty state offers Add Host and Add AgenticRemote Daemon. With connections, the global switcher groups by daemon and lists Agent, Terminal, Files, and Desktop surfaces; status ordering prioritizes `needsYou`, then working, idle, exited.
- A Files action opens `FilesWorkspaceTab.cwd` using the agent snapshot’s daemon-validated workspace-relative CWD. Desktop and Files are sibling global surfaces, not tmux children.
- Follow the current Termius mobile application’s information architecture, dense list rhythm, compact forms, sheets, restrained hierarchy, and ergonomics while preserving agenticRemote names/assets and not copying trademarks or artwork. Tablet/desktop extend the phone hierarchy; they do not replace it.

### Files sandbox
- Change `fs.Service.Resolve` to accept only empty/relative paths under `WorkspaceRoot`. Absolute paths and traversal outside the root return a typed error; all list/read/write/delete/rename/copy/download/upload paths use this one resolver. Resolve symlinks for existing ancestors/targets and reject any result escaping `WorkspaceRoot`.
- Agent CWD is stored as a workspace-relative display path after server validation. If an OMP/tmux process reports a CWD outside the configured root, omit the Files action and expose no raw absolute host path.
- Add table tests for absolute paths, `..`, sibling-prefix roots, symlink escape, rename/copy destination escape, and valid nested paths.

### Desktop/noVNC raw channel
- Add authenticated `POST /v1/desktop/sessions` returning `{ticket, wsUrl, expiresAt}`. Ticket is random 256-bit material, stored only as a hash in daemon memory, scoped to `desktop:connect` and the configured loopback VNC target, expires quickly (60 seconds), and is single-use at successful WebSocket upgrade.
- Replace `/v1/ws/vnc?token=` with `/v1/ws/rfb?ticket=`. Redact `ticket` in request logging. Validate/consume before dialing VNC; preserve connection limits and origin/CIDR policy. Never put the reusable bearer token in an RFB URL.
- In `client/app/desktop.tsx`, request the ticket in native code, inject only the returned one-use WSS URL, and initialize `new RFB(targetElement, wsUrl)`. noVNC owns the binary WebSocket. React Native messages remain for UI-only status/resize/keyboard controls, never RFB bytes/base64.
- Proxy with two concurrent pumps. WebSocket→TCP accepts binary only; clean WebSocket close calls `TCPConn.CloseWrite` and allows TCP→WebSocket to drain. TCP EOF sends a normal WebSocket close. Context cancellation or either hard error cancels both pumps and closes both transports. Guard WebSocket writes because close/data writes can race. Platform split: use `CloseWrite` on TCP where supported; on unsupported OS/connection types, close the TCP connection fully. Verify with a local TCP server in a goroutine, including half-close response draining and abrupt failures.
- `client/app/desktop.web.tsx` uses the same ticket endpoint and direct `RFB` URL rather than inventing a second protocol.

## Incremental implementation phases

### Phase 1 — Secure baseline and runtime extraction
1. Fix `fs.Service.Resolve` and all path callers; add focused sandbox tests.
2. Extract `PtyBackend` and rename `sessionRuntime` to `TerminalRuntime` without changing REST/PTY WebSocket behavior.
3. Add runtime SQLite migrations, materialized session rows, event append, `readEventSnapshot`, snapshot/events endpoints, and cursor tests. Preserve existing scrollback files.
4. Verify `make backend-test` and existing terminal create/input/resize/close behavior.

### Phase 2 — Real OMP Agent Chat vertical slice
1. Add canonical Go/TypeScript agent, event, capability, channel, and command-result protocol types.
2. Add the bundled OMP bridge, `AgentSession`, `OmpAdapter`, bridge transport, transcript fallback, and shared-terminal ownership.
3. Add the daemon control WebSocket and request/result routing; migrate `DaemonChannel` to one control socket per daemon while leaving raw PTY sockets intact.
4. Restore `AgentWorkspaceTab`, `/agent/[id]`, Chat/Terminal mode, tool rendering, capability-gated controls, `needsYou`, and Files navigation.
5. Prove against installed OMP: discovery, Unicode/multiline/large/special input, busy queue behavior, tool projection, restart snapshot, and one OMP process for both views. Count exact PIDs with `ps`, not `grep` output.

### Phase 3 — Persistent tmux and topology
1. Add the isolated control client/parser with real-tmux integration tests.
2. Add `TmuxBackend`, stable-ID persistence, topology events/snapshot, focus resize ownership, capture baseline, and restart reattachment.
3. Add the in-workspace window/pane switcher without changing the global `SessionSurface` model.
4. Kill only the daemon PID, verify tmux and OMP PIDs survive, restart daemon, and confirm topology, terminal baseline, Chat state, and later output recover without duplicate cursors.

### Phase 4 — Multi-daemon product shell
1. Reconcile every paired daemon independently: snapshot → replay → live.
2. Build the global Vault/session switcher and aggregated `needsYou`/working/idle statuses while preserving the zero-daemon shell.
3. Verify switching between at least two real daemon endpoints never crosses tokens, channels, tabs, or cursors.

### Phase 5 — Direct noVNC transport
1. Add ticket issuance/consumption and raw RFB proxy with half-close tests.
2. Move native WebView and web to direct authenticated noVNC initialization; remove the base64 `postMessage` data path and legacy bearer-token VNC URL.
3. Verify with a real VNC target: connect, interact, resize, disconnect, expired/reused/wrong-scope tickets, and request logs without reusable secrets.

### Phase 6 — Cleanup and release proof
1. Remove obsolete protocol types, legacy VNC route/bridge, per-channel JSON socket code, transcript polling paths made redundant by the live bridge, and temporary E2E fixtures.
2. Update protocol/architecture/user docs and changelog for the shipped contracts only.
3. Run `make backend-test`, `make backend-build`, `make client-test`, `make client-build-web`, and targeted lint/typecheck (ignore unrelated noisy API-module oxlint warnings). Run `make run-daemon` plus `make run-client-web`; `run-client-web` already sets `BROWSER=none` to avoid `xdg-open` crashes.

## Required acceptance
- Agent Chat is present in the product hierarchy and uses real daemon data.
- Chat and Raw Terminal show the same `AgentSession`/`TerminalRuntime`; one OMP process PID is proven.
- Installed OMP handles multiline, large, UTF-8, and special-character prompts; busy or interactive states never cause blind duplicate injection.
- OMP messages, tool calls/results, state, and capability-gated controls reconstruct from daemon snapshot plus cursor replay.
- Unsupported approval/interaction paths show `needsYou` and route to Raw Terminal; no fake approval succeeds.
- Direct PTY behavior remains compatible. tmux persists across daemon restart, restores stable topology/history, and handles server loss explicitly.
- Global daemon/surface navigation is distinct from tmux session/window/pane navigation and works with multiple daemons and with zero daemons.
- Files operations cannot escape `WorkspaceRoot`, including symlinks and destination paths; agent Files links are validated relative paths.
- noVNC opens its own raw authenticated WSS channel with a short-lived single-use scoped ticket; no reusable bearer appears in a URL.
- Concurrent RFB pumps preserve TCP half-close where the OS supports it and terminate cleanly on hard errors.

## Explicit non-goals
- No second OMP RPC/headless process, no production mock agent UI, no ANSI-derived Chat semantics while the bridge is available.
- No Claude/Codex/OpenCode adapters until the installed-OMP vertical slice and shared-process invariant pass. Later adapters implement the same capability contract; no speculative common framework beyond that contract.
- No tmux takeover of the global app navigation, no attachment to the user’s default tmux server, no automatic recreation of lost processes.
- No Prisma, npm workspace migration, package-manager change, or `pnpm@latest`; retain the repository’s current Bun/client and Go/backend tooling.
- No binary terminal or RFB traffic on the JSON control WebSocket.

## Upstream evidence
- OMP terminal IDs and breadcrumbs: `packages/tui/src/ttyid.ts`, `packages/coding-agent/src/session/session-paths.ts`.
- OMP paste semantics: `packages/tui/src/components/editor.ts`, `packages/coding-agent/src/modes/components/custom-editor.ts`.
- OMP extension loading and actions: `docs/extension-loading.md`, `docs/extensions.md`, `packages/coding-agent/src/extensibility/extensions/types.ts`.
- tmux Control Mode: [tmux(1) CONTROL MODE](https://man7.org/linux/man-pages/man1/tmux.1.html#CONTROL_MODE).
- noVNC raw WebSocket contract: [noVNC RFB API](https://github.com/novnc/noVNC/blob/master/docs/API.md#rfb).