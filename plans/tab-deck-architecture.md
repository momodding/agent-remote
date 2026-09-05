<!-- source-branch: main -->
<!-- work-branch: omp/tab-deck-architecture -->

# agenticRemote Mobile Revamp — Tab Deck Architecture

## 1. Goal

Replace single-daemon, single-screen-per-feature navigation with a global
**Tab Deck**: one surface listing every open Agent/Terminal/Files/Desktop tab
across every paired daemon, backed by one multiplexed realtime channel per
daemon (not one WebSocket per tab). Frontend-first: ship the tab system,
data models, and mock adapters before touching the Go daemon.

Desktop/VNC is retained as a 4th first-class tab type (user decision), same
mock-then-real treatment as Agent/Terminal/Files.

## 2. Grounded findings (why the current app can't just grow this feature)

- `client/src/lib/connection.ts`: `ConnectionStore` has `selectedHostId`
  (single global selection). `getConnection(store, hostId?)` defaults to it.
  Every screen (`terminal/[id].tsx`, `files.tsx`, `desktop.tsx`) independently
  calls `loadConnections()` + `getConnection(store, hostId)` in a `useEffect`
  — connection identity is re-derived per screen mount, not carried by a tab
  object.
- `client/src/lib/session-socket.ts`: `SessionSocket` opens one raw
  `WebSocket` per PTY session (`/v1/ws/sessions/:id`), auth token sent as the
  first frame. `client/app/desktop.tsx` opens a **second, independent**
  WebSocket (via noVNC's RFB client) straight to `/v1/ws/vnc?token=...`.
  Files use plain REST (`AgenticRemoteAPI`). Three unrelated transports, zero
  shared connection object — this is what "one channel per daemon" replaces.
- `client/app/terminal/[id].tsx`: connection teardown is tied to component
  unmount (`useEffect` cleanup calls `socket.current?.close()`) and to
  `AppState` background/foreground. Navigating away kills the socket
  entirely; reconnect replays full scrollback (`setOutput('')` then refill).
  Tabs must survive navigation — this lifecycle must move out of the route
  component and into a store that outlives it.
- `client/src/lib/multi-session.ts` + `MultiTerminal.tsx`: split-pane
  concept already exists but is scoped to **one route, one daemon**
  (`MAX_MULTI_SESSIONS = 5`, `SplitLayout` array). Reusable for in-tab split
  view, not for cross-daemon tab listing.
- Backend wire types (`backend/internal/protocol/protocol.go`,
  mirrored in `client/src/protocol.ts`): `PTYInputEnvelope`,
  `PTYOutputEnvelope`, `PTYResizeEnvelope`, `SessionStateEnvelope`,
  `ErrorEnvelope` are all per-session, sent over the session's own socket.
  No session-id-multiplexing envelope exists yet on the wire.
- No state management dependency in `client/package.json` (no Redux/Zustand/
  Jotai) — current app is local `useState` + `AsyncStorage`/`SecureStore`
  persistence only. Ladder rung 3 applies: don't add one; a plain module-level
  store + React context covers this.
- OMP RPC (`@oh-my-pi/pi-coding-agent` `rpc-mode.ts`, `rpc-types.ts`,
  confirmed installed, `omp --mode=rpc`): JSON-Lines commands in
  (`RpcCommand`, e.g. `prompt`, `steer`, `abort`, `set_thinking_level`,
  `set_model`) and events out (`AgentSessionEvent` = core `AgentEvent`
  union — `message_start/update/end`, `tool_execution_start/update/end`,
  `turn_start/end`, plus session extras: `todo_reminder`, `notice`,
  `thinking_level_changed`, `goal_updated`) plus `extension_ui_request`
  (`select`/`confirm`/`input`/`editor`/`notify`/`open_url`) for
  approvals/prompts, answered with `extension_ui_response`. `get_state`
  returns `RpcSessionState` (models, thinking level, todo phases). This is
  the normalization contract the Agent tab's native chat UI renders against
  — confirmed real, not raw TUI text.
- VNC proxy (`backend/internal/server/server.go` `handleVNCProxy`): raw TCP↔WS
  byte bridge, auth via `?token=` query param (not the frame-based auth other
  sockets use), backend-side RFB server assumed already running on
  `127.0.0.1:{VNCPort}`. Half-close handled via `CloseWrite` on clean WS
  close. This asymmetry (query-token vs. frame-token auth) is a fact to
  carry into the multiplexed-channel design, not paper over.

## 3. Non-goals (explicit, so scope doesn't creep)

- No Go daemon changes in this phase. The multiplexed-channel wire protocol
  is *designed* now (so the frontend abstraction is the real shape) but
  *implemented* only by the mock adapter. Real daemon multiplexing is a
  follow-up phase, tracked but not built here.
- No new state-management library, no GraphQL/tRPC, no Prisma/database of
  any kind (no DB exists in this stack; daemon state is flat files under
  `.agenticremote/`) — unrelated to this repo, not introducing it.
- No package-manager change (`client` stays `bun`, per `packageManager:
  "bun@1.3.14"` in `client/package.json`; backend stays a plain Go module).
- No change to pairing/Auth-v2 handshake, TLS, or token hashing.
- Agent adapters beyond OMP (Claude Code, Codex, etc.) are stubbed as an
  interface only — OMP is the only one implemented end-to-end this phase.

## 4. Core data model (new file `client/src/lib/tabs/types.ts`)

```ts
export type DaemonId = string; // = Connection.hostId, existing identity

export type TabKind = 'agent' | 'terminal' | 'files' | 'desktop';

interface BaseTab {
  tabId: string;        // stable local id, independent of remoteSessionId
  daemonId: DaemonId;
  kind: TabKind;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  pinned: boolean;
}

export interface TerminalWorkspaceTab extends BaseTab {
  kind: 'terminal';
  remoteSessionId: string;      // maps to backend Session.ID
  state: 'connecting' | 'running' | 'waiting' | 'exited' | 'detached';
  waitState?: WaitState;
}

export interface AgentWorkspaceTab extends BaseTab {
  kind: 'agent';
  remoteSessionId: string;      // OMP rpc process handle on the daemon
  adapter: 'omp';                // widen when a 2nd adapter ships
  sessionState: RpcSessionState | null; // last get_state snapshot
  pendingApproval: RpcExtensionUIRequest | null;
}

export interface FilesWorkspaceTab extends BaseTab {
  kind: 'files';
  cwd: string;                   // no remoteSessionId: files is stateless REST
}

export interface DesktopWorkspaceTab extends BaseTab {
  kind: 'desktop';
  remoteSessionId: string;       // VNC channel id once multiplexed
  state: 'connecting' | 'connected' | 'disconnected';
}

export type WorkspaceTab = TerminalWorkspaceTab | AgentWorkspaceTab | FilesWorkspaceTab | DesktopWorkspaceTab;
```

`tabId` is generated client-side (`crypto.randomUUID()`-style) at tab-creation
time and never reused — `DaemonId + remoteSessionId` is looked up via a
`Map<DaemonId, Map<remoteSessionId, tabId>>` index so a reconnect/resume can
find its existing tab instead of creating a duplicate.

## 5. Connection layer (new `client/src/lib/daemon-channel.ts`)

One `DaemonChannel` per paired daemon, owned by a module-level
`ChannelRegistry` (plain `Map<DaemonId, DaemonChannel>`), not per-component:

```ts
export interface DaemonChannel {
  daemonId: DaemonId;
  status: 'connecting' | 'open' | 'closed' | 'error';
  send(envelope: ChannelEnvelope): void;
  subscribe(channelId: string, fn: (msg: ChannelEnvelope) => void): () => void;
  openChannel(kind: TabKind, meta: Record<string, unknown>): Promise<string>; // returns channelId
  closeChannel(channelId: string): void;
}
```

`ChannelEnvelope = { channelId: string; kind: TabKind } & (PTYFrame | AgentFrame | DesktopFrame)`
— every PTY/agent-RPC/VNC-byte frame gets tagged with the tab's `channelId`
so N tabs share 1 socket. This is the frontend-authored spec the mock
adapter implements today and the real daemon gateway must match later
(tracked as a follow-up, not built now).

`ConnectionStore` loses `selectedHostId` (dead per Key Decision from prior
session) — `getConnection` becomes pure `connections[]` lookup by `hostId`;
"current" is a Tab Deck concept (`activeTabId`), not a connection concept.

## 6. Mock adapter layer (new `client/src/lib/mock/`)

- `mock-daemon.ts`: in-memory fake daemon — fake PTY that echoes/emits
  deterministic scripted output, fake OMP RPC session that replays a fixed
  `AgentSessionEvent` fixture sequence (covers `message_start` →
  `tool_execution_start/end` → `message_end` → one `extension_ui_request:
  confirm` to prove the approval-card path), fake file tree, fake VNC
  "static test pattern" frame loop.
- `mock-channel.ts`: implements `DaemonChannel` against `mock-daemon.ts`
  in-process (no real socket) — same interface real `WebSocketDaemonChannel`
  will implement, swapped via one factory function
  (`createDaemonChannel(connection)`), so tests/dev run 100% offline and
  deterministic, and the real implementation is a drop-in later.
- Ladder check: no fixture framework — 4 hand-written TS fixture arrays,
  replayed on a `setInterval`/`setImmediate` schedule. `ponytail:` comment
  marks the scripted-fixture ceiling (real daemon replaces wholesale, not
  incrementally).

## 7. Navigation restructure

- `client/app/index.tsx` becomes the **Tab Deck**: grid/list of every open
  `WorkspaceTab` across all daemons (Termius/Chrome-tab-switcher reference),
  grouped by daemon, with kind icon, title, state pill, close (×) and a
  "+" per daemon to spawn a new tab of a chosen kind. Pairing/daemon-list
  management moves to a secondary sheet (`ConnectionSheet` already exists),
  not the main screen.
- Route per tab kind stays (`terminal/[id]`, `agent/[id]` new,
  `files/[id]` new — currently `files.tsx` has no `[id]`, gets one so
  multiple Files tabs across daemons are addressable), but the route reads
  `tabId` (not `hostId` alone) and pulls `daemonId` + connection + channel
  from the Tab Deck store — not from its own `loadConnections()` call.
- Opening a tab = push route with `tabId`; closing = pop + remove from
  store; backgrounding the app does NOT close channels (channels are
  daemon-scoped, outlive any single screen) — only the mock/real channel's
  own idle-timeout policy (future) would.
- `desktop.tsx`/`desktop.web.tsx` keep native/web split (WebView RFB vs.
  iframe RFB — platform constraint, not revisitable) but become
  `DesktopWorkspaceTab` consumers on the same channel abstraction.

## 8. Agent tab UI (native structured chat, OMP adapter)

- `client/src/lib/agent/omp-adapter.ts`: maps `RpcCommand`/`RpcResponse`/
  `AgentSessionEvent` to a small reducer producing render-ready state:
  message list (user/assistant turns), tool-call cards (name, args,
  streaming partial result, final result/error) from
  `tool_execution_start/update/end`, thinking-level chip from
  `thinking_level_changed`, todo panel from `todo_reminder`/`set_todos`
  response, and an approval overlay from `extension_ui_request` (`confirm`
  → Yes/No overlay, `select` → option list, `input`/`editor` → text sheet),
  resolved via `extension_ui_response` sent back over the channel.
- `client/src/components/agent/` (new): `AgentMessageList`, `ToolCallCard`,
  `ApprovalOverlay`, `ThinkingChip`, `TodoPanel` — plain dense dark cards,
  no chat-bubble/avatar "AI slop", matches existing dark palette
  (`#0A0A0A`/`#181818`/`#262626`/`#D19A2C` accent already used app-wide).
- Non-goal reminder: no xterm/WebView for the Agent tab — this is the one
  place the spec is explicit that raw-TUI-in-terminal is wrong.

## 9. Phased implementation order

1. **Foundation**: `client/src/lib/tabs/types.ts`, `tab-store.ts` (module
   store + React context, `useTabDeck()` hook), `daemon-channel.ts`
   interface + `ChannelRegistry`, drop `selectedHostId` from
   `connection.ts` (update `getConnection` callers).
2. **Mock adapters**: `mock/mock-daemon.ts`, `mock/mock-channel.ts`,
   `createDaemonChannel()` factory wired to mocks (real WS impl deferred).
3. **Tab Deck screen**: rebuild `client/app/index.tsx` as the deck; keep
   `ConnectionSheet`/`PairingSheet` for daemon management, hang off a menu.
4. **Terminal tab port**: `terminal/[id].tsx` reads from tab store/channel
   instead of owning its own `SessionSocket`; `MultiTerminal`/
   `multi-session.ts` split-pane logic reused as-is (still valid for
   in-tab multi-pane, unaffected by the cross-daemon change).
5. **Files tab port**: `files.tsx` → `files/[id].tsx`, tab-store-driven
   connection lookup, REST calls unchanged (Files has no realtime channel
   need beyond REST — confirmed no wire push events for FS in
   `protocol.go`).
6. **Desktop tab port**: `desktop.tsx`/`desktop.web.tsx` onto channel
   abstraction (mock VNC byte stream), 4th tab kind end-to-end.
7. **Agent tab (OMP)**: `omp-adapter.ts` + `components/agent/*` against the
   scripted `AgentSessionEvent` fixture in the mock daemon — full
   message/tool-card/approval-overlay path exercised without a real OMP
   process.
8. **Tests**: unit tests for `tab-store.ts` reducers (add/close/reindex by
   `daemonId+remoteSessionId`→`tabId`), `omp-adapter.ts` event-to-card
   mapping (the actual bug surface — malformed event ordering, unresolved
   approval on tab close), `daemon-channel` envelope routing (N channels,
   1 mock socket, no cross-talk). Existing route tests
   (`terminal-route.test.tsx`, `files-route.test.tsx`,
   `dashboard-route.test.tsx`) updated for the new store-driven props, not
   deleted wholesale.

## 10. Explicit follow-up (not this phase, flagged so it isn't forgotten)

- Real backend gateway: one `/v1/ws/gateway` endpoint per daemon that
  multiplexes PTY/agent-RPC/VNC bytes by `channelId`, replacing 3 separate
  transports. Requires resolving the query-token-vs-frame-token auth
  mismatch (VNC today authenticates differently from PTY sockets).
  OMP subprocess lifecycle management on the daemon (`omp --mode=rpc` per
  agent tab) is part of that follow-up, not this one.
- Second agent adapter (beyond OMP) once the adapter interface is proven.
