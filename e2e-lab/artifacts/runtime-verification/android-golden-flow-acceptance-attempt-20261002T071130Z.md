# Android Golden Flow acceptance attempt — 2026-10-02T07:11:30Z

## Scope

This records one, single, non-repeated execution of the canonical command `e2e-lab/scripts/test-android.sh`, invoked exactly once from a clean prepared state after the rootful Podman storage preflight was independently confirmed `PASS`. No source, Compose configuration, or running service was modified, stopped, restarted, or removed as part of producing this record. This record exists to report the true outcome and true failing stage — it does not reclassify the failure as a storage issue.

## Provenance (captured immediately before the run)

- Git HEAD: `784997d904a028c6b4ddefcabd1cc298bdb5991a`
- Git status: clean (`git status --short` empty)
- APK provenance on disk (prior build, B04 variant): `e2e-lab/artifacts/android-b04-x86-app-debug.apk`, SHA-256 `737c630ee279f6445b111e58984e05085a1f354444da5710d0041f2da780b8d0`
- Pinned Android image: `budtmo/docker-android:emulator_14.0_v3.7.0-p0@sha256:7826cd345543736c9502293926f383af4ca9caf96bd47d12d15bce8d31fd9894` (confirmed present in Compose config; `podman image inspect --format '{{.Digest}}'` on this reference echoes the same digest)
- Rootful Podman storage context used for this run, as printed by the run itself: `availableBytes=120553009152`, `requiredBytes=8372800000`, `graphRoot=/var/lib/containers/storage` — **storage preflight PASSED** (line 3 of the run log below).

## Command executed (exactly once)

```
cd e2e-lab && ./scripts/test-android.sh
```

Run log (full, unedited): `e2e-lab/artifacts/runtime-verification/android-golden-flow-run-20261002T071130Z.log`
Artifact written by the runner itself: `e2e-lab/artifacts/android-verification.json`

Wall time: 395.64 seconds. Exit code: `1`.

## Result: FAILED

```
Status: FAILED
Details: Compose health check timeout
Blockers:
  - Compose health check timeout
Wall time: 394.85 seconds
```

**This is not a storage condition.** The storage preflight (stage 1 of `runAndroidVerification()`) passed explicitly and printed `Storage PASS: 120553009152 available bytes ... 8372800000 required` before any later stage ran. The failure occurred at **stage 7, "Polling Compose health"** — specifically the `android-emulator` Compose service never reached `health: healthy` within its configured budget (2-minute start period + 30 retries at 10s interval, polled by the runner for up to 360 seconds). All 63 recorded polls during this run reported `running, health: starting`.

### Stages reached (in order, per the run log)

1. Checking Compose prerequisites — passed
2. Checking rootful Podman storage — **PASS** (120,553,009,152 bytes available vs 8,372,800,000 required)
3. Checking KVM access (host-side, see bug note below) — did not block (see "Harness defect" below)
4. Preparing temporary source / Expo prebuild on host — passed
5. Staging source for Compose — passed
6. Starting `android-emulator` service — container started (`e0a6741b4899`)
7. **Polling Compose health — FAILED (timeout after 394.85s)**

### Stages never reached (blocked by the stage-7 failure)

Current APK build, APK install, app launch, real daemon pairing, interactive terminal, OMP AgentSession creation, chat turns, Plan Mode/Vibe Mode exercise, keyboard/composer checks, long-content rendering, modal/sheet checks, Files, noVNC framebuffer capture, and termination/reconciliation. None of these stages executed; no evidence for them exists because the runner's own control flow (`android-runner.ts` lines 696–780) returns immediately on health-check failure and never calls `buildAPKInContainer()`, `installAPKOnDevice()`, or `runMaestroFlows()`.

## Root cause (established via direct container inspection, performed read-only after the run — no container was started, stopped, or modified to obtain this evidence)

The `android-emulator` container (`agenticremote-e2e-android-emulator-1`, `e0a6741b4899`) is running and its supervisor processes (Xvfb, noVNC, x11vnc, socat, websockify, ADB server) are all healthy. The actual emulator boot failed during AVD startup with:

```
Traceback (most recent call last):
  File "/home/androidusr/docker-android/cli/src/device/emulator.py", line 170, in change_permission
    os.close(os.open(kvm_path, os.O_RDWR))
PermissionError: [Errno 13] Permission denied: '/dev/kvm'
...
RuntimeError: /dev/kvm not accessible: [Errno 13] Permission denied: '/dev/kvm'
```

(captured from `/home/androidusr/logs/device.stdout.log` inside the running container)

Inside the container, `/dev/kvm` is `crw-rw---- root:994` (group `kvm`, gid 994 — confirmed to match the host's `kvm` group gid). The container's application user is `androidusr` (uid 1300, gid 1301, member only of group `androidusr`/1301 and `sudo`/27) — **`androidusr` is not a member of gid 994 inside the container**, so the device-permission check the project's own patch (`e2e-lab/android/patches/emulator-kvm-fix.py`, `change_permission()`) performs fails with `EACCES`, the emulator CLI raises and aborts before QEMU ever starts, no AVD process exists, `adb devices` reports no device, and the Compose healthcheck (`adb wait-for-device && getprop sys.boot_completed`) blocks until the runner's own poll budget expires. This is a genuine, reproducible KVM-group-membership gap in the `android-emulator` service definition — `e2e-lab/compose.yaml` passes the `/dev/kvm` device but does not grant the container's `androidusr` user supplementary access to its owning group (no `group_add: ["994"]` or equivalent on the service).

Independently, the **host** user (`momodding`, uid 1000) is also not a member of the host `kvm` group (`groups` output: `momodding adm cdrom sudo dip video plugdev lxd render` — no `kvm`), so a direct host-side `fs.accessSync('/dev/kvm', R_OK|W_OK)` from this shell also fails (`EACCES`), confirmed directly via `node -e` and `python3 -c` probes.

### Harness defect found (pre-existing, not introduced this session)

`e2e-lab/android/android-runner.ts` line 636 reads:

```ts
const kvmCheck = checkKVMAccess();
if (!kvmCheck) { ... blocks with KVM_UNAVAILABLE ... }
```

`checkKVMAccess()` (in `e2e-lab/android/env.ts`) always returns a non-null object, `{ ok: boolean; error?: string }` — never `null`/`undefined`/`false`. `!kvmCheck` on a non-null object is always `false` in JavaScript, so **this guard can never trigger, regardless of whether KVM is actually accessible**. Verified directly:

```
result: {"ok":false,"error":"/dev/kvm not accessible. ..."}
!result (used in runner if-check): false
```

The correct guard is `if (!kvmCheck.ok)`. Because of this defect, the runner silently proceeded past a host-side KVM check that had already correctly detected the problem, instead of blocking early with an actionable `KVM_UNAVAILABLE` report — it only failed much later (394 seconds later) with the generic `Compose health check timeout`, which is harder to diagnose. This defect did not change today's ultimate outcome (the run would still have failed at the container's internal `/dev/kvm` check even had the host-side guard worked, since the **container's** group membership is the actual blocker, not solely the host's), but it did suppress an earlier, clearer failure signal.

## Other findings recorded for completeness (not blockers for this run, but relevant to future acceptance attempts once KVM access is fixed)

- **Plan Mode / Vibe Mode**: confirmed absent by design in the current client implementation (`client/app/agent/[id].tsx`, `client/src/protocol.ts`) — no `viewMode` state, capability, or event contract for either exists anywhere in `client/`. This matches the explicit decision already recorded in `plans/android-runtime-ux-remediation.md`. Any future acceptance report must not fabricate checks for these; only `viewMode: 'chat' | 'terminal'` and model/thinking switching are real, testable surfaces.
- **`runMaestroFlows()` only invokes `pairing-flow.yaml`**: `e2e-lab/maestro/flows/terminal-session.yaml` and `e2e-lab/maestro/flows/agent-chat.yaml` exist on disk but are not referenced anywhere in `android-runner.ts`'s single `maestro test <flowPath>` call (`e2e-lab/android/android-runner.ts` lines 537–566) or in `runAndroidVerification()`. A future PASSing run through the unmodified runner would exercise pairing only, not the interactive-terminal or ≥5-turn-chat acceptance criteria — those would require either extending `runMaestroFlows()` to invoke all three flows or running them separately via `maestro test`.
- **`PAIRING_PAYLOAD_CHUNK_1`/`PAIRING_PAYLOAD_CHUNK_2`** (consumed by `pairing-flow.yaml`) are not set anywhere in `getAndroidEnvironment()`, `android-runner.ts`, or any Android-specific script; they are unset in this shell and in the `E2E_ENV` object the runner passes to `maestro test`. The only chunked-payload generator found in the repository (`e2e-lab/playwright/pairing-payload.ts`, `getRealPairingPayload()`) is wired into the Playwright/web E2E suite, not the Android path. Had the emulator booted, the pairing Maestro flow would very likely have failed at the `inputText '${PAIRING_PAYLOAD_CHUNK_1}'` step because Maestro would substitute an empty string for the undefined variable.

## Non-actions

No container, volume, or network was pruned, stopped, restarted, or deleted to produce this record. No Compose or source file was modified before or during the run. The post-run container inspection (`podman exec`, `podman logs`, `podman inspect`, `podman image inspect`) was entirely read-only.

## Conclusion

**FAILED at stage 7 ("Polling Compose health"), root-caused to `/dev/kvm` group-permission denial for the `androidusr` user inside the `android-emulator` container** (compose service lacks a `group_add` for the container's `kvm` gid 994), not to insufficient storage. The rootful Podman storage preflight implemented and committed this session (`784997d904a028c6b4ddefcabd1cc298bdb5991a`) functioned correctly and is not implicated in this failure.
