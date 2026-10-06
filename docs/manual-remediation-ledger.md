# Manual Remediation Ledger

## Workstreams
### Agent Chat Parity (ENH-002 Runtime)
- **CHAT-001**: Runtime state + mode panel
  - Paired with **MANUAL-001**
  - Status: OPEN
- **CHAT-002**: Commands + mentions  
  - Paired with **MANUAL-002**
  - Status: OPEN
- **CHAT-003**: Attachments
  - Paired with **MANUAL-003**
  - Status: OPEN
- **CHAT-004**: Final composer UX/selection
  - Status: OPEN

**Baseline Capture Date**: 2026-10-06
**Git HEAD**: c64e451663c96388c9827f935cf2ef9d6c462b26
**Git Status**: Clean (no staged/unstaged changes)
**Git Diff**: No uncommitted modifications

## Environment Versions

### Build & Runtime Versions
- **Client Build**: 1.0.0 (Expo 57.0.7, React 19.2.3, React Native 0.86.0)
- **Daemon Build**: Go 1.26.4 backend binary (ELF 64-bit, 19.9MB, dated Oct 5 21:13:00 UTC)
- **OMP Version**: 18.6.1 (omp/18.6.1)
- **tmux Version**: 3.4
- **noVNC Version**: 1.5.0 (@novnc/novnc package)
- **Terminal Engine**: xterm.js 5.3.0 (client/package.json: `"xterm": "^5.3.0"` + xterm-addon-fit 0.8.0; reference implementation: client/src/components/Terminal.web.tsx)

## Remediation Items

### MANUAL Items

#### MANUAL-001
**Title**: Harness mode/state parity  
**Status**: OPEN  
**Evidence Source**: Operator manual  
**Notes**: Harness mode and state consistency tracking.

#### MANUAL-002
**Title**: Slash/@ command composer parity  
**Status**: OPEN  
**Evidence Source**: Operator manual  
**Notes**: Command composer slash and @ reference parity.

#### MANUAL-003
**Title**: Image/file attachment  
**Status**: OPEN  
**Evidence Source**: Operator manual  
**Notes**: Image and file attachment handling.

#### MANUAL-004
**Title**: Agent termination lifecycle  
**Status**: OPEN  
**Evidence Source**: Operator manual  
**Notes**: Agent process termination lifecycle management.

#### MANUAL-005
**Title**: Terminal pane bottom-sheet layout  
**Status**: OPEN  
**Evidence Source**: Operator manual  
**Notes**: Terminal pane bottom-sheet layout implementation.

#### MANUAL-006
**Title**: Terminal termination lifecycle  
**Status**: OPEN  
**Evidence Source**: Operator manual  
**Notes**: Terminal process termination lifecycle management.

#### MANUAL-007
**Title**: noVNC real-world failure  
**Status**: OPEN  
**Evidence Source**: Operator manual  
**Notes**: noVNC (1.5.0) production failure investigation and remediation.



### Agent Chat Parity Items (ENH-002 Workstream)

#### CHAT-001
**Title**: Runtime state + mode panel
**Status**: OPEN
**Paired With**: MANUAL-001
**Evidence Source**: Protocol audit
**Notes**: Agent Chat composer runtime state display and mode panel. Part of ENH-002 workstream.

#### CHAT-002
**Title**: Commands + mentions
**Status**: OPEN
**Paired With**: MANUAL-002
**Evidence Source**: Protocol audit
**Notes**: Slash/@ command resolution and mention completion. Part of ENH-002 workstream.

#### CHAT-003
**Title**: Attachments
**Status**: OPEN
**Paired With**: MANUAL-003
**Evidence Source**: Protocol audit
**Notes**: Image/file attachment handling in composer. Part of ENH-002 workstream.

#### CHAT-004
**Title**: Final composer UX/selection
**Status**: OPEN
**Evidence Source**: Protocol audit
**Notes**: Composer selection flow and message finalization. Part of ENH-002 workstream.


#### ENH-001
**Title**: Ghostty terminal engine  
**Status**: OPEN  
**Evidence Source**: Operator manual  
**Blocked By**: MANUAL-001, MANUAL-002, MANUAL-003, MANUAL-004, MANUAL-005, MANUAL-006, MANUAL-007  
**Notes**: Replace xterm.js with Ghostty terminal engine. Awaiting all MANUAL items completion.

#### ENH-002
**Title**: Advanced Agent Chat composer + mode panel  
**Status**: OPEN  
**Evidence Source**: Operator manual  
**Blocked By**: MANUAL-001, MANUAL-002, MANUAL-003, MANUAL-004, MANUAL-005, MANUAL-006, MANUAL-007, ENH-001  
**Notes**: Advanced composer features and mode panel. Awaiting all MANUAL items + ENH-001 completion.

#### ENH-003
**Title**: Claude + Codex harness adapters  
**Status**: BLOCKED  
**Evidence Source**: Operator manual  
**Blocked By**: MANUAL-001, MANUAL-002, MANUAL-003, MANUAL-004, MANUAL-005, MANUAL-006, MANUAL-007, ENH-001, ENH-002  
**Notes**: **MANDATORY BLOCKED** — Multi-harness adapter implementation (Claude, Codex). Cannot proceed until all MANUAL items + ENH-001 + ENH-002 pass.

## Dependency Order

Strict execution order enforced:
1. MANUAL-001 through MANUAL-007 (parallel allowed)
2. ENH-001 (after all MANUAL items pass)
3. ENH-002 (after ENH-001 passes)
4. ENH-003 (after all prior items pass) — **MANDATORY BLOCK**

---

**Record Created**: 2026-10-06  
**Repository**: /home/momodding/Documents/agentic-remote  
**Terminal Engine Citation**: client/package.json (xterm dependency), client/src/components/Terminal.web.tsx (implementation)  
**Created By**: baseline-ledger (worker agent)
