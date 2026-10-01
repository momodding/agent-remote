# Android Flow Auditor Review — 2026-10-01

## Scope and method

Independent source-and-ledger review from the perspective of an Android phone user. Reviewed the current React Native implementation and the remediation sequence recorded through `484fd6192e74efbc820bcff27f2fa01f2df9ba1f`:

- Dashboard, pairing, daemon connections, agent creation, agent chat, chat/terminal switching, raw and multi-terminal, files/editor, desktop/noVNC.
- All current route-local and shared overlays: pairing, connections/editor/camera, new agent/directory browser, rename, file-action menu, pane picker, model/thinking picker, and new-session sheet.
- Loading, error, active/inactive lifecycle, keyboard/composer, content bounds, touch targets, and noVNC diagnostics.

This is a source-observable review. It does **not** claim Android emulator or physical-device verification. The Android Golden Flow remains prohibited by the documented rootful-storage/environment block.

## Release disposition

**NO-GO for Android release.** No source-observable P0 was found, but the P1 items below make critical phone flows difficult or impossible on narrow screens and leave Remote Desktop failures without a recoverable, user-meaningful Android state. Separately, every runtime-only acceptance item remains unverified because the Golden Flow has not run.

## Findings

### P0 — none source-observable

No current source path was found that deterministically leaks internal/hook records into Agent Chat, recreates an OMP process for a sequential prompt, silently drops an unavailable terminal input, or renders an unscrollable page-sheet by construction. The remediation commits introduced an allowlist renderer, single-process five-turn coverage, explicit `input_unavailable` channel errors, Android sheet height avoidance, and scroll containers.

This is not runtime confirmation of A01–A10.

### P1-01 — Agent header cannot fit its fixed controls on a narrow Android phone

- **Location:** `client/app/agent/[id].tsx:603-658`, styles at `783-824`.
- **Source evidence:** The always-visible header has Back (48), Chat/Terminal switcher (two 48-wide buttons = 96), Switch pane (48), Files (48), Terminate (48), and Close (48). Before its flexible title, this is already 336 dp of fixed width; with 24 dp horizontal padding and the six 8 dp flex gaps, it requires at least **408 dp**, before optional Abort/Model controls and before any title/status content.
- **User impact:** On a common 360 dp-width Android phone, controls will overflow, compress unpredictably, or be clipped. The user can lose access to switching from an unavailable semantic chat to Raw Terminal, closing a stuck view, or opening files.
- **Recommendation:** Move secondary actions behind an Android overflow menu; keep Back, concise status, and the Chat/Terminal segmented control as the compact-width header contract. Test at 320/360 dp with working, needs-you, and model-enabled states.

### P1-02 — Desktop/noVNC failure state strands the user without retry or useful Android diagnostics

- **Location:** `client/app/desktop.tsx:60-103`, `85-123`; remediation ledger `plans/android-runtime-ux-remediation.md:307-320`.
- **Source evidence:** If daemon lookup/session creation has not produced `connection`, `tab`, and `wsUrl`, the route renders only a status `Text` node. It offers no retry, close, or dashboard return. Once the WebView is present, native `onMessage` consumes only `status`; every structured `diagnostic` event emitted by the embedded noVNC page is discarded. The ledger expressly records that native deliberately ignores diagnostic messages and that Android WebView WSS/RFB/framebuffer evidence is absent.
- **User impact:** A user stuck at “Creating RFB…” or after an expired/failed ticket cannot recover in-app or distinguish session creation, WebSocket, security negotiation, or framebuffer failure. Android Back may work at the OS level, but it is not discoverable recovery in this task flow.
- **Recommendation:** Preserve the current redaction boundary, but render a bounded, non-secret stage/status and provide Retry (new desktop session/new ticket) plus Back/Close in both pre-WebView and disconnected/error states. A retry must mint a new session ticket rather than reuse a consumed one.

### P1-03 — Desktop controls fail the Android 48 dp touch-target floor

- **Location:** `client/app/desktop.tsx:108-121`, styles `127-136`.
- **Source evidence:** Back is a 20 dp icon with only 6 dp padding (approximately 32 dp touch box). The persistent Escape/Tab/Ctrl-Alt-Delete dock has 8 dp vertical padding around 13 dp text (approximately 29 dp tall). Neither declares a 48 dp minimum.
- **User impact:** The only visible escape/navigation and remote-control affordances are too small for reliable one-handed use, especially while interacting with a remote desktop.
- **Recommendation:** Give Back and every dock key an explicit `minWidth`/`minHeight: 48`; retain at least 8 dp separation. Confirm this alongside the safe-area and keyboard state on a physical Android device.

### P1-04 — Multi-terminal tab controls are below Android touch size and collide with a terminal-density workflow

- **Location:** `client/src/components/MultiTerminal.tsx:152-162`, `268-287`.
- **Source evidence:** Each minimized/close tab control is 40 × 40 dp (`tabClose`), and the selectable tab is only 40 dp high (`tabSelect`). A long-press drag surface shares the same short tab row.
- **User impact:** In a multi-terminal session, a user trying to switch, minimize, close, or long-press-drag can miss the intended control or close the wrong session. The dense terminal workflow particularly needs forgiving targets.
- **Recommendation:** Make tab actions at least 48 × 48 dp (or provide hit area without visually inflating the row), maintain 8 dp separation, and device-check tap/long-press conflict in portrait and landscape.

## Source-observable strengths to retain

- **Dashboard and lifecycle:** `buildSessionSurfaces` intentionally excludes remote exited sessions while retaining a tab-backed exited surface marked inactive (`client/src/lib/session-surface.ts:30-56`), with focused coverage. This is a coherent presentation policy, but its real-device comprehension and recovery behavior remain unverified.
- **Pairing and daemon management:** Pairing has QR/paste paths, permission-denied/settings and camera-unavailable/retry states; it displays live pairing stage text and blocks mutation while busy. Connection and new-agent page sheets use safe areas, scroll bodies, and Android `KeyboardAvoidingView` height behavior.
- **Session creation and sheets:** New agent directory browsing has a nested scroll region; pane/model/new-session use `BottomSheetScrollView`. The shared sheet applies top/bottom insets, interactive keyboard behavior, and `adjustResize`.
- **Chat and composer:** Agent Chat now derives a measured Android keyboard inset, applies it to the chat container, scrolls to the end on IME show, exposes full tool input/result through Show more/less, and keeps unknown/internal event types out of visible chat.
- **Terminal:** Raw Terminal and Agent Terminal share a WebView/xterm bridge, explicit copy/paste/resize paths, a 48 dp shortcut keyboard, terminal exit closure, and an explicit reconnect input error instead of silent loss.
- **noVNC security boundary:** Attempt IDs are canonical UUIDs; ticket/token/framebuffer data is kept out of user-visible diagnostics and logs. This must remain true when the Android recovery UI is added.

## Runtime-only acceptance blockers — not failures or passes

The following need Android evidence and must not be inferred from source or component tests:

1. **Rootful environment/storage blocker:** `e2e-lab/ANDROID_E2E_TODO.md:12-77` records missing noninteractive rootful Podman authorization and Android-platform tooling; the ledger records the browser topology did not become ready and Playwright ran zero tests (`plans/android-runtime-ux-remediation.md:341-352`). Therefore the Android Golden Flow was not run.
2. **A01 lifecycle:** Force terminal expiry/crash and reconnect; capture terminal/agent frames, runtime snapshot, dashboard state, and whether the inactive card is understandable and non-actionable enough on device.
3. **A02 terminal:** Execute the specified marker via Android IME and paste, then resize/rotate; capture socket/send decision, PTY output sequence, WebView injection, screenshot, and logcat.
4. **A03 overlays:** Exercise every named modal/sheet on 720×1600 and narrow phones, font scale 1.0/1.5, IME open/closed, and system gestures. Verify final actions remain reachable.
5. **A04/A05/A10 Agent Chat:** Capture a real five-turn same-process session, a thinking/tool/approval timeline, background/foreground and TCP-drop behavior, and a harmless hook/system sentinel proof without retaining secret prompt data.
6. **A06/A07 composer/content:** Measure IME, prompt bar, last-message, long prose/unbroken token/code/tool-output bounds and actual expand behavior at increased font scale.
7. **A08 noVNC:** Capture sanitized attempt ID/timing, WebView status timeline, WSS/RFB proxy phases, first framebuffer byte, Android WebView/logcat, and the displayed recovery action. Do not record tickets, bearer tokens, or framebuffer bytes.
8. **A09 whole-app Android quality:** Measure target bounds, contrast, safe-area behavior, rotation/landscape, high-DPI/font-scale wrapping, and press feedback across Dashboard, Files, Agent, Raw/Multi Terminal, and Desktop.

## Ledger/commit assessment

The remediation ledger accurately distinguishes source/targeted-test coverage from device evidence in its final coverage table. The reviewed commit sequence contains focused repairs for A01, A02, A03, A05–A10 and records that Android Golden Flow is blocked rather than passing. The current source reflects the major source-level repairs described above, but it leaves the four release-level usability defects in this review and all runtime acceptance evidence outstanding.

## Required release gate

1. Resolve P1-01 through P1-04.
2. Unblock rootful Android execution/storage prerequisites.
3. Run the device Golden Flow and the runtime matrix above, including narrow phone, font scale, IME, portrait/landscape where supported, and sanitized noVNC diagnostics.
4. Re-audit the installed APK; do not promote source-only or web-focused tests to Android runtime evidence.

---

## Post-fix source re-review — 2026-10-02

**Audited revision:** `71394079c29b29437c4888c926568195da84c721` (includes the mobile P1 remediation at `4575446` and later A01/A02/A08 remediation through `7139407`). This is a focused source-and-targeted-test re-review only. No Android runtime gate, emulator, or physical device was run.

### Post-fix disposition

**NO-GO for Android release remains.** P1-02 and P1-03 are resolved at the source level. P1-01 and P1-04 are only partially remediated: their headline 48 dp/action-density fixes landed, but their compact-width and gesture-separation acceptance conditions do not hold by construction. A01–A10 retain source-level regression coverage, not Android acceptance evidence.

| Prior finding | Post-fix source result | Evidence |
|---|---|---|
| P1-01 — narrow Agent header | **Still P1 (partial fix)** | Secondary actions moved into a 48 dp minimum overflow menu, but a working/abort-enabled header still has 24 dp horizontal padding; Back 48; switcher about 102 (two 48 dp buttons plus its padding/border); Abort 48; More actions 48; and four 8 dp gaps. Those fixed elements consume about **302 dp before the title/status**. Thus at 320 dp the title/status region has only about 18 dp, too little even for the status dot/text; at 360 dp it has only about 58 dp before any title text. `headerTitleContainer: { flex: 1 }` does not reserve a viable title/status width. The focused test only proves the menu composition, not 320/360 dp working/abort-enabled layout. |
| P1-02 — Desktop/noVNC recovery | **Resolved in source** | Pre-WebView recovery now presents bounded status, Back, and Retry; Retry changes `retryNonce` and the effect mints a fresh UUID/ticket attempt. In-WebView disconnect/security/load failure states render bounded recovery with Retry. The native message handler continues to ignore structured diagnostic payloads, preserving the secret-redaction boundary while surfacing status text. |
| P1-03 — Desktop controls | **Resolved in source** | Back, Retry, and each dock key declare a 48 dp minimum; the dock has a 10 dp gap. |
| P1-04 — MultiTerminal target/gesture space | **Still P1 (partial fix)** | Select/minimize/close controls now declare 48 dp minimums, but minimize and close are immediately adjacent (`tabClose` controls have no gap) and each has `hitSlop={8}`. Their enlarged hit rectangles overlap by 16 dp, so the required 8 dp separation is not present and close/minimize disambiguation remains source-unproven. Also, a 48 + 48 control pair plus the 88 dp select minimum totals 184 dp inside a `maxWidth: 180` tab. |

### Required verification performed

- **Narrow Agent header:** Reviewed `client/app/agent/[id].tsx` fixed-width arithmetic and the focused header-overflow test. The overflow relocation is valid, but the abort-enabled compact header remains non-viable as described above.
- **Desktop recovery/actions and targets:** Reviewed `client/app/desktop.tsx` and focused tests. Source supports sanitized Back/Retry recovery and 48 dp targets with 10 dp dock separation.
- **MultiTerminal target/gesture space:** Reviewed `client/src/components/MultiTerminal.tsx` and its focused test. The minimum target assertion passes, but adjacent enlarged hit areas overlap and the tab width contract is internally inconsistent.
- **A01–A10 regressions:** Reviewed the ledger's focused coverage map and source boundaries including lifecycle surfaces, terminal error/inactivation, allowlisted Agent Chat rendering, IME/sheet policies, noVNC attempt-ID/redaction handling, and WSS-only ticket remediation. No deterministic source regression beyond the two remaining P1 usability findings was found.

### Targeted source verification

Passed at this revision (source/component tests only):

```text
bun --cwd client test --runInBand src/agent-route.test.tsx src/desktop-route.test.tsx src/components/MultiTerminal.test.tsx src/lib/session-surface.test.ts src/terminal-route.test.tsx

5 passed suites, 59 passed tests
```

This result does not establish Android rendering, touch dispatch, long-press drag arbitration, IME, lifecycle, WebView RFB, or device accessibility behavior.

### Remaining release requirements

1. Rework the abort-enabled Agent header so its title/status has a defined usable width at 320/360 dp; move Abort into overflow or use an Android-validated compact pattern. Add focused coverage for working/needs-you/model states without treating it as device-layout proof.
2. Separate MultiTerminal minimize and close hit areas by at least 8 dp without overlapping `hitSlop`, and reconcile the tab's 180 dp maximum with its 184 dp child minimums. Device-check tap vs. long-press behavior in portrait and landscape.
3. Keep the Android Golden Flow blocked/unverified until the documented rootful topology/storage prerequisites are actually satisfied, then run the runtime matrix in the preceding blocker section against the installed APK. Do not treat the focused source suite as a substitute for that evidence.

## Final layout P1 correction — 2026-10-02

**Disposition:** P1-01 and P1-04 are resolved at the source level by `omp(android-runtime-ux-remediation): Resolve final flow-audit layout P1s`. This does not change the Android release disposition: the documented Android Golden Flow/storage and runtime-evidence blockers remain unresolved.

| Finding | Final source correction | Regression evidence |
|---|---|---|
| P1-01 — narrow Agent header | At widths ≤360dp, the header wraps into a primary control row (Back, Chat/Terminal, More actions) plus a full-width title/status row. Abort is no longer inline at compact width; it is an accessible overflow action with model/pane/files/terminate/close. | `agent-route.test.tsx` renders 320dp working/abort-enabled, needsYou, and model-enabled states; it verifies title/status, Back and Chat/Terminal primary controls, hidden inline Abort, and the relevant overflow action. |
| P1-04 — MultiTerminal target/gesture space | Active minimize and close actions have separate 48dp boxes in an 8dp-gap group with no `hitSlop`. The tab maximum is 200dp, sufficient for its 192dp minimum child row. | `MultiTerminal.test.tsx` verifies 48dp action floors, absent `hitSlop`, the 8dp group gap, and the 200dp parent maximum. |

Focused source/component coverage is not Android device evidence. Do not run or report the Android Golden Flow until its existing environment/storage blocker is resolved.

## Post-`1c92e2e` confirmation — 2026-10-02

**Disposition:** All four previously reported source-observable P1 findings are resolved at `1c92e2eef015901661173e06fb519dbecac03ff8`. The compact header moves title/status to its own full-width row and makes Abort an overflow action at 320–360 dp. MultiTerminal gives minimize and close independent 48 dp targets with an 8 dp gap, removes overlapping hit slop, and expands the tab maximum to 200 dp for its 192 dp minimum child row. No further source-observable P1 was found in this focused re-review.

**Release remains NO-GO for Android runtime evidence.** The Android Golden Flow has not run; documented rootful Podman/topology-storage prerequisites remain unresolved for this audit, and source/component coverage cannot prove real Android layout, touch/long-press arbitration, IME, lifecycle, WebView/RFB transport, or accessibility behavior.
