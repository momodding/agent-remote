/**
 * Android E2E Runner: Rootful Compose Orchestration
 * All container ops via compose.sh; host-side ADB/Maestro.
 * Source staging: ROOT/client → .runtime/android/source (RO bind @ /workspace/source)
 * Build output: android-build named volume (mounted @ /workspace/build)
 *
 * Architecture: Provider/daemon started by up.sh; Android runner starts only android-emulator.
 * Teardown is owned by test-all.sh EXIT trap; runner does NOT call compose down.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { getAndroidEnvironment, resolveAndroidAdbExecutable } from './env';

const LAB_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(__dirname, '../..');
const ARTIFACTS_DIR = path.join(LAB_DIR, 'artifacts');
const COMPOSE_SCRIPT = path.join(LAB_DIR, 'scripts/compose.sh');
const LOCAL_EXPO = path.join(ROOT, 'client', 'node_modules', '.bin', 'expo');


const E2E_ENV = getAndroidEnvironment();

export interface AndroidRunnerReport {
  status: 'PASSED' | 'FAILED' | 'BLOCKED';
  details: string;
  blockers: string[];
  remediationSteps: string[];
  deviceStatus?: {
    serial?: string;
    state?: string;
  };
  storagePreflight?: AndroidStoragePreflight;
}

const ANDROID_REQUIRED_STORAGE_BYTES = 8_372_800_000;
const DEFAULT_E2E_PODMAN_BIN = '/home/linuxbrew/.linuxbrew/bin/podman';
// Podman info can take several seconds while storage locks settle; this preflight
// needs headroom without changing Compose or emulator operation timeouts.
export const PODMAN_INFO_PREFLIGHT_TIMEOUT_MS = 30_000;


export interface AndroidStorageContext {
  executable: string;
  rootless: boolean;
  containersStorageConf?: string;
  graphRoot: string;
  runRoot: string;
  availableBytes: number;
  requiredBytes: number;
}

export type AndroidStoragePreflight =
  | { status: 'PASS'; context: AndroidStorageContext }
  | { status: 'BLOCKED_INSUFFICIENT_STORAGE'; context: AndroidStorageContext }
  | { status: 'BLOCKED_STORAGE_CONTEXT'; error: string };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function field(value: Record<string, unknown>, name: string): unknown {
  return value[name] ?? value[`${name[0].toUpperCase()}${name.slice(1)}`];
}

/**
 * Derive rootful identity and GraphRoot capacity from a single `podman info` call.
 *
 * This replaces a separate `sudo -n -- id -u` / `sudo -n -- df` measurement: the sudoers
 * policy only grants NOPASSWD to the Podman binary itself (see compose.sh), so any command
 * besides Podman fails closed with "a password is required" even though the rootful context
 * is otherwise healthy. `podman info` already reports everything the preflight needs:
 *   - `host.security.rootless`: Podman's own internal rootless/rootful determination, which
 *     Podman computes from the invoking process's effective UID. `rootless === false` is
 *     therefore proof the authorized `sudo -n -- podman` invocation executed as root — the
 *     same guarantee a separate `id -u` measurement would have given, without requiring a
 *     second authorized command.
 *   - `store.graphRootAllocated` / `store.graphRootUsed`: Podman's own statfs of the GraphRoot
 *     directory (bytes). It is available here because Podman runs with root privileges, even
 *     though an unprivileged `df` cannot stat the same 0700 root-owned directory. Available
 *     capacity is `graphRootAllocated - graphRootUsed`, matching `df`'s size/used accounting.
 */
export function selectAndroidStorageContext(info: unknown, executable: string): AndroidStorageContext {
  const root = record(info);
  const store = record(field(root, 'store'));
  const host = record(field(root, 'host'));
  const security = record(field(host, 'security'));
  const graphRoot = field(store, 'graphRoot');
  const runRoot = field(store, 'runRoot');
  if (typeof graphRoot !== 'string' || typeof runRoot !== 'string') {
    throw new Error('Podman info did not report GraphRoot and RunRoot');
  }
  const allocated = field(store, 'graphRootAllocated');
  const used = field(store, 'graphRootUsed');
  if (typeof allocated !== 'number' || typeof used !== 'number') {
    throw new Error('Podman info did not report GraphRoot capacity (graphRootAllocated/graphRootUsed)');
  }
  const containersStorageConf = field(store, 'configFile');
  return {
    executable,
    rootless: field(security, 'rootless') === true,
    containersStorageConf: typeof containersStorageConf === 'string' ? containersStorageConf : undefined,
    graphRoot,
    runRoot,
    availableBytes: allocated - used,
    requiredBytes: ANDROID_REQUIRED_STORAGE_BYTES,
  };
}

export function evaluateAndroidStorage(context: AndroidStorageContext): AndroidStoragePreflight {
  if (context.rootless) {
    return {
      status: 'BLOCKED_STORAGE_CONTEXT',
      error: `Expected rootful Podman through compose.sh; Podman reported rootless=${context.rootless}.`,
    };
  }
  return context.availableBytes >= context.requiredBytes
    ? { status: 'PASS', context }
    : { status: 'BLOCKED_INSUFFICIENT_STORAGE', context };
}

export interface AndroidStorageCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: { code?: string; message: string };
}

export type AndroidStorageCommandExecutor = (
  command: string,
  args: string[],
  timeoutMs: number,
) => AndroidStorageCommandResult;

function rootfulCommand(command: string, args: string[], timeoutMs: number): AndroidStorageCommandResult {
  return spawnSync('sudo', ['-n', '--', command, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: timeoutMs,
  });
}

function podmanInfoFailure(result: AndroidStorageCommandResult): string {
  const detail = result.error
    ? `${result.error.code || 'ERROR'}: ${result.error.message}`
    : result.stderr || result.stdout || String(result.status);
  return `Podman info failed: ${detail}`;
}

/**
 * Query the same rootful Podman binary and sudo context as compose.sh before Compose starts
 * Android. Uses only the Podman invocation the sudoers policy authorizes (NOPASSWD is scoped
 * to the Podman binary, not to `id` or `df`); see selectAndroidStorageContext for what the
 * derived fields prove.
 */
export function checkAndroidStorage(
  executor: AndroidStorageCommandExecutor = rootfulCommand,
  executable = process.env.E2E_PODMAN_BIN || DEFAULT_E2E_PODMAN_BIN,
): AndroidStoragePreflight {
  try {
    const infoProc = executor(executable, ['info', '--format', '{{json .}}'], PODMAN_INFO_PREFLIGHT_TIMEOUT_MS);
    if (infoProc.status !== 0) {
      return { status: 'BLOCKED_STORAGE_CONTEXT', error: podmanInfoFailure(infoProc) };
    }
    const info = JSON.parse(infoProc.stdout);
    const context = selectAndroidStorageContext(info, executable);
    return evaluateAndroidStorage(context);
  } catch (err: unknown) {
    return { status: 'BLOCKED_STORAGE_CONTEXT', error: err instanceof Error ? err.message : String(err) };
  }
}

export const ROOTFUL_KVM_SMOKE_TIMEOUT_MS = 30_000;
const KVM_PERMISSION_EXIT = 42;
const KVM_SMOKE_SCRIPT = `test "$(id -un)" = androidusr || exit 41
test -c /dev/kvm || exit 40
test -r /dev/kvm && test -w /dev/kvm || exit ${KVM_PERMISSION_EXIT}
python3 -c 'import os; fd = os.open("/dev/kvm", os.O_RDWR); os.close(fd)' || exit ${KVM_PERMISSION_EXIT}`;

export type RootfulKvmPreflight =
  | { status: 'PASS'; gid: number }
  | { status: 'KVM_DEVICE_MISSING'; error: string }
  | { status: 'ROOTFUL_PODMAN_AUTH_UNAVAILABLE'; error: string }
  | { status: 'ROOTFUL_KVM_MAPPING_FAILED'; error: string }
  | { status: 'ROOTFUL_KVM_PERMISSION_FAILED'; error: string };

interface KvmDeviceStat {
  gid: number;
  isCharacterDevice(): boolean;
}

interface RootfulKvmPreflightDependencies {
  stat(device: string): KvmDeviceStat;
  rootfulPodman(command: string, args: string[], timeoutMs: number): AndroidStorageCommandResult;
  composeProbe(args: string[], timeoutMs: number): AndroidStorageCommandResult;
}

function commandFailure(result: AndroidStorageCommandResult): string {
  return [result.error?.message, result.stderr, result.stdout, result.status === null ? 'no exit status' : `exit ${result.status}`]
    .filter(Boolean)
    .join('\n');
}

/**
 * The smoke probe uses `compose run` so its device and dynamic group_add
 * configuration are exactly the android-emulator service configuration.
 */
export function rootfulAndroidComposeProbeArgs(): string[] {
  return ['run', '--rm', '--no-deps', '--entrypoint', 'bash', 'android-emulator', '-lc', KVM_SMOKE_SCRIPT];
}

export function checkRootfulKvmMapping(
  dependencies: RootfulKvmPreflightDependencies = {
    stat: (device) => fs.statSync(device),
    rootfulPodman: rootfulCommand,
    composeProbe: (args, timeoutMs) => spawnSync(COMPOSE_SCRIPT, args, {
      encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs,
    }),
  },
  device = '/dev/kvm',
  executable = process.env.E2E_PODMAN_BIN || DEFAULT_E2E_PODMAN_BIN,
): RootfulKvmPreflight {
  let stat: KvmDeviceStat;
  try {
    stat = dependencies.stat(device);
  } catch (err: unknown) {
    return { status: 'KVM_DEVICE_MISSING', error: `${device} is unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!stat.isCharacterDevice()) {
    return { status: 'KVM_DEVICE_MISSING', error: `${device} is not a character device` };
  }
  if (!Number.isInteger(stat.gid) || stat.gid < 0) {
    return { status: 'ROOTFUL_KVM_MAPPING_FAILED', error: `${device} has no numeric group gid` };
  }

  const auth = dependencies.rootfulPodman(executable, ['info', '--format', '{{json .}}'], PODMAN_INFO_PREFLIGHT_TIMEOUT_MS);
  if (auth.status !== 0) {
    return { status: 'ROOTFUL_PODMAN_AUTH_UNAVAILABLE', error: `Rootful Podman authorization failed: ${commandFailure(auth)}` };
  }

  const probe = dependencies.composeProbe(rootfulAndroidComposeProbeArgs(), ROOTFUL_KVM_SMOKE_TIMEOUT_MS);
  if (probe.status === 0) return { status: 'PASS', gid: stat.gid };
  if (probe.status === KVM_PERMISSION_EXIT) {
    return { status: 'ROOTFUL_KVM_PERMISSION_FAILED', error: `androidusr cannot read/write ${device}: ${commandFailure(probe)}` };
  }
  return { status: 'ROOTFUL_KVM_MAPPING_FAILED', error: `Rootful Android KVM mapping probe failed: ${commandFailure(probe)}` };
}

interface ComposeService {
  Service: string;
  State: string;
  Health: string;
}

/**
 * Preflight: verify compose.sh exists, is executable, and can be invoked.
 */
function checkComposePrerequisites(): { ok: boolean; error?: string } {
  if (!fs.existsSync(COMPOSE_SCRIPT)) {
    return { ok: false, error: `compose.sh not found at ${COMPOSE_SCRIPT}` };
  }
  try {
    const proc = spawnSync(COMPOSE_SCRIPT, ['--version'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000,
    });
    if (proc.status === 0) {
      return { ok: true };
    }
    // Exit code 69 = noninteractive sudo required
    if (proc.status === 69) {
      return {
        ok: false,
        error: 'BLOCKED_EXTERNAL: noninteractive sudo is required for the rootful E2E Compose project.',
      };
    }
    return { ok: false, error: `compose.sh failed: exit ${proc.status}` };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Write artifact to e2e-lab/artifacts directory.
 */
function writeArtifact(name: string, content: string): void {
  try {
    if (!fs.existsSync(ARTIFACTS_DIR)) {
      fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    }
    const filePath = path.join(ARTIFACTS_DIR, name);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`[Android] Artifact written: ${filePath}`);
  } catch (err) {
    console.error(`[Android] Failed to write artifact ${name}:`, err);
  }
}

/**
 * Prepare temporary directory with entire client tree (excluding node_modules).
 * This is the Expo prebuild source.
 */
function prepareTemporaryAndroidSource(): { ok: boolean; tempDir?: string; error?: string } {
  try {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-remote-'));
    const clientRoot = path.join(ROOT, 'client');

    if (!fs.existsSync(clientRoot)) {
      return { ok: false, error: `client root not found at ${clientRoot}` };
    }

    // Copy entire client tree except node_modules
    const entries = fs.readdirSync(clientRoot, { withFileTypes: true });
    for (const entry of entries) {
      // Skip node_modules; will be mounted via Compose
      if (entry.name === 'node_modules') continue;

      const srcPath = path.join(clientRoot, entry.name);
      const dstPath = path.join(tempDir, entry.name);

      if (entry.isDirectory()) {
        fs.cpSync(srcPath, dstPath, { recursive: true });
      } else {
        fs.cpSync(srcPath, dstPath);
      }
    }

    console.log(`[Android] Source prepared at ${tempDir}`);
    return { ok: true, tempDir };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run Expo prebuild on host (before staging source).
 */
function runExpoPrebuildOnHost(tempDir: string): { ok: boolean; error?: string } {
  if (!fs.existsSync(LOCAL_EXPO)) {
    return { ok: false, error: `Locked local Expo executable is missing: ${LOCAL_EXPO}. Run the E2E bootstrap.` };
  }

  const temporaryNodeModules = path.join(tempDir, 'node_modules');
  try {
    // Expo resolves the project's SDK from cwd; expose only the canonical locked tree
    // while prebuilding, then remove the link before the temporary source is staged.
    fs.symlinkSync(path.join(ROOT, 'client', 'node_modules'), temporaryNodeModules, 'dir');
    console.log(`[Android] Running local Expo prebuild on host...`);
    const proc = spawnSync(LOCAL_EXPO, ['prebuild', '--platform', 'android', '--clean', '--no-install'], {
      cwd: tempDir,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 300_000,
      env: { ...process.env, ...E2E_ENV },
    });
    if (proc.status !== 0) {
      return { ok: false, error: `Expo prebuild failed: ${proc.stderr || proc.stdout || 'unknown'}` };
    }
    console.log(`[Android] Expo prebuild complete`);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    fs.rmSync(temporaryNodeModules, { recursive: true, force: true });
  }
}

/**
 * Stage prebuilt source into .runtime/android/source (bind mount point).
 * This occurs BEFORE Compose starts Android, so no mount conflict.
 */
function stageSourceForService(tempDir: string): { ok: boolean; error?: string } {
  try {
    console.log(`[Android] Staging source for Compose...`);
    const runtimeDir = path.join(LAB_DIR, '.runtime', 'android');
    const stageDir = path.join(runtimeDir, 'source');

    // Clean and recreate
    if (fs.existsSync(stageDir)) {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
    fs.mkdirSync(stageDir, { recursive: true });

    // Copy prepared source into stage directory
    const entries = fs.readdirSync(tempDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(tempDir, entry.name);
      const dstPath = path.join(stageDir, entry.name);

      if (entry.isDirectory()) {
        fs.cpSync(srcPath, dstPath, { recursive: true });
      } else {
        fs.cpSync(srcPath, dstPath);
      }
    }

    console.log(`[Android] Source staged at ${stageDir}`);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Poll Compose health until service is ready or timeout.
 */
function pollComposeHealth(timeoutMs: number): { ok: boolean; error?: string } {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const proc = spawnSync(COMPOSE_SCRIPT, ['ps', '--format=json'], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 10_000,
      });

      if (proc.status !== 0) {
        console.log(`[Android] Compose ps failed; waiting...`);
        spawnSync('sleep', ['5'], { stdio: 'pipe' });
        continue;
      }

      const services = proc.stdout
        .split('\n')
        .filter((line) => line.trimStart().startsWith('{'))
        .map((line) => JSON.parse(line));

      let found = false;
      for (const item of services) {
        if (item === null || typeof item !== 'object') continue;

        const typed = item as Record<string, unknown>;
        const service = String(typed.Service || '');
        const state = String(typed.State || '');
        const health = String(typed.Health || '');

        if (service === 'android-emulator') {
          found = true;
          console.log(`[Android] Service state: ${state}, health: ${health}`);

          if (state === 'running' && health === 'healthy') {
            console.log(`[Android] Compose healthy`);
            return { ok: true };
          }
          break;
        }
      }

      if (!found) {
        console.log(`[Android] Service not found; waiting...`);
      }
    } catch (err) {
      console.log(`[Android] Health check error: ${err}; waiting...`);
    }

    // Sleep 5 seconds before next poll
    spawnSync('sleep', ['5'], { stdio: 'pipe' });
  }

  return { ok: false, error: 'Compose health check timeout' };
}

/**
 * Start only android-emulator service.
 * Provider and daemon are already running from up.sh.
 */
function startCompose(): { ok: boolean; error?: string } {
  try {
    console.log(`[Android] Starting android-emulator service...`);
    const proc = spawnSync(COMPOSE_SCRIPT, ['up', '-d', 'android-emulator'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 120_000,
    });
    if (proc.status !== 0) {
      return { ok: false, error: `Compose up android-emulator failed: ${proc.stderr || 'unknown'}` };
    }
    console.log(`[Android] android-emulator started`);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Build APK in container.
 * Copy full staged source → /workspace/build, run Gradle from android/ subdirectory.
 */
function buildAPKInContainer(): { ok: boolean; apkPath?: string; error?: string } {
  try {
    // Copy entire staged source into build volume
    console.log(`[Android] Copying full staged source into build volume...`);
    const copyProc = spawnSync(COMPOSE_SCRIPT, [
      'exec',
      '-T',
      'android-emulator',
      'bash',
      '-c',
      'find /workspace/build -mindepth 1 -maxdepth 1 -exec rm -rf {} + && find /workspace/source -mindepth 1 -maxdepth 1 ! -name node_modules -exec cp -a {} /workspace/build/ \\; && ln -s /workspace/source/node_modules /workspace/build/node_modules',
    ], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 60_000,
    });
    if (copyProc.status !== 0) {
      const diagnostic = [copyProc.error?.message, copyProc.stderr, copyProc.stdout].filter(Boolean).join('\n');
      return { ok: false, error: `Copy source failed with exit ${copyProc.status ?? 'signal'}: ${diagnostic || 'unknown'}` };
    }

    // Build Gradle from android subdirectory
    console.log(`[Android] Building APK via Gradle...`);
    const buildProc = spawnSync(COMPOSE_SCRIPT, [
      'exec',
      '-T',
      'android-emulator',
      'bash',
      '-c',
      'cd /workspace/build/android && GRADLE_USER_HOME=/tmp/gradle-e2e ./gradlew -x testDebug assembleDebug',
    ], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 300_000,
    });
    if (buildProc.status !== 0) {
      return { ok: false, error: `Gradle build failed: ${buildProc.stderr || 'unknown'}` };
    }

    const apkPath = '/workspace/build/android/app/build/outputs/apk/debug/app-debug.apk';
    console.log(`[Android] APK built at ${apkPath}`);
    return { ok: true, apkPath };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Copy APK from container to host temp directory.
 */
function copyAPKToHost(containerAPKPath: string): { ok: boolean; hostPath?: string; error?: string } {
  try {
    const hostAPKDir = path.join(os.tmpdir(), 'agentic-e2e-apk');
    if (!fs.existsSync(hostAPKDir)) {
      fs.mkdirSync(hostAPKDir, { recursive: true });
    }

    const hostAPKPath = path.join(hostAPKDir, 'app-debug.apk');
    console.log(`[Android] Copying APK from container to ${hostAPKPath}...`);

    const proc = spawnSync(COMPOSE_SCRIPT, [
      'cp',
      `android-emulator:${containerAPKPath}`,
      hostAPKPath,
    ], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30_000,
    });

    if (proc.status !== 0) {
      return { ok: false, error: `APK copy failed: ${proc.stderr || 'unknown'}` };
    }

    if (!fs.existsSync(hostAPKPath)) {
      return { ok: false, error: 'APK not found on host after copy' };
    }

    console.log(`[Android] APK copied to host: ${hostAPKPath}`);
    return { ok: true, hostPath: hostAPKPath };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Connect host ADB and return device serial.
 */
function hostADBConnect(adbExecutable: string): { ok: boolean; serial?: string; error?: string } {
  try {
    console.log(`[Android] Connecting ADB via ${adbExecutable}...`);
    const proc = spawnSync(adbExecutable, ['connect', '127.0.0.1:5555'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 15_000,
    });

    if (proc.status !== 0) {
      return { ok: false, error: `ADB connect failed: ${proc.stderr || 'unknown'}` };
    }

    const serial = '127.0.0.1:5555';
    console.log(`[Android] ADB connected: ${serial}`);
    return { ok: true, serial };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Install APK on device via ADB.
 */
function installAPKOnDevice(adbExecutable: string, serial: string, apkPath: string): { ok: boolean; error?: string } {
  try {
    console.log(`[Android] Installing APK on device ${serial}...`);
    const proc = spawnSync(adbExecutable, ['-s', serial, 'install', '-r', apkPath], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 60_000,
    });

    if (proc.status !== 0) {
      return { ok: false, error: `APK install failed: ${proc.stderr || 'unknown'}` };
    }

    console.log(`[Android] APK installed`);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run Maestro flows against device.
 * Invokes specific flow file with E2E_ENV environment variables.
 */
function runMaestroFlows(serial: string, timeout: number): { ok: boolean; output: string } {
  try {
    console.log(`[Android] Running Maestro flows...`);

    // Use pairing-flow.yaml as the primary E2E flow
    const flowPath = path.join(LAB_DIR, 'maestro', 'flows', 'pairing-flow.yaml');
    if (!fs.existsSync(flowPath)) {
      return { ok: false, output: `Maestro flow not found: ${flowPath}` };
    }

    const proc = spawnSync('maestro', ['test', flowPath, '--device', serial], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout,
      env: { ...process.env, ...E2E_ENV },
    });

    const output = proc.stdout || proc.stderr || '';
    if (proc.error || proc.status !== 0) {
      return { ok: false, output };
    }

    return { ok: true, output };
  } catch (err: unknown) {
    return {
      ok: false,
      output: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Clean up temporary directory.
 */
function cleanupTempDir(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[Android] Cleaned up ${dir}`);
    }
  } catch (err) {
    console.warn(`Cleanup failed: ${err}`);
  }
}

/**
 * Main E2E runner.
 * Does NOT call compose down; teardown is owned by test-all.sh EXIT trap.
 */
export async function runAndroidVerification(): Promise<AndroidRunnerReport> {
  const report: AndroidRunnerReport = {
    status: 'FAILED',
    details: '',
    blockers: [],
    remediationSteps: [],
  };

  let tempDir: string | undefined;

  try {
    // 1. Preflight
    console.log(`[Android] Checking Compose prerequisites...`);
    const preflightCheck = checkComposePrerequisites();
    if (!preflightCheck.ok) {
      report.status = 'BLOCKED';
      report.details = preflightCheck.error || 'Preflight failed';
      report.blockers.push(preflightCheck.error || 'Compose prerequisite check failed');
      report.remediationSteps.push(
        preflightCheck.error?.includes('BLOCKED_EXTERNAL')
          ? 'BLOCKED_EXTERNAL: Ensure Podman and passwordless sudo are available. Contact host administrator to add sudoers NOPASSWD entry.'
          : 'Install missing host tools (adb, maestro, bun) or verify compose.sh'
      );
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    const adbResolution = resolveAndroidAdbExecutable();
    if (!adbResolution.ok) {
      report.status = 'BLOCKED';
      report.details = `BLOCKED_ADB_UNAVAILABLE: Existing Android SDK ADB was not found. Searched: ${adbResolution.searched.join(', ')}`;
      report.blockers.push(report.details);
      report.remediationSteps.push('Expose an existing Android SDK platform-tools/adb through ANDROID_HOME, ANDROID_SDK_ROOT, or $HOME/android-sdk; do not install a second SDK.');
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }
    const adbExecutable = adbResolution.executable;
    console.log(`[Android] Using existing Android SDK ADB: ${adbExecutable}`);

    // 2. Query the canonical rootful Podman storage context before Android starts.
    console.log(`[Android] Checking rootful Podman storage...`);
    const storageCheck = checkAndroidStorage();
    report.storagePreflight = storageCheck;
    if (storageCheck.status !== 'PASS') {
      report.status = 'BLOCKED';
      report.details = storageCheck.status === 'BLOCKED_INSUFFICIENT_STORAGE'
        ? `BLOCKED_INSUFFICIENT_STORAGE: ${storageCheck.context.availableBytes} available bytes at ${storageCheck.context.graphRoot}; ${storageCheck.context.requiredBytes} required.`
        : `BLOCKED_STORAGE_CONTEXT: ${storageCheck.error}`;
      report.blockers.push(report.details);
      report.remediationSteps.push(
        storageCheck.status === 'BLOCKED_INSUFFICIENT_STORAGE'
          ? 'Free capacity in the reported rootful GraphRoot, then rerun the Android harness.'
          : 'Repair the canonical rootful Podman context exposed by compose.sh, then rerun the Android harness.'
      );
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }
    console.log(`[Android] Storage PASS: ${storageCheck.context.availableBytes} available bytes at ${storageCheck.context.graphRoot}; ${storageCheck.context.requiredBytes} required.`);

    // 3. KVM must be tested through the exact rootful Compose service mapping.
    // Host-user access is intentionally not a gate: rootful Podman owns the device mapping.
    console.log(`[Android] Checking rootful Android KVM mapping...`);
    const kvmPreflight = checkRootfulKvmMapping();
    if (kvmPreflight.status !== 'PASS') {
      report.status = 'BLOCKED';
      report.details = `${kvmPreflight.status}: ${kvmPreflight.error}`;
      report.blockers.push(kvmPreflight.status);
      report.remediationSteps.push(
        kvmPreflight.status === 'KVM_DEVICE_MISSING'
          ? 'Provide a host /dev/kvm character device to the rootful E2E environment.'
          : 'Repair the rootful Podman Android device mapping; do not change host-user KVM permissions.'
      );
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }
    console.log(`[Android] Rootful Android KVM mapping PASS (gid ${kvmPreflight.gid}).`);

    // 3. Prepare temporary source (entire client tree)
    console.log(`[Android] Preparing temporary source...`);
    const prepResult = prepareTemporaryAndroidSource();
    if (!prepResult.ok) {
      report.status = 'FAILED';
      report.details = prepResult.error || 'Source preparation failed';
      report.blockers.push(prepResult.error || 'Could not prepare source');
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }
    tempDir = prepResult.tempDir!;

    // 4. Run Expo prebuild on host (before staging)
    console.log(`[Android] Running Expo prebuild...`);
    const expoPrebuildResult = runExpoPrebuildOnHost(tempDir);
    if (!expoPrebuildResult.ok) {
      report.status = 'FAILED';
      report.details = expoPrebuildResult.error || 'Expo prebuild failed';
      report.blockers.push(expoPrebuildResult.error || 'Expo prebuild failed');
      cleanupTempDir(tempDir);
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    // 5. Stage prebuilt source (before Compose starts Android)
    console.log(`[Android] Staging source...`);
    const stageResult = stageSourceForService(tempDir);
    if (!stageResult.ok) {
      report.status = 'FAILED';
      report.details = stageResult.error || 'Source staging failed';
      report.blockers.push(stageResult.error || 'Could not stage source');
      cleanupTempDir(tempDir);
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    // 6. Start android-emulator service (provider/daemon already running)
    console.log(`[Android] Starting android-emulator service...`);
    const composeUpResult = startCompose();
    if (!composeUpResult.ok) {
      report.status = 'FAILED';
      report.details = composeUpResult.error || 'Compose startup failed';
      report.blockers.push(composeUpResult.error || 'Compose failed to start');
      cleanupTempDir(tempDir);
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    // 7. Poll Compose health
    console.log(`[Android] Polling Compose health...`);
    const healthResult = pollComposeHealth(360_000); // Compose health budget: start period plus retries
    if (!healthResult.ok) {
      report.status = 'FAILED';
      report.details = healthResult.error || 'Health check timeout';
      report.blockers.push(healthResult.error || 'Compose health check failed');
      cleanupTempDir(tempDir);
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    // 8. Build APK in container
    console.log(`[Android] Building APK...`);
    const buildResult = buildAPKInContainer();
    if (!buildResult.ok) {
      report.status = 'FAILED';
      report.details = buildResult.error || 'APK build failed';
      report.blockers.push(buildResult.error || 'Gradle build failed');
      cleanupTempDir(tempDir);
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    // 9. Copy APK to host
    console.log(`[Android] Copying APK to host...`);
    const copyResult = copyAPKToHost(buildResult.apkPath!);
    if (!copyResult.ok) {
      report.status = 'FAILED';
      report.details = copyResult.error || 'APK copy failed';
      report.blockers.push(copyResult.error || 'Could not copy APK');
      cleanupTempDir(tempDir);
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    // 10. Connect ADB
    console.log(`[Android] Connecting ADB...`);
    const adbResult = hostADBConnect(adbExecutable);
    if (!adbResult.ok) {
      report.status = 'FAILED';
      report.details = adbResult.error || 'ADB connection failed';
      report.blockers.push(adbResult.error || 'ADB failed');
      cleanupTempDir(tempDir);
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    // 11. Install APK
    console.log(`[Android] Installing APK...`);
    const installResult = installAPKOnDevice(adbExecutable, adbResult.serial!, copyResult.hostPath!);
    if (!installResult.ok) {
      report.status = 'FAILED';
      report.details = installResult.error || 'APK install failed';
      report.blockers.push(installResult.error || 'Installation failed');
      cleanupTempDir(tempDir);
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    // 12. Run Maestro flows
    console.log(`[Android] Running Maestro flows...`);
    const maestroResult = runMaestroFlows(adbResult.serial!, 300_000); // 5 minutes
    writeArtifact('android-maestro-output.log', maestroResult.output);
    if (!maestroResult.ok) {
      report.status = 'FAILED';
      report.details = maestroResult.output || 'Maestro flows failed';
      report.blockers.push(maestroResult.output || 'Maestro test failed');
    } else {
      report.status = 'PASSED';
      report.details = 'E2E test completed successfully';
    }

    // Collect Compose logs
    try {
      const logsProc = spawnSync(COMPOSE_SCRIPT, ['logs', 'android-emulator'], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 30_000,
      });
      if (logsProc.status === 0) {
        writeArtifact('android-service-logs.log', logsProc.stdout || '');
      }
    } catch (err) {
      console.warn(`Failed to collect logs: ${err}`);
    }

    return report;
  } catch (err: unknown) {
    report.status = 'FAILED';
    report.details = err instanceof Error ? err.message : String(err);
    report.blockers.push(report.details);
    writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
    return report;
  } finally {
    if (tempDir) {
      cleanupTempDir(tempDir);
    }
  }
}

// Main entry point
if (import.meta.main) {
  const startTime = Date.now();
  runAndroidVerification()
    .then((report) => {
      console.log('\n=== Android E2E Report ===');
      console.log(`Status: ${report.status}`);
      console.log(`Details: ${report.details}`);
      if (report.blockers.length > 0) {
        console.log('\nBlockers:');
        report.blockers.forEach((b) => console.log(`  - ${b}`));
      }
      if (report.remediationSteps.length > 0) {
        console.log('\nRemediation:');
        report.remediationSteps.forEach((r) => console.log(`  - ${r}`));
      }
      const wallTime = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`\nWall time: ${wallTime} seconds`);
      process.exit(report.status === 'PASSED' ? 0 : 1);
    })
    .catch((err) => {
      console.error('Unhandled error:', err);
      process.exit(1);
    });
}
