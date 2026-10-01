# Android Runtime UX Remediation Ledger

## Baseline & Provenance

### Git State
- **HEAD Commit**: `2248bda36e5e9d60821363f110c35da55437868f`
- **Git Status**: clean (`git status --short` shows only untracked architecture analysis notes)
- **Latest Commit**: `2248bda omp(android-distributability): Fix proven Android build blocker`

### APK Artifacts & Provenance Analysis

| Field | Manually Verified Device APK | Build Retry Multi-ABI APK |
|---|---|---|
| **Path** | `builds/client-android.apk` | `builds/android-build-retry.apk` |
| **Size** | 52,115,902 bytes | 78,943,691 bytes |
| **SHA-256** | `30bad937e02ed694fe7ec4f9ad00abe385fbc676d6ab338ffe0f446c0c4d1623` | `278d81a0926d31b7e91c70e62c05c4e0235be7ff27bfb3a7f1ec0ab42abeba6c` |
| **Build Timestamp** | 2026-09-23 13:57:58 +0700 (06:57:58 UTC) | 2026-09-30 13:53:04 +0700 (06:53:04 UTC) |
| **ABIs Included** | `arm64-v8a` | `arm64-v8a`, `x86_64` |
| **App Config `buildArchs`** | `["arm64-v8a"]` | `["arm64-v8a", "x86_64"]` |
| **Version Code** | `8` | `8` |
| **App Version** | `1.0.0` | `1.0.0` |
| **SDK Version** | `57.0.0` | `57.0.0` |

### HEAD Match Verification
- **Physical Device Target (`builds/client-android.apk`)**:
  - Used for manual verification on Motorola Moto G45 (`arm64-v8a`).
  - Built on 2026-09-23 against pre-`2248bda` worktree (`buildArchs: ["arm64-v8a"]`).
  - **Match**: `NO` (precedes commit `2248bda`).
- **Build Retry Target (`builds/android-build-retry.apk`)**:
  - Built on 2026-09-30 13:53:04 +0700 prior to commit timestamp 14:04:11 +0700 from dirty worktree containing the changes committed in `2248bda`.
  - **Match**: `SOURCE_EQUIVALENT` (matches code changes in `2248bda`, built before commit object creation).

### Environment & Package Versions
- **Client Package Version**: `1.0.0` (`client/package.json`)
- **Expo Version**: `~57.0.7` (dependency) / `57.0.7` (canonical) / SDK `57.0.0` (`client/app.json`)
- **React Native Version**: `0.86.0` (`client/package.json`, `e2e-lab/env/versions.env`)
- **OMP Version**:
  - Host CLI: `omp/18.2.8` (`omp --version`)
  - Pinned Lab Runtime: `18.1.22` (`e2e-lab/env/versions.env`)

---

## Remediation Backlog (A01–A10)

> **Correction Note (2026-10-01):** The initial version of this table erroneously imported emulator lab harness gates (A01–A06 from `e2e-lab/ANDROID_E2E_TODO.md`). This table is now corrected to the user-authoritative manual defect taxonomy (A01–A10) covering runtime UX issues observed during device evaluation.

| ID | Defect Title | Status | Acceptance Evidence Required | Fact vs. Unproven Distinction |
|---|---|---|---|---|
| **A01** | Exited/expired session remains active | OPEN | Process exit/expiry cleanly transitions backend session to inactive, terminates stream, updates UI status indicator, and disables stale inputs. | **Fact:** `session.Manager` tracks session state. **Unproven:** Graceful status transition and UI reconciliation upon abrupt agent crash, process exit, or network expiration on Android. |
| **A02** | Terminal unusable | OPEN | Interactive PTY renders on mobile; keystrokes, mobile keyboard input bar, ANSI sequences, and scrollback function without freeze or clipping. | **Fact:** PTY WebSocket endpoint `/v1/ws/sessions/:id` exists. **Unproven:** Usable mobile terminal ergonomics, touch gestures, and software keyboard integration on Android APK. |
| **A03** | Modal/sheet overflow | OPEN | Modals and bottom sheets fit within viewport, scroll overflowing content internally, and respect system gesture/navigation safe area insets. | **Fact:** Bottom sheet UI components exist in `client/src`. **Unproven:** Dynamic height recalculation, internal scrolling, and gesture dismiss across varied Android screen sizes. |
| **A04** | Multi-turn OMP chat | OPEN | Sequential multi-turn prompts and responses sustain state, stream sequentially, and preserve conversation history without turn loss or crash. | **Fact:** Client/daemon chat protocol messages exist. **Unproven:** Sustained multi-turn conversation reliability and state retention on live Android client. |
| **A05** | Useful OMP processing/activity | OPEN | Granular execution progress (tool executions, thinking, status updates) displayed with informative visual feedback during active tasks. | **Fact:** Runtime channel receives semantic events. **Unproven:** Informative, real-time activity indicators rendered cleanly on mobile screen rather than generic loading spinners. |
| **A06** | Composer covered by Android IME | OPEN | Chat input composer bar remains visible above Android virtual keyboard upon focus without blocking view of recent chat messages. | **Fact:** `KeyboardAvoidingView` present in components. **Unproven:** Proper keyboard offset handling across diverse Android IME heights and gesture navigation modes. |
| **A07** | Chat content clipped/incomplete | OPEN | Message text, markdown formatting, code snippets, and diff views render fully with horizontal scrolling for wide blocks and no vertical clipping. | **Fact:** Markdown/code rendering libraries imported in client. **Unproven:** Complete wrapping, code block bounds, and viewport constraint enforcement on narrow mobile screens. |
| **A08** | noVNC Creating RFB | OPEN | Desktop VNC connects to live display server without hanging on "Creating RFB"; connection state machine handles handshake without fake timeouts. | **Fact:** Desktop VNC view and bridge exist; fake `setTimeout` readyState bypass removed. **Unproven:** Reliable RFB handshake and live framebuffer rendering on Android client over remote proxy. |
| **A09** | Mobile UI quality | OPEN | Touch targets >= 48x48dp, contrast ratios meet WCAG AA, typography and spacing consistent, layout free of jarring shifts. | **Fact:** Styling uses Tailwind tokens in client. **Unproven:** Systematic compliance with mobile ergonomics, touch target sizing, and high-DPI scaling across Android devices. |
| **A10** | Internal system/hook content leak | OPEN | Internal harness directives, system prompts, raw event frames, and hook metadata are filtered out from user-visible chat bubbles. | **Fact:** Protocol channels process incoming events. **Unproven:** Strict client-side / server-side sanitization preventing internal control tokens or system messages from leaking into chat. |

*Historical E2E ledger preserved in `e2e-lab/ANDROID_E2E_TODO.md`.*
