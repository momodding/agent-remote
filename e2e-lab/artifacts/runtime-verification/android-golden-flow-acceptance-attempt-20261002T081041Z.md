# Android Golden Flow Acceptance Attempt — 2026-10-02T08:10:41Z

## Command

```
./scripts/test-android.sh
```

Executed exactly once from a clean worktree (`git status --porcelain` empty) at HEAD `aab2797` (after Iteration 32's two authorized fixes: `compose.yaml` `group_add: ["994"]` and the `android-runner.ts` KVM guard fix, both already committed before this run).

## Result

`BLOCKED`, `BLOCKED_STORAGE_CONTEXT: Podman info failed: 1`, wall time 10.27s, exit 1.

Full stdout/stderr: `e2e-lab/artifacts/runtime-verification/android-golden-flow-run-20261002T081041Z.log`.
Runner-written artifact: `e2e-lab/artifacts/android-verification.json`:

```json
{
  "status": "BLOCKED",
  "details": "BLOCKED_STORAGE_CONTEXT: Podman info failed: 1",
  "blockers": ["BLOCKED_STORAGE_CONTEXT: Podman info failed: 1"],
  "remediationSteps": ["Repair the canonical rootful Podman context exposed by compose.sh, then rerun the Android harness."],
  "storagePreflight": { "status": "BLOCKED_STORAGE_CONTEXT", "error": "Podman info failed: 1" }
}
```

## This is NOT a storage-capacity problem

Independently re-verified immediately after the run, by calling `checkAndroidStorage()` directly three times in a row: every call returned `PASS` with `availableBytes` around `118,560,500,000` (~118.5 GB) against the `8,372,800,000` requirement. Rootful GraphRoot capacity is abundant and unrelated to this failure.

## True root cause: `spawnSync` ETIMEDOUT on the hardcoded 5000ms Podman-call timeout, surfaced as a generic status code

`checkAndroidStorage()`'s executor (`rootfulCommand` in `android-runner.ts`) runs `sudo -n -- podman info --format '{{json .}}'` via Bun's `spawnSync` with a hardcoded `timeout: 5_000`. Reproduced the exact failure directly:

```
status: 1
signal: null
stderr: "" (empty)
error: SystemError: spawnSync sudo ETIMEDOUT { code: 'ETIMEDOUT', errno: -110 }
```

Bun's `spawnSync` reports a timeout kill as `status: 1` with empty `stdout`/`stderr`, and the real signal is only visible on the `.error` property — which `checkAndroidStorage()`'s error-message construction (`` `Podman info failed: ${infoProc.stderr || infoProc.stdout || infoProc.status}` ``) does not read. So a 5-second subprocess timeout and a genuine Podman exit-code-1 failure both print as `Podman info failed: 1`, indistinguishable in the artifact. That ambiguity is itself a (pre-existing, not introduced this iteration) diagnostic-quality defect in the harness, separate from the two defects fixed in Iteration 32.

The underlying call is marginal on this host even with no contention: five isolated timed runs of the identical `sudo -n -- podman info --format '{{json .}}'` command averaged ~4.0–4.3s (max observed 4.76s) with nothing else competing for CPU. Under the actual load present during this run (`uptime` load average `13.98` on an 8-core host — see next section), the same call did not finish inside 5000ms and was killed.

## Contributing factor: stale container from the Iteration-31 (pre-fix) run never cleaned up, consuming ~60% CPU

`podman ps -a` at the time of this run showed `agenticremote-e2e-android-emulator-1` still `Up About an hour (starting)` — the container launched by the *previous* (pre-fix) Golden Flow attempt documented in Iteration 31. `podman stats --no-stream` showed it consuming `59.50%` CPU continuously. Its logs show `supervisord` respawning `log_web_shared` in a tight ~1–3 second crash/restart loop, consistent with the emulator process never reaching a stable state because its original KVM-access failure (the Iteration-31 defect) left it retrying indefinitely. This container predates the Iteration-32 fixes (it was never restarted with the new `compose.yaml`/`android-runner.ts`) and was not stopped, pruned, or restarted as part of this investigation, per the standing constraint against mutating Podman resources.

Per the project's no-prune/no-stop/no-restart constraint, this leftover container was left running untouched; its CPU draw is the most direct explanation for why a normally-4-second command exceeded a 5-second budget on an otherwise idle-looking 8-core host.

## What this run does and does not prove about the two Iteration-32 fixes

The flow never progressed past the storage-preflight stage (stage 2 of the runner), so neither the `compose.yaml` `group_add` fix nor the `android-runner.ts` KVM-guard fix was exercised end-to-end by this particular run. Both fixes are independently verified correct and in place (see Iteration 32 ledger entry and commits `97ec8e3`, `5cbe91b`, including the `evaluateKvmPreflight` regression test and the `podman compose ... config` echo of `group_add`), and both were already committed before this run was executed; this run's result does not contradict or invalidate them.

## Explicitly not reclassified

This result is reported as `BLOCKED_STORAGE_CONTEXT` in the artifact text because that is the literal status the (already-correct) storage preflight code produces for *any* non-zero-exit or timed-out `podman info` call, not because actual storage capacity is insufficient. Actual available capacity was independently confirmed abundant (~118.5 GB) immediately before and after this run. No storage code was touched or needs to be touched for this cycle's authorized scope.

No container, volume, or network was pruned, stopped, restarted, or deleted during this investigation. No source file was modified as part of producing this evidence document.
