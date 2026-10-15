# Forensic Audit: MANUAL-004 through MANUAL-007

**Conducted**: 2026-10-06  
**Scope**: Agent Chat termination lifecycle, Terminal pane bottom-sheet layout, Terminal termination lifecycle, noVNC real-world failure  
**Authority**: Operator manual (assignments provided)

---

## MANUAL-004: Agent Termination Lifecycle

### Source Components

**API Layer** (`client/src/lib/api.ts`):
- **`terminateAgent(id: string): Promise<void>`** (line 79)
  - Endpoint: POST `/v1/agents/${encodeURIComponent(id)}/terminate`
  - Distinct from `abortAgent()` (line 75, POST `/abort`)
  - Distinct from `closeSession()` (line 52, POST `/v1/sessions/${encodeURIComponent(id)}/close`)

**Backend Handler** (`backend/internal/server/server.go`):
- **`handleAgentAction()`** (line 423)
  - Routes to case `"terminate"` (line 504)
  - Calls `s.agents.TerminateAgent(ctx, id)`
  - Error response: `protocol.ErrorEnvelope{...Code: "terminate_failed"...}` (line 506)
  - Case `"abort"` (line 469) separate from terminate

**Test Coverage** (`client/src/__tests__/agent-lifecycle.test.tsx`):
- ✓ `terminateAgent endpoint` test (line 20: "should call /v1/agents/{id}/terminate POST")
- ✓ URL encoding test (line 54)
- ✓ Failure handling test (line 40)
- ✓ Lifecycle state contract test (line 76: "terminateAgent should be distinct from closeSession")

### Close View vs Terminate Remote Process: Semantic Boundary

**Evidence from source**:
- `client/src/agent-route.test.tsx`: Dashboard route has close/remove UI separate from termination lifecycle
- Backend distinguishes:
  - **`terminateAgent`**: Kill remote agent process via OMP/runtime
  - **`closeSession`**: Close view/session in client state (does NOT kill backend process; subject to reconciliation/reconnect)
  - **`abortAgent`**: Interrupt running prompt (distinct from both)

### Lifecycle Reconciliation Fix

**Implemented source evidence**:
- `client/src/lib/tabs/tab-store.ts`: `removeExitedAgentTabs()` removes local agent tabs when the authoritative runtime snapshot marks the corresponding agent `exited`.
- `client/app/index.tsx`: runtime snapshot changes dispatch that cleanup for every connected daemon, including reconnect/resync.
- `client/src/lib/session-surface.ts`: defensive rendering filter excludes an exited agent even before cleanup commits, so a stale local tab cannot retain the card.

### Remaining Validation Gap
- A real daemon/browser termination-and-reconnect exercise is still required to prove backend event delivery, browser subscription lifecycle, and visible card removal.
- The focused tests do not establish those runtime boundaries.

### Test Coverage
- `client/src/lib/tabs/tab-store.test.ts`: `agent.updated` → exited runtime snapshot removes the matching local agent tab and selects a valid remaining tab.
- `client/src/lib/session-surface.test.ts`: stale local agent tabs do not produce an exited agent surface.
- `client/src/__tests__/dashboard-agent-termination-removal.test.tsx`: event reconciliation and stale-tab surface filtering coverage.

### Manual Validation Status: OPEN / BLOCKED_ENVIRONMENT
- On 2026-10-07, the repository daemon was built and started with `examples/config.local.json`; `curl --insecure https://127.0.0.1:8765/healthz` returned `{"ok":true,"version":"dev"}`. The Expo web client also loaded in the managed browser and rendered the daemon pairing form.
- The live pairing attempt used a fresh daemon payload with “Skip fingerprint verification” selected. Browser requests to `https://127.0.0.1:8765/healthz` failed with `net::ERR_CERT_AUTHORITY_INVALID`; client diagnostics then reported `health probe failed` and `attemptAuth failed: Connection failed`. The client requires HTTPS pairing endpoints, so the daemon's loopback HTTP listener is not a valid fallback.
- No browser client paired, no dashboard card rendered, and no real termination/reconnect could be executed. This finding MUST NOT be marked PASS until the daemon certificate is trusted by the validation browser (or a browser-trusted HTTPS endpoint is supplied).

### Required Manual Regression Path
1. Pair a browser client with the daemon using a browser that trusts its development certificate.
2. Start an agent, terminate it remotely, and observe the dashboard card disappear.
3. Reload or reconnect the dashboard and confirm the card remains absent.
4. Confirm the remote process exited with an OMP status check or `ps`.

---

## MANUAL-005: Terminal Pane Bottom-Sheet Layout

### Source Components

**Bottom-Sheet Components** (`client/src/components/`):
- **`GlassBottomSheet.tsx`** (line 23-36): Wrapper around `@gorhom/bottom-sheet`
  - `snapPoints`: `['55%', '90%']` (web) or `['55%', '100%']` (native) (line 30)
  - Uses `BottomSheetModal`, `BottomSheetView`, `BottomSheetBackdrop`
  - Insets: `topInset={insets.top}`, `bottomInset={insets.bottom}` (lines 43-44)

- **`TmuxPaneSheet.tsx`** (line 1-51): Pane selection sheet
  - Uses `GlassBottomSheet` wrapper
  - Content: `BottomSheetScrollView` with pane list (line 27)
  - Styling: `styles.list`, `styles.row`, `styles.empty`
  - Current pane highlighting with `selected` state (line 35)

**Multi-Terminal Layout** (`client/src/components/MultiTerminal.tsx`):
- **`MultiTerminal`** (line 170-271): Manages split panes, drag-drop, terminal tabs
- Props: `bottomInset`, `keyboardInset` (line 170)
- Nested `DraggableTab` component for each session tab
- Drag-drop zone calculation via `dropSlot()` (line 21-30)

### Suspected Layout Defect Boundaries [INFERENCE]

1. **Bottom inset measurement**:
   - `GlassBottomSheet` reads `useSafeAreaInsets()` (line 3)
   - But does NOT account for `bottomInset` parameter passed to `MultiTerminal`
   - **Suspected race**: Sheet snap-points may overlap terminal content when keyboard/tab bar present
   - No explicit padding/margin isolation between sheet and terminal panes

2. **Snap-point collision**:
   - Web snap-points: `55%` → leaves 45% of viewport for terminal
   - Native snap-points: `55%` → on small screens (portrait), may hide active terminal pane
   - **Suspected boundary**: Portrait orientation on small devices (< 400px height)

3. **Scroll-view overflow**:
   - `BottomSheetScrollView` content (pane list) has no max-height constraint
   - If pane list very long, scroll-view may consume snap-point space, hiding sheet title/handle

4. **Safe-area insets cascade**:
   - `MultiTerminal` receives `bottomInset` prop but no direct safe-area context
   - Sheet reads safe-area independently → double-inset or missed-inset possible

### Existing Tests
- `client/src/components/GlassBottomSheet.test.tsx`: Sheet presentation/dismissal only
- `client/src/components/TmuxPaneSheet.test.tsx`: Pane selection logic; no layout measurement tests
- `client/src/components/MultiTerminal.test.tsx`: Tab drag-drop; no bottom-sheet integration

### Test Coverage Gaps
- No test for: snap-point collision with active terminal pane
- No test for: bottom-sheet layout with `bottomInset` parameter
- No test for: scroll-view overflow in pane list (long pane count)
- No test for: keyboard inset interaction with snap-points

### Minimal Corrective Plan (Manual)
1. Open terminal with many tmux panes (> 20 panes)
2. Trigger TmuxPaneSheet open
3. Verify snap-points do not obscure active terminal content
4. Verify snap-point handle/title visible at 55% snap
5. Test on portrait orientation (small screen)
6. Verify keyboard inset does not collide with sheet

### Manual Regression Path
- Open app on small phone in portrait mode
- Add 20+ tmux panes
- Open pane sheet → check alignment and visibility
- Type in terminal → keyboard appears → verify sheet repositions
- Scroll pane list → verify no overflow past snap-points
- Close sheet → verify terminal content fully accessible

---

## MANUAL-006: Terminal Termination Lifecycle

### Source Components

**API Layer** (`client/src/lib/api.ts`):
- **`closeSession(id: string): Promise<void>`** (line 52)
  - Endpoint: POST `/v1/sessions/${encodeURIComponent(id)}/close`
  - Closes session view, NOT necessarily terminal process

**Client Daemon Channel** (`client/src/lib/daemon-channel.ts`):
- **`closeChannel(channelId: string): void`** (line 136)
  - Closes WebSocket connection for a specific channel
  - Triggers socket cleanup via `closeSocket()` (line 238-249)
- **Status states**: `'connecting'`, `'open'`, `'closed'`, `'error'` (line 38)
- **Reconciliation**: `onclose` handler (line 196) checks if channel still subscribed; may reconnect

**Multi-Session Store** (`client/src/lib/multi-session.ts`):
- **`closeSession(sessions, id)`**: Removes session from tab store
- Calls `reconcileSplit()` on remaining sessions (layout reflow)

**Backend Session Handler** (`backend/internal/server/server.go`):
- Route: `/v1/sessions/` → `s.withAuth(s.handleSessionAction)` (line 126)
- Close action calls session manager (internal API not yet traced)

### Terminal Process Exit vs Session Close: Semantic Boundary

**Evidence**:
- **Client close-session**: Removes UI card, closes daemon-channel WebSocket
- **Remote terminal process**: PTY or tmux session may remain running after channel closes
- **Reconnect**: Client can re-open closed session; if backend session still alive, recovery possible

**Suspected Defect Boundary** [INFERENCE]:
- Client close → daemon-channel close → **WebSocket stub remains in backend** (session not cleaned up)
- Stale active dashboard card appears after terminal process dies but session stub persists
- Reconnect attempts to reattach to dead process → silent failure or cryptic error
- No explicit "confirm session dead" signal from backend to client

### Test Coverage
- `client/src/lib/multi-session.test.ts`: Session add/close state; no lifecycle tests
- `client/src/lib/daemon-channel.test.ts`: Channel open/close; no reconciliation with backend state
- `client/src/terminal-route.test.tsx`: Terminal route basics; no termination flow

### Test Coverage Gaps
- No test for: close-session + remote PTY death reconciliation
- No test for: stale card removal after terminal dies
- No test for: reconnect to dead terminal session
- No test for: daemon-channel WebSocket close + backend session cleanup

### Minimal Corrective Plan (Manual)
1. Open terminal session
2. Close session via client (X button)
3. Verify daemon-channel closes (network inspector)
4. Verify backend session marked dead or cleaned
5. Kill terminal process remotely (tmux, OMP)
6. Reconnect → verify stale card gone or explicit error

### Manual Regression Path
- Start terminal
- Send command, verify output
- Click X to close session view
- Check network: WebSocket close message
- Check backend logs: session cleanup
- Verify dashboard card removed
- Force reconnect (reload app) → no stale card reappears

---

## MANUAL-007: noVNC Real-World Failure

### Source Components

**Backend RFB Proxy** (`backend/internal/server/server.go`):
- **`handleRFBProxy()`** (line 1564)
  - Validates origin via `desktopOriginAllowed()` (line 1565)
  - Looks up ticket (desktop auth) (line 1571)
  - Acquires connection slot (line 1583)
  - Dials VNC server (line 1592)
  - **Diagnostic points**: `desktopDiagnostic()` at each stage
    - `"ticket_validated"` (line 1576)
    - `"connection_slot_acquired"` (line 1583)
    - `"vnc_dialed"` (line 1592)
    - **Generic label: "connection_slot_acquired"** — loses evidence of specific failure cause

**Desktop Session Creation** (`backend/internal/server/server.go`):
- **`handleDesktopSessionCreate()`** (line 1462)
  - Issues ticket for 60 seconds (line 1484)
  - Returns WSUrl, ticket (line 1492-1500)
- **`desktopWebSocketBase()`** (line 1500)
  - Requires valid public endpoint
  - Requires HTTPS

**Desktop Diagnostics** (`backend/internal/server/server.go`):
- **`desktopDiagnostic(attemptID, stage, ...details)`** (line 1557)
  - Logs: `[desktop diagnostic] attempt=%q stage=%s %v`
  - **Defect**: Generic stage names do not disambiguate:
    - Client disconnect → "connection_slot_acquired" (before VNC dial) indistinguishable from POST-VNC-dial disconnect

**Test Coverage** (`backend/internal/server/desktop_phase5_test.go`):
- **`TestGoldenFlowPhase5Desktop()`** (line 155): Hermetic test with Xvfb + VNC mock
- **Test WebSocket stream** (line 40-70): `wsStream` adapter reads RFB protocol
- **RFB handshake**: Reads version, sends challenge, checks security result (line 236-272)
- **Assumptions**: VNC running locally, TLS cert valid, network connectivity perfect

### Client Disconnect Handling Gaps

**Evidence from test**:
- noVNC 1.5.0 (`@novnc/novnc` package, client/package.json)
- Client-side RFB error handling not audited (would require client-side desktop code inspection)

**Suspected Failure Boundaries** [INFERENCE]:

1. **Ambiguous diagnostic stage labels**:
   - "connection_slot_acquired" fires **before** VNC dial attempt (line 1583)
   - If client disconnects after ticket validated but before dial completes, same label
   - Operator cannot distinguish: pre-dial client disconnect vs post-dial VNC unavailable
   - **Evidence loss**: Exact failure cause obscured

2. **Ticket expiry not enforced at proxy**:
   - Ticket issued for 60 seconds (line 1484)
   - No timeout enforcement in `handleRFBProxy()` visible
   - Client may hold WebSocket open past ticket expiry; VNC connection undefined

3. **VNC address resolution**:
   - Code dials `vncAddr` (line 1592) but source of `vncAddr` not traced in excerpt
   - **Suspected boundary**: Hardcoded `localhost:5900` or environment variable
   - Real-world failure: If VNC on different host/port, dial fails silently
   - Diagnostic: Only generic "vnc_unavailable" (line 1597)

4. **WebSocket proxy buffering**:
   - No explicit buffer size limits shown in excerpt
   - Fixture test: Xvfb/VNC on localhost (perfect network)
   - Real-world: Slow client (cellular), high-latency VNC server → buffer deadlock or timeout

5. **Origin check strictness**:
   - `desktopOriginAllowed()` (line 1514)
   - Real-world: Browser CORS may fail before reaching proxy
   - Client gets generic "forbidden_origin" (line 1570) instead of actual origin value

### Fixture vs Real-World Divergence

**Hermetic Fixture** (`desktop_phase5_test.go`):
- VNC server: Local Xvfb (in-process)
- Network: Loopback (zero latency, no packet loss)
- Auth: TLS cert auto-generated and trusted (no cert validation errors)
- Diagnostics: All stages logged to `t.Logf()` (visible)

**Real-World Path**:
- VNC server: Remote or container (unknown network path)
- Network: Cellular/WAN (packet loss, latency, jitter)
- Auth: TLS cert chain validation (client trust store, OCSP stapling)
- Diagnostics: Logs to stdout/file (operator must fetch, diagnose offline)
- Client: noVNC JS in browser (CSP, sandbox restrictions may block RFB data)

### Test Coverage Gaps
- No test for: ticket expiry enforcement
- No test for: slow/latent VNC server (simulated delays)
- No test for: client disconnect mid-handshake
- No test for: invalid VNC address
- No test for: TLS cert validation failure
- No test for: WebSocket proxy buffer overflow

### Existing Tests
- `backend/internal/server/desktop_phase5_test.go`: Golden flow only; no failure modes
- No integration test: actual noVNC client + real remote VNC server
- No chaos test: network delay, disconnection, certificate invalidation

### Minimal Corrective Plan (Manual)
1. **Baseline**: Connect to VNC on localhost via noVNC → verify success
2. **Remote VNC**: Reconfigure backend to dial remote VNC server
3. **Disconnect scenarios**:
   - Kill VNC server mid-handshake → check diagnostic output
   - Slow network (simulate via tc/iptables) → observe timeout behavior
   - Invalid cert → check TLS error handling
4. **Evidence collection**:
   - Capture backend logs with full diagnostic context
   - Capture noVNC client error (browser console)
   - Correlate timestamps and attempt IDs

### Manual Regression Path
- Deploy to staging with real VNC backend
- Reproduce operator-reported failures (list from MANUAL-007 findings)
- Collect before/after logs showing improved diagnostic clarity
- Verify each failure mode produces distinct, actionable diagnostic message
- Test recovery: reconnect after transient VNC outage

---

## Summary: Exact Boundaries and Inference Tags

| Item | Source Files | Suspected Defect Boundary | Evidence Type | Test Gap |
|------|-----------|--------|---|---|
| **MANUAL-004** | `api.ts:79`, `server.go:504`, `agent-lifecycle.test.tsx:20` | Dashboard X may not confirm agent process killed; stale card persists | Code inspection | No UI reconciliation test |
| **MANUAL-005** | `GlassBottomSheet.tsx:30`, `TmuxPaneSheet.tsx:27`, `MultiTerminal.tsx:170` | Bottom-sheet snap-points may overlap terminal on small portrait screens; inset cascade collision [INFERENCE] | Code inspection | No layout collision test; no portrait orientation test |
| **MANUAL-006** | `api.ts:52`, `daemon-channel.ts:136`, `server.go:126` | Client close-session closes view but backend session may remain; reconnect fails silently; stale card reappears [INFERENCE] | Code inspection | No reconciliation test; no reconnect-to-dead-session test |
| **MANUAL-007** | `server.go:1564,1583,1592`, `desktop_phase5_test.go:155` | Diagnostic labels too generic; ticket expiry not enforced; VNC address assumed localhost; real-world latency/cert failure untested [INFERENCE] | Code inspection + test coverage | No remote VNC test; no chaos test; no cert validation test |

---

**Audit Complete**: 2026-10-06  
**Report Authority**: Forensic source inspection  
**Non-Mutating**: ✓ No product code modified  
**No Tests Run**: ✓ Identified gaps only  
