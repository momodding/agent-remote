# SUPERSEDED

> Superseded by [the approved recovery architecture](recover-agent-architecture.md). Do not use this historical plan for implementation decisions.

<!-- source-branch: main -->
<!-- work-branch: omp/runtime-wiring-remediation -->

# Runtime Wiring Remediation Plan

## Goal
Remove production-path runtime mocks and complete frontend-to-daemon wiring in `agentic-remote`. Fix 4 runtime issues:
1. App gating requiring daemon before main UI (enable Vault access on fresh install with zero daemons).
2. Mocked Agent Chat and ApprovalOverlay (`client/src/lib/daemon-channel.ts`, `ApprovalOverlay.tsx`).
3. Mocked Terminal creation / session wiring.
4. noVNC client initialization / WebSocket bridge failures.

## Phases
1. AppShell & Vault Gating: Decouple main shell entry from daemon pairing requirement.
2. Daemon Channel & Terminal Wiring: Replace MockDaemonChannel with real WebSocketDaemonChannel, wire real session APIs, setImmediate flushes, modifiedTerminalInput.
3. Agent Chat & Approval Overlay: Fix interactive prompt input and option selection in ApprovalOverlay.
4. noVNC Desktop Client: Complete direct authenticated WebSocket and raw channel bridge in WebView / web.
5. Verification: Run backend and client tests, typecheck, verify end-to-end.
