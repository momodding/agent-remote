# Android Golden Flow — Storage-Capacity Reconciliation

**Recorded (UTC):** 2026-10-02T06:05:12Z  
**Scope:** inspection-only reconciliation of the former rootful Podman storage-capacity blocker. No source, Compose, or runtime configuration was changed.

## Disposition

**Classification: `TEST_HARNESS_BUG`**

The storage-capacity conclusion in the former Android Golden Flow diagnosis is superseded. The verified execution topology and the authoritative capacity observations establish that the failed diagnosis attributed an Android-emulator filesystem observation to a rootful Podman graph-root capacity prerequisite without a valid current-context capacity proof. It must not remain classified as an external capacity blocker.

This classification concerns the diagnostic/harness attribution, not the historical emulator error text. The previous flow did record an emulator failure to create userdata; this record only establishes that rootful Podman storage capacity is not the explanation for that failure under the authoritative measurements below.

## Authoritative capacity evidence

The supplied manual observations are authoritative:

| Storage context | Path | Available bytes |
| --- | --- | ---: |
| Rootless Podman graph root | `/home/momodding/.local/share/containers/storage` | 106,917,838,848 |
| Rootful Podman graph root | `/var/lib/containers/storage` | 106,796,941,312 |
| Android prerequisite | n/a | 8,372,800,000 |

The rootful graph root exceeds the Android prerequisite by **98,424,141,312 bytes** (approximately 98.424 GB, decimal), or about **12.76×** the required capacity. The rootless measurement is a separate namespace and is recorded for comparison only; it is not substituted for rootful evidence.

The prior remediation arithmetic is retained for history: the old observation reported 6,882.50 MB available, 7,372.80 MB needed for userdata, and 8,372.80 MB required after the stated 1,000 MB headroom. Those values do not override the current authoritative rootful graph-root measurement.

## Verified current execution context

The live canonical rootful Podman binary reports this effective store configuration:

```text
graphRoot=/var/lib/containers/storage
runRoot=/run/containers/storage
config=/home/linuxbrew/.linuxbrew/etc/containers/storage.conf
driver=overlay
```

`e2e-lab/scripts/compose.sh` is the canonical Compose wrapper. It fails closed unless the configured executable (default `/home/linuxbrew/.linuxbrew/bin/podman`) exists, noninteractive `sudo` works, and rootful `podman compose version` succeeds. Its invocation is:

```bash
sudo -n -- "$E2E_PODMAN_BIN" compose \
  --file "$LAB_DIR/compose.yaml" \
  --project-directory "$LAB_DIR" \
  --project-name agenticremote-e2e \
  "$@"
```

Therefore the Android service is created and inspected through rootful Podman, with its graph root at `/var/lib/containers/storage`.

The repository contains `e2e-lab/.runtime/podman-system-storage.conf`, which instead names project-local runroot and graphroot paths under `.runtime/`. It is not the effective rootful storage configuration above. `e2e-lab/README.md` explicitly describes `.runtime/podman-system-graphroot` and `.runtime/podman-system-runroot` as a legacy, separate rootless fallback and prohibits using rootless Podman commands to troubleshoot the rootful project.

## Android path and service audit

* `e2e-lab/test-all.ts` invokes `runAndroidVerification()` as stage 4/5.
* `e2e-lab/scripts/test-android.sh` executes `bun run android/android-runner.ts` from the lab directory.
* `e2e-lab/android/android-runner.ts` documents that `up.sh` starts provider/daemon and that the runner starts only `android-emulator`; it does not tear down Compose.
* `e2e-lab/compose.yaml` defines `android-emulator` from the pinned `budtmo/docker-android` image, passes `/dev/kvm`, uses the named `android-runtime` and `android-build` volumes, and has an ADB boot health check (`adb wait-for-device` followed by `sys.boot_completed == 1`).

Thus a successful or failed Android boot is an emulator/Compose service outcome, but the canonical storage context for that service is rootful `/var/lib/containers/storage`, not the legacy project-local rootless store.

## Former operator-`df` assumption

The original diagnosis artifact, `android-golden-flow-health-diagnosis-20260930T072658Z.md`, quoted an in-emulator startup message:

```text
FATAL | Not enough space to create userdata partition. Available: 6882.50 MB at /home/androidusr/emulator, need 7372.80 MB.
```

It then treated this as a rootful-storage remediation prerequisite. That inference has been invalidated: the observed path is an emulator-in-container path, while the authoritative host rootful graph-root measurement is substantially above the requirement. There is no current source constant or Compose setting that promotes `8372.80`, `8372800000`, `7372.80`, or `6882.50` into a canonical rootful graph-root admission check. The threshold was remediation arithmetic, not an enforced runtime contract.

A previously issued Compose-based `exec ... df` command is intentionally not treated as evidence here: its tool response is unavailable, and this reconciliation does not rerun it because Compose execution is outside the authorized inspection scope.

## Non-actions and remaining state

No Podman resources were intentionally started, stopped, restarted, removed, pruned, or deleted for this reconciliation. No Golden Flow, Android acceptance, APK build/install/launch, Maestro, screenshot, logcat, or rootless runtime operation was run. No source or Compose configuration was changed.

The existing Android container may remain `starting`; that condition is not reclassified here and was not exercised. Any future Android failure investigation must collect same-invocation emulator and rootful-storage evidence through the canonical wrapper, but it must not report rootful storage capacity as an external blocker unless it proves a contemporaneous shortfall against the actual rootful `GraphRoot`.

## Relationship to prior records

This is append-only. It does not overwrite or erase:

* `android-golden-flow-health-diagnosis-20260930T072658Z.md`
* `android-golden-flow-storage-remediation-20260930T112750Z.md`
* `android-golden-flow-storage-observation-20261002T030538Z.md`

Those records remain historical evidence; this report supersedes only their former rootful-storage-capacity blocker conclusion.

## Automated harness follow-up — 2026-10-02T06:17:56Z

The Android runner now makes this capacity decision automatically before KVM, emulator, or build work. It invokes the canonical rootful Podman executable with `sudo -n --`, reads machine-readable `podman info` for the effective `GraphRoot` and `RunRoot`, measures the selected graph root with byte-granular `df`, and requires `8,372,800,000` bytes.

The resulting report records the effective UID/rootless state, executable, effective storage configuration, graph/run roots, filesystem/mount, available bytes, required bytes, and the decision. It emits `PASS` when `available >= required`, `BLOCKED_INSUFFICIENT_STORAGE` when capacity is below the threshold, and `BLOCKED_STORAGE_CONTEXT` when the canonical rootful context cannot be established. It intentionally does not substitute rootless or legacy project-local storage.

Focused deterministic coverage passed for rootful selection at the exact threshold, rootless rejection, preservation of a reported project-local graph root, and one-byte-insufficient capacity. No Android emulator or Golden Flow was started for this follow-up.

## Measured UID follow-up — 2026-10-02T06:23:24Z

The preflight no longer assumes UID zero from the use of `sudo`. Before interpreting the rootful Podman info result, it runs `sudo -n -- id -u`, parses the measured effective UID, records that value in the storage context, and blocks with `BLOCKED_STORAGE_CONTEXT` if the command fails, produces an invalid UID, or produces a nonzero UID. The focused deterministic harness check includes a nonzero measured-UID rejection. No Android emulator or Golden Flow was started.

## Rootful GraphRoot capacity follow-up — 2026-10-02T06:26:01Z

The capacity probe now runs `/usr/bin/df -B1 --output=source,target,avail <GraphRoot>` through the same rootful `sudo -n --` executor as the Podman info and UID queries. This preserves the exact machine-reported graph root while avoiding an invoking-user traversal failure on rootful-only storage. Deterministic coverage injects a rootful executor for a root-only reported graph root and verifies that `/usr/bin/df` is dispatched through it. Existing parse and capacity threshold behavior is unchanged. No Android emulator or Golden Flow was started.

## Canonical preflight execution — 2026-10-02T06:31:23Z

The minimal `checkAndroidStorage()` invocation did not start Compose or Android. It returned `BLOCKED_STORAGE_CONTEXT`: `sudo -n -- id -u` was rejected with `sudo: a password is required`. The harness correctly failed closed before rootful `df`; it therefore cannot truthfully report a PASS or complete measured storage context in this run. This is an authorization/context blocker only. It does not change the reconciled capacity evidence that rootful storage had `106,796,941,312` available bytes versus `8,372,800,000` required. The complete structured result and APK/image/HEAD provenance are in `android-storage-preflight-20261002T063123Z.json`.
