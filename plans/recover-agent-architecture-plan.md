# Agent Architecture Recovery Plan

## Context
The recent full-gap remediation work removed the "unimplemented" Agent Chat functionality, removing `agent` from `TabKind` and deleting associated dashboard routes and components. This violated a core product invariant: Agent Chat MUST exist as a first-class session type. The old implementation was mock-driven and decoupled from the Go daemon's PTY.

Our goal is to restore the Agent Chat as a real, backend-backed product feature while aligning the architecture to safely represent multiple remote session forms. We will implement AgentAdapter semantics using genuine daemon integration, map Chat and raw Terminal views to the exactly same underlying AgentSession/process to avoid duplication, integrate persistent tmux sessions without losing PTY functionality, ensure robust reconnect capability, and restore the UI elements (Tab deck integration, Agent Chat layout, Multi-Agent Dashboards) into the React Native mobile-first frontend.

The primary initial slice will integrate natively with `omp` ("oh-my-pi").

## Target Architecture

1.  **Frontend**:
    -   `TerminalWorkspaceTab` remains. `AgentWorkspaceTab` is restored logic, storing an `agentId` (e.g., `"omp"`), and `terminalSessionId` representing the shared execution context.
    -   Agent Chat view processes semantic UI (turn history, tools, approvals) streamed from the backend while mapping standard input safely.
    -   Raw terminal view displays the same process output natively.
2.  **Backend Runtime Model (Go)**:
    -   `TerminalRuntime`: Abstraction encompassing process lifecycle and output buffering. Backed either by direct PTY (existing) or tmux Control Mode (`tmux -C`).
    -   `AgentRuntime`: Higher-level orchestration. Spawns/attaches to a `TerminalRuntime`, inspects output through a configured `AgentAdapter`, and drives dual channels: raw PTY output (for the terminal view) and semantic event stream (for the agent chat view).
3.  **Daemon Discovery**: Capabilities endpoint `GET /v1/daemon/identity` widened to report supported agents (e.g., `agent.omp`, `agent.claude`, `terminal.tmux`, `terminal.pty`).

## Setup & E2E Validation Guidelines
-   Never delete features merely to placate mock tests.
-   All new views and capabilities assume mobile-first responsiveness.
-   Mocks acceptable for Jest, but actual execution must utilize `run-client-web`, `make run-daemon`, and direct tests without simulated daemons.

## Approach
### Phase 0: Baseline & Current Regression Audit
We maintain the exact footprint from the recent regression sweep, validating that there are no broken imports or uncompilable paths currently, establishing zero-regression assumptions before moving into abstraction.

### Phase 1: Terminal Runtime Foundation & PTY Backing
Extract `Session.Manager` behavior directly into a dedicated orchestration system.
1.  **TerminalBackend Interface**: Add generic terminal interface (`Start`, `Write`, `Resize`, `Close`) mapping byte output to channels.
2.  **TerminalRuntime Orchestration**: Create `TerminalRuntime` above backends implementing standard lifecycle loops.
3.  **Adapt Existing Manager**: Convert `manager.go` `pty.StartWithSize` invocations to utilize a newly abstracted `PtyBackend` conforming to the interface without breaking behavior.
4.  **Verification**: Confirm existing tests for REST and WebSocket PTY shells still pass exactly as before. (No real agent restoration yet).

### Phase 2: AgentSession/AgentAdapter Domain + Daemon Contracts
Reintroduce Agent concepts to daemon and JS typings transparently.
1.  **TabStore Definitions**: Restore `AgentWorkspaceTab` (`client/src/lib/tabs/types.ts`). A tab has an `agentType` (e.g. `omp`), `state`, and a `terminalSessionId` (backend reference).
2.  **Daemon Discovery**: Update `/v1/daemon/identity` to return capabilities incorporating agent types (`agent.omp`, `terminal.tmux`, etc).
3.  **AgentEventEnvelope**: Add semantic wiring into `backend/internal/protocol/protocol.go` specifying `AgentEventEnvelope` covering `message`, `tool_call`, and `turn_end` states.
4.  **Verification**: Validate that capabilities fetch correctly populates an `omp` flag and that unit tests for Tab validation pass without triggering mock routes.

### Phase 3: REAL OMP TUI-backed Vertical Slice on PTY (MILESTONE)
Restore OMP Agent Chat leveraging real transcript reading + exact single process TUI backing.
1.  **TUI Process Wrapping**: `AgentRuntime` starts the `omp` process via `PtyBackend` to guarantee terminal fidelity. `AgentRuntime` acts merely as an orchestrator, returning dual streams: the terminal stream natively pumped by `TerminalRuntime`, and an agent channel stream via transcript analysis.
2.  **Transcript Polling (`OmpAdapter`)**: The `AgentAdapter` resolves `~/.omp/agent/sessions/<encoded-cwd>` exactly on startup, locates the fresh `.jsonl` transcript corresponding to the session, and sets up a standard file `tail`/watcher. New lines in the JSONL file are decoded via `OmpTranscriptAdapter` mapping (like Stably's Orca) into canonical `AgentEventEnvelope` websocket frames.
3.  **Agent Chat View (`client/app/agent/[id].tsx`)**:
    - Rebuild the dashboard route leveraging the TabStore matching `agentType='omp'`.
    - Hook up `agent.event` frames to reduce conversation states matching transcript updates.
    - Supply a manual switcher: Chat View / Raw Terminal. Switching view surfaces exactly the same underlying process stream (websocket `terminal.pty` vs `agent.event`).
4.  **Agent Prompt Submission**: Prompt inputs mapped into text sent to the `pty.input` pipeline (with trailing newlines) since the TUI process natively parses terminal stdin as prompts.
5.  **Graceful Fallbacks**: Since true asynchronous approval bypassing natively inside a single OMP TUI mode is not currently clean without building deep extension plugins, approval forms render a standard interaction warning natively in the Chat telling users to click **Terminal** to finalize interaction.
6.  **Verification**: (Milestone)
    - `mock_omp.sh`: Fake bash script writing generic `text` JSONL events inside `.omp/agent` while echoing to standard output. Run Go backend tests against it to confirm semantic extraction perfectly tracks standard byte strings.
    - **End-to-End**: Run actual installed OMP. Ensure one single process is spawned. Switch to Chat, observe model text updating. Switch to Terminal and confirm exactly the same ANSI run execution.

### Phase 4: TmuxBackend + Dedicated Control-Mode Server
Add persistent sessions via `tmux -C` without corrupting local user processes.
1.  **Implementation**: Build `TmuxBackend` that calls `exec.Command("tmux", "-L", "agenticremote", "-C", "new-session", ...)` setting up a partitioned multiplexing server.
2.  **Mappings**: Parse `%output` to route terminal events sequentially into the websocket, translating window boundaries internally. Treat `%pause`/`%continue` properly.
3.  **Safety Rule**: Terminating agents inside the AgentRemote CLI leaves the multiplexer intact *if* multiplexing was requested; disconnecting WebSockets won't kill the underlying process.
4.  **Verification**: Spawning a shell on `tmux`, running `sleep 20`, killing the websocket connection, reconnecting, and confirming `sleep` is still executing.

### Phase 5: TerminalWorkspace, Tab, Pane Model
Adapt the UI properly to represent splits over Tmux (or generic groups).
1.  **Concepts**: Add `TerminalWorkspace`/`TerminalPane` distinction mapped to TMux Panes.
2.  **UI Updates**: Build mobile-first split pane viewers utilizing `TerminalWorkspaceTab`. Do not force heavy grid toggling on phones. Restrict splitting to horizontal slices if vertically constrained.
3.  **Verification**: Write integration tests where one workspace holds two panes running mock outputs simultaneously.

### Phase 6: Snapshotting, Discovery & Cold-Start Reconnect
Decouple frontend lifecycle from backend existence.
1.  **Daemon Discovery `GET /v1/snapshots`**: Endpoint resolving live AgentSessions, Terminal Workspaces, and Desktop endpoints. Includes current Sequence/Revision IDs so reconnects avoid stale outputs.
2.  **React Store Hydration**: `TabDeckScreen` queries the daemon snapshot upon paired connection success. The UI merges new daemon references against any locally cached UI positions.
3.  **Transcript Context Recovery**: When viewing an agent, `GET /v1/sessions/:id/agent-history` fetches the pre-encoded JSONL sequence to rapidly hydrate the visual tree.
4.  **Verification**: Run the application, trigger a long session update. Close the actual client app process natively on mobile. Open it. The snapshot should immediately rebuild the list, re-connecting to the precise prior socket offsets.

### Phase 7: Multi-Agent Dashboard & Termius-Style Session Switcher
Build robust application navigation.
1.  **Global Switcher (`client/app/index.tsx`)**: Replicate Termius hierarchy: Daemons -> Sessions. Mix `Agent`, `Terminal`, `Desktop`, and `Files` cleanly across multiple instances.
2.  **Agent Overview List**: Display `Needs You` / `Working` / `Idle` aggregations across active Agent Workspaces globally.

### Phase 8: Daemon Channel Refinement (Multiplexing Validation)
Explicitly clean up the single-socket multiplexer.
1.  Ensure `DaemonChannel` allocates a distinct explicit `ControlSocket` and handles standalone binary WebSockets specifically for `TerminalStream` and `VNC`. Avoid dropping RFB onto JSON channels.

### Phase 9: Capability-driven Adapters (Claude / OpenCode)
Extend the `AgentAdapter` parsing strategies for Claude and OpenCode outputs without changing `AgentRuntime`.

### Phase 10: Desktop/noVNC Transport Revamp
Eliminate JavaScript string-bridge tunneling.
1.  **Architecture**: Mount `noVNC` inside WebView pointing exactly to `ws://<daemon_ip>/v1/ws/vnc?token=...` with Native ArrayBuffer settings, entirely bypassing the React Native `postMessage` layer for binary packets.
2.  **Go Server Proxy**: Construct a raw socket reader terminating TCP to the VNC target and raw-wrapping bytes onto WebSockets safely holding standard Bearer credentials upon upgrade.

### Phase 11: System Hardening & Files Integration
1.  Fix Sandbox Escape (`fs.go` Resolve rule inversion). Clamp traversal safely to `WorkspaceRoot`.
2.  Expand integration so `Agent Chat` provides a fast-path button directly into the `Files` REST viewer for the agent's current working directory.

## Validation & Acceptance
- New Agent visible in product UI hierarchically.
- OMP discovered and selectable.
- Single process per Agent session proved via `ps aux`.
- Streaming responses, Tool Calls, and Approval overlays function from real protocol data.
- State persists gracefully across hard disconnects.
- `tmux` isolated via socket path.
- Existing Pairing, Files, and Desktop (VNC) operations unharmed.
- Android tests verified (where env setup allows or clearly smoke-tested over web-expo preview).