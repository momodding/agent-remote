# Manual Remediation Plan

**Status**: Evidence-backed draft (no implementation)  
**Authority**: Operator report + forensic audit + bounded OMP source audit  
**Date**: 2026-10-06

---

## Executive Summary

This document specifies reproducible acceptance criteria, code boundaries, security invariants, and regression smoke tests for MANUAL-001 through MANUAL-007, with explicit gates for ENH-001, ENH-002, and ENH-003. All items marked **FAIL** or **OPEN**; no verification claimed.

MANUAL-001.003 updated with verified audit findings: source-proven commands (prompt, abort, model, thinking), unresolved OMP APIs, prerequisites identified before implementation.

---

## MANUAL-001: Harness Runtime State & Command Parity

**Title**: Harness mode and state consistency tracking  
**Status**: OPEN (source audit complete; prerequisites identified)  
**Evidence Source**: Operator manual + bridge/adapter/protocol source audit

### Verified Wire State & Capability Fields

**AgentSession** (`client/src/protocol.ts:38`):
```typescript
export type AgentSession = {
  id: string;
  adapter: string;                          // purpose UNRESOLVED
  terminalSessionId: string;
  cwd: string;
  state: 'working' | 'idle' | 'needsYou' | 'exited';  // semantics UNRESOLVED
  capabilities: AgentCapability[];           // population trigger UNRESOLVED
  model?: AgentModelInfo;
  thinking?: string;
  availableModels?: AgentModelInfo[];
  availableThinking?: string[];
};

export type AgentCapability = {
  name: string;      // proven names: 'prompt', 'abort', 'model', 'thinking'
  enabled: boolean;
};
```

**Missing Semantics**:
- `state='needsYou'`: Value evidenced; semantic meaning UNRESOLVED
- `adapter` field: Present in wire; usage/content UNRESOLVED (NOT embedded harness mode enum)
- Capabilities population: Field present; trigger mechanism UNRESOLVED

### Source-Proven Command Handlers (Bridge ↔ OMP)

**ONLY 4 Commands Evidenced** (`backend/internal/agent/bridge.ts`):

1. **'prompt'** (line 101):
   - Handler: `pi.sendUserMessage(text)`
   - Payload: TEXT ONLY (no structured image/audio/binary)
   - OMP API source: NOT in repo (ExtensionAPI contract UNVERIFIED)

2. **'abort'** (line 120):
   - Handler: Stub exists; implementation UNRESOLVED
   - OMP API: `pi` method UNKNOWN (NOT visible in bridge.ts)

3. **'model'** (line 130):
   - Handler: `pi.setModel(target)` where target = AgentModelInfo
   - OMP API source: NOT in repo (UNVERIFIED)
   - Model resolution: line 145-156 (client-side lookup by id/provider/name)

4. **'thinking'** (line 174):
   - Handler: `pi.setThinkingLevel(levelStr as ThinkingLevelParam)`
   - OMP API source: NOT in repo (UNVERIFIED)
   - ThinkingLevelParam: `Parameters<ExtensionAPI["setThinkingLevel"]>[0]` (line 3) — enum UNRESOLVED

**NO other commands evident** in source (slash commands, @ mention handlers NOT found).

### Semantic Events & Message Content

**Message Events** (`bridge.ts:112`):
- `event: 'message.user'`: TEXT-based user input only

**File Mention** (`bridge.ts:272`):
- `role: 'fileMention'`: Detected when `msg.role === "fileMention" && Array.isArray(msg.files)`
- Files array present; **file format/semantics UNRESOLVED**
- **@ mention parsing**: NOT evident in bridge.ts (syntax UNRESOLVED)

**Lifecycle Events** (`backend/internal/agent/adapter.go:243-302`):
- `turn_start` → AgentEvent type `activity.turn.started`
- `tool_start` → `activity.tool.started`
- `tool_end` → `activity.tool.completed` (or `activity.tool.failed` if IsError)
- `approval_requested` → `activity.approval.requested`
- `approval_resolved` → `activity.approval.resolved`

### Discovery Prerequisites (Before Implementation)

**Required** (must inspect installed OMP before coding):

1. **OMP harness mode/state machine**:
   - Locate: `@oh-my-pi/pi-coding-agent` installed node_modules OR OMP help docs
   - Verify: HarnessRuntimeState type or equivalent (NOT found in agentic-remote source)
   - Extract: Exact harness modes (e.g., 'chat', 'tui', 'agent', 'coding')
   - Extract: State values distinct from wire AgentSession.state
   - **Acceptance**: Document exact modes + transitions from OMP source

2. **Command parity matrix**:
   - Verify: Which slash (/) commands map to OMP harness commands
   - Verify: Which @ mention patterns invoke OMP reference resolution
   - Verify: OMP command availability per mode/harness
   - **Acceptance**: Matrix populated from OMP docs or help output

3. **Message/attachment protocol**:
   - Locate: OMP API docs for structured content (image, audio, file attachment semantics)
   - Verify: fileMention format in agentic-remote bridge.ts matches OMP ExtensionAPI
   - Verify: Attachment lifecycle (send → OMP → storage/cleanup)
   - **Acceptance**: Protocol boundaries documented from OMP source

4. **Same-Process OMP Runtime**:
   - Verify: Bridge socket path (line 50, `AGENTIC_REMOTE_BRIDGE_SOCKET`) spawns OMP in same process
   - Verify: No multi-process harness variants in installed OMP
   - **Acceptance**: Confirm single-process assumption holds for deployed OMP version

### Code Boundaries Requiring Verification

**Already Traced** ✓:
- `backend/internal/agent/bridge.ts:48-658` — Bridge TypeScript extension setup + command handlers
- `backend/internal/agent/bridge.go:121-169` — Go frame types (Hello, Metadata, Lifecycle, Semantic)
- `backend/internal/agent/adapter.go:215-421` — Frame handler dispatch
- `client/src/protocol.ts:36-51` — AgentSession/Capability/Event wire types
- `client/app/agent/[id].tsx:520-526` — UI capability rendering

**Untraced, Requires OMP Source**:
- OMP ExtensionAPI definition (pi.setModel, pi.setThinkingLevel signatures)
- OMP harness mode/state machine
- OMP command registry (slash / commands, @ mentions)
- OMP structured content protocol (image, audio, file attachment)

### Reproducible Acceptance Criteria

**Prerequisite Discovery** (OMP source inspection):
1. Inspect installed `@oh-my-pi/pi-coding-agent` (or help output)
2. Extract harness mode enum/definitions (if separate from wire AgentSession.state)
3. Extract OMP command registry (slash, @, modes)
4. Extract message/attachment protocol from OMP docs
5. Map each discovery to exact file/line in OMP source or help output

**Implementation Acceptance** (after prerequisites gathered):
1. Verify AgentSession.state values propagate correctly per harness mode
2. Verify capabilities enable/disable per harness mode + OMP command availability
3. Verify all 4 proven commands (prompt, abort, model, thinking) work in deployed mode
4. Verify model/thinking enums match OMP available values (no crashes on unknown)
5. Verify fileMention format matches OMP attachment protocol
6. **Verify @ mention syntax** (if discovered in OMP) or mark NOT SUPPORTED if absent

### Oracle/Flow Auditor Gates

- [ ] **OMP Source Discovery**: Harness modes, commands, attachment protocol extracted and documented
- [ ] **Web E2E Run**: All 4 commands functional; capabilities gate correctly per mode
- [ ] **Android E2E Run**: Same as Web; model/thinking values available + selectable
- [ ] **Flow Auditor**: Trace harness mode → capabilities enable/disable → command dispatch

---

## MANUAL-002: Slash/@ Command Composer Parity

**Title**: Command composer slash and @ reference parity  
**Status**: OPEN (source audit complete; prerequisites identified)
**Evidence Source**: Bridge/adapter source audit (composer UI NOT inspected per request)

### Source-Verified Findings

**Slash Commands**: NOT evident in bridge.ts  
- Bridge.ts line 101-198: Only 4 commands proven (`prompt`, `abort`, `model`, `thinking`)
- No `/` parsing or slash command registry found in source
- **Slash command handler**: SOURCE UNAVAILABLE (may exist in OMP or composer UI, NOT traced)

**@ Mentions**: PARTIALLY OBSERVED
- fileMention role detected (bridge.ts:272: `msg.role === "fileMention"`)
- @ prefix parsing: SOURCE UNAVAILABLE in agentic-remote (NOT in bridge.ts or protocol.ts)
- **@ mention resolution semantics**: UNRESOLVED

### Prerequisite Discovery (Before Implementation)

**Required** (must inspect composer UI + OMP before coding):

1. **Slash command registry in composer**:
   - Locate: Composer UI component (NOT inspected; deferred per request)
   - Verify: Which slash commands are sent to backend bridge
   - Verify: Handler dispatch in bridge (may require new bridge.ts handler)
   - **Acceptance**: Slash command list extracted from composer source or OMP help

2. **@ mention parsing + OMP parity**:
   - Locate: @ mention handler in composer UI
   - Verify: Syntax rules (e.g., @file:path, @func:name, @symbol)
   - Verify: Which @ mentions are sent as fileMention vs other semantic events
   - Verify: OMP support for each @ mention type
   - **Acceptance**: @ mention syntax rules + OMP support matrix documented

3. **Same-Process OMP Runtime**:
   - Verify: Confirm OMP command registry runs in same process (bridge socket established)
   - **Acceptance**: Single-process assumption validated

### Code Boundaries Requiring Verification

**Already Traced** ✓:
- `backend/internal/agent/bridge.ts:101-198` — Proven command handlers only (4 total)
- `backend/internal/agent/bridge.ts:272` — fileMention role detection
- `client/src/protocol.ts:36-51` — Wire capability field (no @ mention structure)

**Untraced, Requires Composer/OMP Inspection**:
- Composer UI slash command handler (NOT in bridge.ts)
- @ mention prefix parsing (NOT in bridge.ts)
- OMP command/mention registry and dispatch
- Backend bridge dispatch for commands beyond proven 4

### Reproducible Acceptance Criteria

**Prerequisite Discovery** (composer + OMP inspection):
1. Inspect composer component for slash command input handler
2. Extract slash command list + handler invocation logic
3. Inspect composer @ mention handler (prefix parsing, reference syntax)
4. Inspect OMP help or source for command/mention registry
5. Map each slash command + @ mention type to OMP support (available? mode-gated?)

**Implementation Acceptance** (after prerequisites gathered):
1. Verify all discovered slash commands dispatch to bridge.ts
2. Verify new bridge handlers added for slash commands (if any beyond 4 proven)
3. Verify @ mention fileMention format matches OMP attachment protocol
4. Verify @ mention resolution works per discovered syntax rules
5. **Web E2E**: Send slash command → verify backend processes correctly
6. **Web E2E**: Send @ mention → verify OMP resolves reference correctly

### Oracle/Flow Auditor Gates

- [ ] **Composer Source Discovery**: Slash command + @ mention handlers extracted
- [ ] **OMP Registry Discovery**: Command/mention availability per harness mode documented
- [ ] **Web E2E Run**: All slash commands + @ mentions functional
- [ ] **Android E2E Run**: Same as Web
- [ ] **Flow Auditor**: Trace slash/@ input → bridge dispatch → OMP execution

---

## MANUAL-003: Image/File Attachment Lifecycle

**Title**: Image and file attachment handling  
**Status**: OPEN (source audit complete; prerequisites identified)
**Evidence Source**: Bridge/adapter source audit (composer file picker NOT inspected per request)

### Source-Verified Findings

**File Mention Message Role** (`bridge.ts:272`):
```typescript
if (msg.role === "fileMention" && !text && Array.isArray(msg.files)) {
  // File array present; format UNRESOLVED
}
```

**FileMentionFile Interface** (`bridge.ts:22-24`):
```typescript
interface FileMentionFile {
  // Interface exists in code; fields UNKNOWN (NOT visible in snippet)
}
```

**Observed but Unresolved**:
- fileMention role detected in semantic events
- Files array present; **file object structure UNRESOLVED**
- **Image/audio/binary attachment semantics**: NOT evident in source
- **Attachment storage/cleanup lifecycle**: NOT evident in bridge.ts or adapter.go

### Prerequisite Discovery (Before Implementation)

**Required** (must inspect composer file picker + OMP before coding):

1. **Composer file attachment UI**:
   - Locate: File picker component (NOT inspected; deferred per request)
   - Verify: File selection types (image, audio, binary, text)
   - Verify: File metadata attached (name, size, mimetype, path)
   - Verify: Which files are sent as fileMention vs other handlers
   - **Acceptance**: File picker handler + payload format documented

2. **OMP attachment protocol**:
   - Locate: OMP ExtensionAPI definition for file/image/audio content
   - Verify: Attachment payload structure (e.g., { name, mimetype, data })
   - Verify: Supported attachment types (image? audio? binary?)
   - Verify: Storage backend (temporary, persistent, OMP-managed)
   - Verify: Cleanup policy (on message complete, on session close, explicit delete)
   - **Acceptance**: OMP attachment protocol specification documented

3. **Same-Process OMP Runtime**:
   - Verify: File attachment storage accessible to same-process OMP (no remote S3)
   - **Acceptance**: Single-process assumption validated for file I/O

### Code Boundaries Requiring Verification

**Already Traced** ✓:
- `backend/internal/agent/bridge.ts:272-320` — fileMention role handling (files array format UNRESOLVED)
- `backend/internal/agent/bridge.ts:22-24` — FileMentionFile interface (fields UNKNOWN)
- `backend/internal/agent/adapter.go:353-421` — Semantic frame dispatch (file handling NOT visible)
- `client/src/protocol.ts:36-51` — AgentEvent wire (no file attachment structure)

**Untraced, Requires Composer/OMP Inspection**:
- Composer file picker component (NOT inspected)
- FileMentionFile field definitions (interface body hidden in snippet)
- OMP file attachment protocol (storage, cleanup, type support)
- Backend file attachment storage path + lifecycle

### Reproducible Acceptance Criteria

**Prerequisite Discovery** (composer + OMP inspection):
1. Inspect composer file picker component
2. Extract supported file types + metadata structure
3. Extract FileMentionFile interface definition from bridge.ts:22-24
4. Inspect OMP help/docs for attachment protocol + storage
5. Map file type → OMP support (image? audio? binary? size limits?)

**Implementation Acceptance** (after prerequisites gathered):
1. Verify file payload matches OMP attachment protocol
2. Verify supported file types match OMP constraints
3. Verify file attachment stored correctly (path, permissions, metadata)
4. Verify attachment cleanup on session close (no leaks)
5. **Web E2E**: Upload image → verify OMP receives + processes correctly
6. **Web E2E**: Upload multiple files → verify order + deduplication handling
7. **Web E2E**: Close session → verify files cleaned up (if temporary)

### Oracle/Flow Auditor Gates

- [ ] **Composer Discovery**: File picker component + metadata structure extracted
- [ ] **OMP Protocol Discovery**: Attachment types, storage, cleanup policy documented
- [ ] **Web E2E Run**: Image + file upload functional; storage verified
- [ ] **Android E2E Run**: Same as Web; file access permissions validated
- [ ] **Flow Auditor**: Trace file upload → bridge fileMention → OMP processing → storage/cleanup

---

## MANUAL-004: Agent Termination Lifecycle

**Title**: Agent Chat terminate and dashboard X semantics  
**Status**: FAIL (test coverage gap identified; semantics unresolved)

### Exact Code Boundaries

**API Layer** (`client/src/lib/api.ts`):
```
terminateAgent(id: string): Promise<void>
  → POST /v1/agents/{encodeURIComponent(id)}/terminate
  Distinct from:
  - abortAgent() → POST /abort (interrupt prompt)
  - closeSession() → POST /v1/sessions/{id}/close (close view, NOT process)
```

**Backend Handler** (`backend/internal/server/server.go:423-506`):
```
handleAgentAction(w, r) → case "terminate":
  → s.agents.TerminateAgent(ctx, id)
  → Error: ErrorEnvelope{Code: "terminate_failed"}
```

**Client State** (`client/src/lib/multi-session.ts`):
```
closeSession(sessions, id) → reconcileSplit()
  Removes UI card, does NOT verify backend process dead
```

### Semantic Boundary: Close View vs Terminate Remote [INVESTIGATE]

**Evidence-backed** (code-verified):
- **terminateAgent**: API endpoint (POST /v1/agents/{id}/terminate) distinct from abortAgent and closeSession
- **closeSession**: API endpoint (POST /v1/sessions/{id}/close) does NOT kill backend process

**Behavior Unresolved** [INVESTIGATE]:
- Dashboard X button semantics: Which API does it invoke? Unclear from source trace.
- Dashboard row auto-removal after terminate: NOT directly evidenced in code
- Confirmation signal from backend to client: UNRESOLVED

**Risk** [INFERENCE]: Terminate may close view only; remote process persists; reconnect reattaches to live agent.

### Security/Lifecycle Invariant

**Required**: 
1. After terminateAgent POST returns HTTP 200, remote agent process must be dead.
2. Dashboard active row must be automatically removed (NOT via user X click).
3. Row removal must persist after reload/reconnect.
4. **Close-View** (X button) must remain distinct and explicit: Does NOT invoke terminateAgent; removes local card only.

**Currently Unverified**: No confirmation path from terminate POST → backend kill → client reconciliation observable.

### Reproducible Acceptance Criteria

1. **Start Agent Chat**: Create new agent, send prompt (verify running)
2. **Invoke Terminate**: Call `terminateAgent(id)` via API
3. **Verify Immediate Response**: HTTP 200 returned
4. **Verify Process Dead**:
   - Backend OMP status shows agent terminated
   - OR direct process inspection confirms gone
5. **Verify Dashboard Auto-Removal**: Agent row automatically removed from dashboard (NOT via user X click)
6. **Reload App**: Verify row remains absent (does NOT reappear)
7. **Reconnect Attempt**: Verify explicit error (agent dead) or row absent
8. **Close-View Test** (distinct action):
   - Start new agent
   - Send prompt (verify running)
   - DO NOT invoke terminate
   - Click X button (close-view action)
   - Verify row removed from dashboard
   - Verify remote agent process still running (backend check)

### Regression/Smoke Evidence Required

**Realistic End-to-End Runs** (both required):

1. **Web (Expo Web)**:
   - Start agent via dashboard
   - Send multi-line prompt (verify agent processing)
   - Call terminate API
   - Verify backend logs confirm process killed
   - Verify dashboard row auto-removed (NOT via X click)
   - Reload page → verify row absent
   - Verify close-view (X click) remains distinct and explicit

2. **Android (Expo Android)**:
   - Same as above on physical device or emulator
   - Include network state variations
   - Background/foreground app transitions

### Code Inspection Boundaries

**Already Traced** ✓:
- `client/src/lib/api.ts:79` — terminateAgent endpoint
- `backend/internal/server/server.go:504` — handler routing
- `client/src/__tests__/agent-lifecycle.test.tsx:20` — endpoint test (no state reconciliation)

**Untraced** (affects remediation):
- Backend `TerminateAgent()` implementation (agent lifecycle manager)
- OMP signal path and confirmation
- Client reconciliation trigger after process death
- Dashboard X button handler (which API invoked?)

### Oracle/Flow Auditor Gates

- [ ] **Web E2E Run**: Agent terminate, process confirmed dead, auto-removed row verification
- [ ] **Android E2E Run**: Same flow, network latency included
- [ ] **Flow Auditor**: Trace from API call → OMP termination → client reconciliation confirmation

---

## MANUAL-005: Terminal Pane Bottom-Sheet Layout

**Title**: Terminal pane bottom-sheet layout defect  
**Status**: FAIL (layout collision not ruled out)

### Exact Code Boundaries

**Bottom-Sheet** (`client/src/components/GlassBottomSheet.tsx:23-50`):
```tsx
snapPoints = ['55%', '90%'] (web) or ['55%', '100%'] (native)
topInset={insets.top}
bottomInset={insets.bottom}  ← From useSafeAreaInsets()
```

**Pane Sheet** (`client/src/components/TmuxPaneSheet.tsx:17-51`):
```tsx
<GlassBottomSheet ref={sheet} title="Panes">
  <BottomSheetScrollView contentContainerStyle={styles.list}>
    {panes.map(...)}
  </BottomSheetScrollView>
</GlassBottomSheet>
```

**Multi-Terminal** (`client/src/components/MultiTerminal.tsx:170`):
```tsx
export function MultiTerminal({
  sessions, onInput, onResize, onClose, 
  bottomInset = 0,    ← External inset parameter
  keyboardInset = 0   ← Keyboard overlay inset
}: Props)
```

### Layout Defect Boundaries [INFERENCE from audit]

1. **Snap-Point Collision** [INFERENCE]:
   - 55% snap-point leaves 45% for terminal panes
   - On portrait orientation (small screens), terminal content may be hidden behind sheet
   - **Suspected Code**: GlassBottomSheet.tsx:30 does not account for MultiTerminal.tsx:170 bottomInset parameter
   - **Unverified**: No test coverage for portrait layout collision detection

2. **Inset Cascade** [UNRESOLVED]:
   - GlassBottomSheet reads `useSafeAreaInsets()` independently
   - MultiTerminal receives separate `bottomInset` prop
   - **Unverified**: Both insets applied double, or one ignored? (requires runtime inspection)

3. **Scroll-View Overflow** [INFERENCE]:
   - TmuxPaneSheet.tsx:27 `BottomSheetScrollView` has no max-height
   - With many panes (20+), scroll-view may consume snap-point reserved space
   - **Unverified**: No test coverage; suspected defect boundary only

### Security/Lifecycle Invariant

**Required**: Terminal content must remain fully accessible (readable, typeable) when pane sheet at minimum snap-point.  
**Currently Unverified**: No layout measurement tests; portrait orientation untested.

### Reproducible Acceptance Criteria

1. **Add Many Panes**: Create 25+ tmux panes in active session
2. **Open Sheet at 55%**: Trigger TmuxPaneSheet → verify snaps to 55%
3. **Verify Terminal Visible**: Active terminal pane content fully visible above sheet
4. **Verify Interaction**: 
   - User can type in visible terminal content
   - Sheet handle and title visible
   - Pane list scrollable without overflow past snap-point
5. **Portrait Orientation Test** (small screen):
   - Rotate device to portrait
   - Repeat steps 2-4
   - Verify no obscuration of terminal content
6. **Keyboard Interaction**:
   - Type in terminal → keyboard appears
   - Verify sheet does not overlap keyboard
   - Keyboard dismissal → sheet snaps back to 55%

### Regression/Smoke Evidence Required

**Realistic End-to-End Runs** (both required):

1. **Web (Expo Web)**: 
   - Simulate portrait: resize browser to narrow width
   - Create 25+ tmux panes
   - Open sheet, measure on-screen geometry
   - Verify terminal content above sheet boundary

2. **Android (Expo Android)**:
   - Physical device or emulator in portrait mode
   - Create 25+ panes
   - Open sheet
   - Type in terminal (ensure keyboard interaction)
   - Measure screen layout with adb/developer tools

### Code Inspection Boundaries

**Already Traced** ✓:
- `client/src/components/GlassBottomSheet.tsx:30` — snap-points definition
- `client/src/components/TmuxPaneSheet.tsx:27` — scroll-view layout
- `client/src/components/MultiTerminal.tsx:170` — bottomInset parameter

**Untraced** (affects remediation):
- Exact inset calculation in both components (double-count risk)
- Safe-area context cascade through component hierarchy
- Keyboard inset integration with snap-point animation

### Oracle/Flow Auditor Gates

- [ ] **Web E2E Run**: Portrait mode, 25+ panes, snap-point collision check
- [ ] **Android E2E Run**: Device portrait, pane sheet interaction, keyboard overlay
- [ ] **Flow Auditor**: Trace inset propagation, layout measurement at snap-points

---

## MANUAL-006: Terminal Termination Lifecycle

**Title**: Terminal terminate and stale active dashboard cards  
**Status**: FAIL (reconciliation race condition not ruled out)

### Exact Code Boundaries

**API Close Session** (`client/src/lib/api.ts:52`):
```tsx
async closeSession(id: string): Promise<void> {
  await this.request(`/v1/sessions/${encodeURIComponent(id)}/close`, { method: 'POST' });
}
```

**Daemon Channel** (`client/src/lib/daemon-channel.ts:136-249`):
```tsx
closeChannel(channelId: string): void {
  this.closeSocket(channelId);  // ← WebSocket.close()
}

onclose = () => {
  if (this.status !== 'closed' && this.subscribers.has(channelId)) {
    // ← May auto-reconnect
  }
}
```

**Session Store** (`client/src/lib/multi-session.ts`):
```tsx
closeSession(sessions, id) {
  // Removes session from store, calls reconcileSplit()
  // Does NOT verify backend session dead
}
```

### Semantic Boundary: Close View vs Terminal Process Exit [INVESTIGATE]

- **Client closeSession**: API call to close view (WebSocket close)
- **Backend Session Cleanup**: Mechanism UNRESOLVED [INFERENCE]; likely NOT automatic or immediate
- **Terminal Process**: PTY or tmux may remain after channel closes [UNRESOLVED]
- **Risk** [INFERENCE]: Stale dashboard card persists; reconnect reattaches to dead process

**Behavior Unresolved** [INVESTIGATE]:
- Dashboard X button semantics: Which endpoint invoked? Unclear.
- Dashboard row auto-removal after session close: NOT directly evidenced.
- Backend cleanup confirmation: UNRESOLVED.

### Security/Lifecycle Invariant

**Required**: 
1. After closeSession POST returns HTTP 200, terminal process must be dead.
2. Dashboard active row must be automatically removed (NOT via user X click).
3. Row removal must persist after reload/reconnect.
4. **Close-View** (X button) must remain distinct and explicit: Does NOT invoke closeSession; removes local card only.

**Currently Unverified**: No backend cleanup confirmation; reconciliation trigger UNKNOWN.

### Reproducible Acceptance Criteria

1. **Start Terminal**: Create session, send shell command (verify running)
2. **Invoke Close Session**: Call `closeSession(id)` via API → HTTP 200
3. **Verify Daemon Channel Closed**:
   - Network inspector: WebSocket close frame sent/received
   - Backend logs: session marked dead or cleanup event
4. **Verify Dashboard Auto-Removal**: Terminal row automatically removed from dashboard (NOT via user X click)
5. **Kill Terminal Remotely**:
   - Backend: verify process listing shows terminated
   - OR: tmux/PTY kill confirmation
6. **Reload App**: Verify dashboard row remains absent
7. **Reconnect Attempt**: Verify explicit error (session dead) or row absent
8. **Close-View Test** (distinct action):
   - Start new terminal session
   - Send command (verify running)
   - DO NOT invoke closeSession
   - Click X button (close-view action)
   - Verify row removed from dashboard
   - Verify remote terminal process still running (backend check)

### Regression/Smoke Evidence Required

**Realistic End-to-End Runs** (both required):

1. **Web (Expo Web)**:
   - Start terminal, send command (verify output)
   - Call closeSession API
   - Inspect network: WebSocket close
   - Verify dashboard row auto-removed (NOT via X click)
   - Kill terminal process (remote)
   - Reload page → verify row absent
   - Verify close-view (X click) remains distinct and explicit

2. **Android (Expo Android)**:
   - Physical device or emulator
   - Start terminal, run command
   - Close session API
   - Kill terminal remotely
   - App background/foreground transitions
   - Reload/restart app
   - Verify row absent; close-view distinct

### Code Inspection Boundaries

**Already Traced** ✓:
- `client/src/lib/api.ts:52` — closeSession endpoint
- `client/src/lib/daemon-channel.ts:136-249` — channel lifecycle
- `client/src/lib/multi-session.ts` — session store removal

**Untraced** (affects remediation):
- Backend session cleanup trigger (after client closeSession POST)
- Reconciliation event between client and backend (missing?)
- Auto-reconnect logic in daemon-channel (may mask stale state)
- Dashboard X button handler (which API invoked?)

### Oracle/Flow Auditor Gates

- [ ] **Web E2E Run**: Close, kill remotely, reload, no stale card
- [ ] **Android E2E Run**: Same, with app background/foreground transitions
- [ ] **Flow Auditor**: Trace closeSession → backend cleanup confirmation → reconciliation

---

## MANUAL-007: noVNC Real-World Failure

**Title**: noVNC real-world failure investigation  
**Status**: FAIL (diagnostic clarity insufficient; remote failure modes untested)

### Exact Code Boundaries

**RFB Proxy Handler** (`backend/internal/server/server.go:1564-1650`):
```go
func (s *Server) handleRFBProxy(w http.ResponseWriter, r *http.Request) {
  // Line 1565: desktopOriginAllowed(r.Header.Get("Origin"))
  // Line 1571: s.desktopTickets.Attempt(ticketPlain, "desktop:connect", time.Now())
  // Line 1583: desktopDiagnostic(attemptID, "connection_slot_acquired")
  // Line 1592: desktopDiagnostic(attemptID, "vnc_dialed")
  // Line 1597: ErrorEnvelope{Code: "vnc_unavailable"}
}
```

**Diagnostic Function** (`backend/internal/server/server.go:1557`):
```go
func desktopDiagnostic(attemptID, stage string, details ...any) {
  log.Printf("[desktop diagnostic] attempt=%q stage=%s %v", attemptID, stage, details)
  // Generic stages: "ticket_validated", "connection_slot_acquired", "vnc_dialed"
}
```

**Desktop Session Creation** (`backend/internal/server/server.go:1462-1500`):
```go
func (s *Server) handleDesktopSessionCreate(w http.ResponseWriter, r *http.Request) {
  // Line 1484: IssueForAttempt("desktop:connect", attemptID, 60*time.Second, ...)
}
```

**Test** (`backend/internal/server/desktop_phase5_test.go:155-272`):
- Hermetic: Local Xvfb + VNC (line 72: startXvfbAndVNC)
- Network: Loopback only (zero latency)
- Auth: TLS auto-generated (no validation)
- RFB handshake: Hardcoded (line 236-272)

### Diagnostic Defect Boundaries [INFERENCE from audit]

1. **Generic Diagnostic Labels** [INFERENCE]:
   - `"connection_slot_acquired"` (line 1583) fires before VNC dial
   - Same label if client disconnects after dial
   - **Unverified**: Operator cannot distinguish pre-dial vs post-dial failure

2. **Ticket Expiry Enforcement** [UNRESOLVED]:
   - Issued for 60 seconds (line 1484)
   - Timeout mechanism in proxy NOT visible in code

3. **VNC Address Source** [UNRESOLVED]:
   - Code dials `vncAddr` (line 1592)
   - Suspected hardcoded localhost:5900 or env var (NOT confirmed)
   - Real-world: may fail if VNC on different host/port

4. **No Remote Failure Coverage** [INFERENCE]:
   - Test uses local Xvfb (always available)
   - Real-world failures (network delay, cert validation, VNC unavailable) untested

### Security/Lifecycle Invariant

**Required**: All client disconnections and VNC failures must produce distinct, actionable diagnostic messages enabling operator triage.  
**Fixture vs Real-World Divergence** [INFERENCE]: Hermetic test (local Xvfb) assumes perfect conditions; real-world (remote VNC, network delay, cert validation) untested.

### Reproducible Acceptance Criteria

1. **Baseline Success**: Connect to local VNC (Xvfb) via noVNC → verify working
2. **Remote VNC Configuration**:
   - Deploy backend pointing to actual remote VNC server (not localhost)
   - Verify connection succeeds (if VNC accessible)
3. **Failure Mode Tests** (each must produce distinct diagnostic):
   - **Kill VNC mid-handshake**: Diagnostic must distinguish from pre-dial failure
   - **Slow Network**: Diagnostic must identify timeout stage
   - **Invalid Cert**: TLS error must include cert details (not generic "vnc_unavailable")
   - **Ticket Expired**: Diagnostic must indicate ticket-expired (not generic)
   - **Origin Forbidden**: Diagnostic must show actual origin rejection
4. **Capture Logs**: For each failure, backend log must provide actionable next-step
5. **Client Error Handling**:
   - noVNC browser console error captured
   - Operator can correlate client + server logs by attemptID

### Regression/Smoke Evidence Required

**Realistic End-to-End Runs** (both required):

1. **Web (Expo Web)**:
   - Desktop session creation: receive WSUrl + ticket
   - Open VNC client in browser (noVNC)
   - Kill VNC server mid-session
   - Verify browser console error + backend diagnostic logs
   - Verify operator can diagnose failure from logs

2. **Operator Manual Reproduction** (realistic path):
   - Deploy to staging with real remote VNC backend
   - Reproduce operator-reported failure (specifics provided)
   - Collect logs with improved diagnostics
   - Verify logs enable action (retry, debug, escalate)

### Code Inspection Boundaries

**Already Traced** ✓:
- `backend/internal/server/server.go:1564-1650` — RFB proxy handler
- `backend/internal/server/server.go:1557` — diagnostic function
- `backend/internal/server/desktop_phase5_test.go:155` — hermetic test

**Untraced** (affects remediation):
- Exact VNC address resolution (hardcoded? env var? config?)
- Ticket expiry enforcement mechanism
- WebSocket proxy buffer management and timeouts
- Client-side noVNC error handling (in browser, not server)
- TLS cert validation and error reporting

### Oracle/Flow Auditor Gates

- [ ] **Web E2E Run**: Remote VNC, capture logs for each failure mode
- [ ] **Operator Manual Path**: Reproduce reported failure, verify improved diagnostics enable action
- [ ] **Flow Auditor**: Trace from noVNC client → RFB proxy → diagnostic labels → actionable message

---

## MANUAL Completion Status Summary

| Item | Status | Gate Requirement |
|------|--------|------------------|
| MANUAL-001 | OPEN | OMP source discovery (harness modes, commands, messages) |
| MANUAL-002 | OPEN | Composer + OMP source discovery (slash commands, @ mentions) |
| MANUAL-003 | OPEN | Composer + OMP source discovery (file attachment protocol) |
| MANUAL-004 | FAIL | Web + Android E2E: terminate, auto-remove row, reconnect |
| MANUAL-005 | FAIL | Web + Android E2E: portrait layout, pane sheet collision |
| MANUAL-006 | FAIL | Web + Android E2E: close, auto-remove row, stale card gone |
| MANUAL-007 | FAIL | Web E2E: remote VNC, distinct diagnostics per failure mode |

---

## ENH-001: Ghostty Terminal Engine

**Title**: Replace xterm.js with Ghostty terminal engine  
**Status**: BLOCKED  
**Gate**: All MANUAL-001 through MANUAL-007 must reach acceptable status (OPEN or PASS, no FAIL)

### Prerequisite Verification

✗ MANUAL-004: Agent lifecycle reconciliation (FAIL)  
✗ MANUAL-005: Terminal pane layout (FAIL)  
✗ MANUAL-006: Terminal close lifecycle (FAIL)  
✗ MANUAL-007: noVNC diagnostics (FAIL)  
⊘ MANUAL-001: Pending OMP audit (OPEN)  
⊘ MANUAL-002: Pending OMP audit (OPEN)  
⊘ MANUAL-003: Pending OMP audit (OPEN)

**Current Gate Status**: BLOCKED (4 items FAIL, 3 items OPEN awaiting discovery)

### Unblocking Condition

ENH-001 may only proceed after:
1. MANUAL-004, MANUAL-005, MANUAL-006, MANUAL-007 reach PASS or acceptable OPEN (subject to audit progress)
2. MANUAL-001, MANUAL-002, MANUAL-003 complete OMP source discovery and provide unblocking signoff

---

## ENH-002: Advanced Agent Chat Composer + Mode Panel

**Title**: Advanced Agent Chat composer features and mode panel  
**Status**: BLOCKED  
**Gate**: ENH-001 must complete; all MANUAL items must be acceptable

### Prerequisite Verification

✗ ENH-001: Ghostty engine (BLOCKED)

**Current Gate Status**: BLOCKED (ENH-001 not started)

### Unblocking Condition

ENH-002 may only proceed after:
1. ENH-001 completes and passes acceptance
2. All MANUAL items are at acceptable status

---

## ENH-003: Claude + Codex Harness Adapters

**Title**: Multi-harness adapter implementation (Claude, Codex)  
**Status**: BLOCKED (MANDATORY)  
**Gate**: ENH-001 and ENH-002 must complete; all MANUAL items must be at acceptable status

### Prerequisite Verification

✗ ENH-002: Advanced composer (BLOCKED)

**Current Gate Status**: BLOCKED (mandatory; ENH-001 and ENH-002 not started)

### Unblocking Condition

ENH-003 may only proceed after:
1. ENH-001 completes and passes
2. ENH-002 completes and passes
3. All MANUAL items reach acceptable status

---

## Remediation Execution Summary

### Phase 1: MANUAL Audit Completion & Discovery

**Deferred Discovery** (requires OMP source inspection before code):
- MANUAL-001: Extract harness mode/state definitions + command registry from OMP
- MANUAL-002: Extract slash command + @ mention handlers from composer + OMP
- MANUAL-003: Extract file attachment protocol + storage from OMP

**Immediate E2E Remediation** (Web + Android required):
- MANUAL-004: Agent terminate → auto-remove row → persistent absence → reconnect verification
- MANUAL-005: Terminal pane sheet → layout collision detection (portrait)
- MANUAL-006: Terminal close → auto-remove row → stale card removal → reconnect behavior
- MANUAL-007: noVNC remote failure → distinct diagnostics per mode

### Phase 2: Enhancement Gates

**Blocked Until Phase 1 Complete**:
- ENH-001: Ghostty engine (requires stable MANUAL lifecycle)
- ENH-002: Advanced composer (requires ENH-001 + MANUAL completion)
- ENH-003: Harness adapters (requires ENH-001, ENH-002, all MANUAL acceptable)

---

## Acceptance Authority

- **Oracle**: Operator manual findings (authoritative; not subject to revision)
- **Flow Auditor**: Traces end-to-end execution from client UI through backend to runtime
- **Manual Smoke Tests**: Realistic Web/Android runs with explicit step-by-step verification
- **OMP Source Discovery**: Required before implementation (MANUAL-001.003)

---

**Document Status**: DRAFT (no implementation)  
**All Items Marked**: FAIL or OPEN (no verification claimed)  
**MANUAL-001.003 Updated**: Source-proven commands only, OMP APIs unverified, prerequisites documented  
**Next Step**: Execute Phase 1 remediation + OMP discovery per exact criteria above
