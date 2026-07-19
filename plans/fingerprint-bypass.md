<!-- source-branch: main -->
## Context

Client connections can fail with `Bad state: client certificate mismatch` when the daemon TLS certificate fingerprint differs from the QR-provided `fingerprint` value. The user wants a client-side config flag that bypasses fingerprint verification so the client can connect without security validation. The existing codebase already has a UI checkbox `allowBadCertificates` ("Skip TLS certificate verification") and the parameter threads through `_SessionDashboardState` → `AppState` → `AgenticRemoteApi` → transport helpers, but `AgenticRemoteApi.connectFromPayload` ignores the value (no-op statement on line 49). Rename this existing flag to `skipFingerprintVerification` for clarity and make it actually skip the `Validating Certificate Fingerprint...` diagnostic step in the connect flow.

## Approach

### 1. Rename `allowBadCertificates` → `skipFingerprintVerification` everywhere (independent of step 2)

This is a mechanical rename across the five files that reference the parameter. No behavior change, just naming.

- **`client/lib/src/features/dashboard/session_dashboard.dart`** — `_SessionDashboardState.allowBadCertificates` field (line 26) → `skipFingerprintVerification`. `_PairingPanel` constructor param, field, and the `ShadCheckbox` binding (lines 143-144, 154, 50-51, 60, 182-183). Change `onAllowBadCertificatesChanged` → `onSkipFingerprintChanged` (lines 147, 158, 50). Update checkbox label from `'Skip TLS certificate verification'` → `'Skip fingerprint verification'` (line 184). Keep sublabel `'Internal Tailscale/VPN only'`.
- **`client/lib/src/state/app_state.dart`** — `connectFromPayload` named param `allowBadCertificates` (line 22) → `skipFingerprintVerification`. Same on the forwarding call (line 29).
- **`client/lib/src/services/agentic_remote_api.dart`** — `connectFromPayload` named param `allowBadCertificates` (line 46) → `skipFingerprintVerification`.
- **`client/lib/src/services/agentic_remote_transport_io.dart`** — `createHttpClient` and `connectWebSocket` named param `allowBadCertificates` (lines 35, 47) → `skipFingerprintVerification`. Update the no-op reference statements (lines 39, 51).
- **`client/lib/src/services/agentic_remote_transport_web.dart`** — same two functions, param `allowBadCertificates` (lines 13, 20) → `skipFingerprintVerification`.

No callers outside these files — confirmed by grep.

### 2. Wire `skipFingerprintVerification` into the connect flow to actually bypass fingerprint validation

In `client/lib/src/services/agentic_remote_api.dart`, `connectFromPayload`:

- Stop ignoring the `skipFingerprintVerification` parameter.
- When `skipFingerprintVerification` is `true`: skip the `Validating Certificate Fingerprint...` diagnostic line, pass `trustedFingerprint: null` to `createHttpClient` and `connectWebSocket` (already the current behavior), and add a diagnostic `'Fingerprint verification skipped'` so the user knows it was bypassed.
- When `skipFingerprintVerification` is `false`: emit `'Validating Certificate Fingerprint...'` diagnostic (already in `orderedDefaults`), pass `trustedFingerprint: pairing!.fingerprint` to `createHttpClient` and `connectWebSocket`, and pass `formatFingerprint: _formatFingerprint` (needs a static helper or inline closure that matches the backend's `Fingerprint()` format: `SHA256(der)` upper-hex colon-separated).

Current code (lines 58-61):
```dart
client = createHttpClient(
  trustedFingerprint: null,
  formatFingerprint: (_) => '',
  allowBadCertificates: true,
);
```

Replace with:
```dart
if (!skipFingerprintVerification) {
  diagnostics.add('Validating Certificate Fingerprint...');
}
// ponytail: fingerprint actually checked when transport implements pinning; bypass flag skips the step
client = createHttpClient(
  trustedFingerprint: skipFingerprintVerification ? null : pairing!.fingerprint,
  formatFingerprint: (_) => '',
  skipFingerprintVerification: skipFingerprintVerification,
);
```

Same pattern for `_authenticate` WebSocket call (lines 74-79):
```dart
_channel = connectWebSocket(
  endpoint,
  trustedFingerprint: skipFingerprintVerification ? null : pairing!.fingerprint,
  formatFingerprint: (_) => '',
  skipFingerprintVerification: skipFingerprintVerification,
);
```

This means `AgenticRemoteApi` needs a field `bool _skipFingerprintVerification = false;` set at the top of `connectFromPayload` from the parameter, so `_authenticate` can read it. Alternatively, pass it through to `_authenticate` as a parameter. The lazier option: store it as a field.

Add `bool _skipFingerprintVerification = false;` field to `AgenticRemoteApi` (after `bearerToken` on line 40). Set it at top of `connectFromPayload`: `_skipFingerprintVerification = skipFingerprintVerification;`. Use it in both `createHttpClient` and `connectWebSocket` calls.

### 3. Add a diagnostic message for bypass (part of step 2)

When `skipFingerprintVerification` is true, after the TLS handshake diagnostic, add:
```dart
diagnostics.add('Fingerprint verification skipped');
```

This replaces the `Validating Certificate Fingerprint...` step in the diagnostics overlay. No change to `ConnectionDiagnosticsOverlay.orderedDefaults` — that static list is display-only and the overlay already renders whatever lines are in the `lines` list.

## Critical files & anchors

- `client/lib/src/services/agentic_remote_api.dart` — `connectFromPayload` (line 42) and `_authenticate` (line 67): where fingerprint bypass logic goes.
- `client/lib/src/features/dashboard/session_dashboard.dart` — `_PairingPanel` (line 138): checkbox label and field rename.

## Verification

1. `make client-test` — all existing tests pass (rename is mechanical; no test references `allowBadCertificates` directly).
2. `make client-build-web` — web build succeeds (confirms no compile errors from rename).
3. Manual: connect with checkbox checked → diagnostics show `'Fingerprint verification skipped'` instead of `'Validating Certificate Fingerprint...'`, connection succeeds. Connect with checkbox unchecked → diagnostics show `'Validating Certificate Fingerprint...'`, `trustedFingerprint` is set to the QR payload fingerprint value.

## Assumptions & contingencies

- The actual enforcement of `trustedFingerprint` in the IO transport is still bypassed (`_insecureHttpClient` accepts all certs). This plan wires the flag correctly so when transport pinning is re-enabled, the bypass flag will work. If the user wants transport-level pinning enforcement too, that's a separate change.
- `formatFingerprint` stays as `(_) => ''` since the transport currently ignores it. When real pinning is implemented, it should use the backend's `SHA256` colon-format; that's out of scope here.
