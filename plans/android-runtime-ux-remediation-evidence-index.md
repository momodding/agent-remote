# Android Runtime UX Remediation — Evidence Index

## Validated revision range

- **Pre-archive remediation HEAD:** `1c92e2eef015901661173e06fb519dbecac03ff8` — `omp(android-runtime-ux-remediation): Resolve final flow-audit layout P1s`.
- **Recorded baseline:** `2248bda36e5e9d60821363f110c35da55437868f` in the remediation ledger.
- **Range represented by this archive:** `2248bda..1c92e2e`.

## APK provenance

The remediation ledger records two APK artifacts, neither built from the final remediation commit:

| Artifact | Recorded provenance | Final-HEAD match |
|---|---|---|
| `builds/client-android.apk` | 52,115,902 bytes; SHA-256 `30bad937e02ed694fe7ec4f9ad00abe385fbc676d6ab338ffe0f446c0c4d1623`; built 2026-09-23 for `arm64-v8a`. | **NO** — predates `2248bda`. |
| `builds/android-build-retry.apk` | 78,943,691 bytes; SHA-256 `278d81a0926d31b7e91c70e62c05c4e0235be7ff27bfb3a7f1ec0ab42abeba6c`; built 2026-09-30 for `arm64-v8a`, `x86_64`. | **SOURCE_EQUIVALENT** to the changes in `2248bda`, not a final-HEAD APK. |

Source: `plans/android-runtime-ux-remediation.md`, “APK Artifacts & Provenance Analysis” and “HEAD Match Verification.”

## Final-head mandatory gate rerun

These commands were rerun on 2026-10-02 at `252688d` (`omp(android-runtime-ux-remediation): Archive final acceptance evidence`). The only concurrent working-tree change was the documentation-only, unstaged Oracle review artifact; no product source was modified.

| Command | Exact observed outcome |
|---|---|
| `make backend-test` | **PASS** — exit 0 in 8.33s. `cd backend && go test ./...` passed for all tested packages; `internal/notify` reported `[no test files]`. |
| `bun --cwd client test --runInBand` | **PASS** — exit 0 in 60.92s. Jest: 27/27 suites passed, 214/214 tests passed, 0 snapshots; reported test time 54.318s. Expected-error console output from pairing/API tests was emitted without test failures. |
| `make client-build-web` | **PASS** — exit 0 in 41.11s. `expo export --platform web` bundled 1,486 modules and exported `client/dist`. |
| `make lint` | **PASS** — exit 0 in 42.07s. `go vet ./...` completed, then the client `tsc --noEmit` typecheck completed with no diagnostics. |

Earlier ledger results remain historical evidence only; this table is the final-head rerun record.

## Current source dispositions

- **Oracle review:** `plans/oracle-review-a01-a10.md` reports **PASS** for A01–A10 only as source/committed-test-contract evidence. Its runtime/device disposition remains **UNRESOLVED**.
- **Flow audit:** `plans/android-flow-auditor-review-20261001.md` records all four source-observable P1 findings as resolved at `1c92e2e`; no source-observable P1 remains in that focused re-review.
- **Android release:** **NO-GO** pending runtime evidence. The source dispositions above do not establish Android device behavior.

## Blocked runtime gates

- **Browser E2E:** At `2026-10-02T03:09:59Z`, `./e2e-lab/scripts/test-web.sh` returned runner exit 0 but reported **BLOCKED_ENVIRONMENT**: `Could not start the E2E topology.` It executed **0 Playwright tests** (0 passed, 0 failed), so this is **NOT PASS**. Evidence: `e2e-lab/artifacts/runtime-verification/web-acceptance-20261002T030959Z.{stdout.log,stderr.log,exit,diagnostic.log}`. Stderr was empty; provider and daemon remained Up after the run. The retained `EADDRINUSE` web-server log predates this run and is non-causal. Do not rerun the web gate until the runner's suppressed `up.sh` failure is diagnosable.
- **Android Golden Flow:** **not rerun against the final remediation commit**. The retained historical 2026-09-30 rootful-capacity failure remains evidence only, not a final-run result. See `plans/android-runtime-ux-remediation.md`, “Golden Flow status,” and `e2e-lab/ANDROID_E2E_TODO.md`.
- **Prerequisite:** the retained Android E2E log requires passwordless rootful Podman authorization for `/home/linuxbrew/.linuxbrew/bin/podman`; its earlier entry also records missing ADB. The exact required rerun sequence and failure evidence are retained in `e2e-lab/ANDROID_E2E_TODO.md` (iterations 23–25).
