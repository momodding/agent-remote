import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { getAndroidEnvironment } from './env';

const E2E_ENV = getAndroidEnvironment();
const ROOT = path.resolve(__dirname, '../..');
const ARTIFACTS_DIR = path.join(__dirname, '../artifacts');
const CONTAINER_SOURCE_PATH = '/tmp/agentic-remote';

const bounded = (s: string) => s.slice(0, 100_000);

interface AndroidImage {
  repo: string;
  tag: string;
  digest: string;
  reference: string;
}

interface AndroidConfig {
  image: AndroidImage;
  containerOptions: string[];
  readinessTimeout: number;
  maestroTimeout: number;
}

export interface AndroidRunnerReport {
  status: 'PASSED' | 'FAILED' | 'BLOCKED';
  details: string;
  timestamp: string;
  blockers: string[];
  remediationSteps: string[];
  exitCode: number;
  deviceStatus: Record<string, string>;
  containerMetadata: { id?: string; name: string; labels: Record<string, string> };
}

function command(command: string, args: string[], options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? E2E_ENV,
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
  });
  return {
    ok: !result.error && result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    status: result.status ?? 1,
  };
}

function validateKVMAccess(): boolean {
  try {
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function writeArtifact(name: string, content: string): void {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACTS_DIR, name), bounded(content), 'utf8');
}
function toolRemediation(tool: 'adb' | 'podman'): string {
  if (process.platform === 'darwin') {
    return tool === 'adb'
      ? 'Install Android platform-tools with Homebrew: brew install android-platform-tools'
      : 'Install Podman with Homebrew: brew install podman';
  }
  return tool === 'adb'
    ? 'Install Android platform-tools so adb is on PATH.'
    : 'Install Podman 4.0+ with your Linux distribution package manager.';
}


function readAndroidConfig(): AndroidConfig {
  const contents = fs.readFileSync(path.join(ROOT, 'e2e-lab/env/versions.env'), 'utf8');
  const value = (name: string) => contents.match(new RegExp(`^export ${name}="([^"]+)"`, 'm'))?.[1];
  const repo = value('ANDROID_IMAGE_REPO');
  const tag = value('ANDROID_IMAGE_TAG');
  const digest = value('ANDROID_IMAGE_DIGEST');
  const containerOpts = value('CONTAINER_OPTS');
  const readinessTimeout = parseInt(value('ADB_READINESS_TIMEOUT') ?? '300', 10) * 1000;
  const maestroTimeout = parseInt(value('MAESTRO_FLOW_TIMEOUT') ?? '300', 10) * 1000;

  const options = containerOpts?.split(/\s+/).filter(Boolean) ?? [];
  if (!repo || !tag || !digest || options.join(' ') !== '--rm --device /dev/kvm --group-add keep-groups --userns=keep-id:uid=1300,gid=1301' || !/^sha256:[a-f0-9]{64}$/.test(digest)
    || !Number.isSafeInteger(readinessTimeout) || readinessTimeout < 1 || !Number.isSafeInteger(maestroTimeout) || maestroTimeout < 1) {
    throw new Error(`Invalid Android config from env/versions.env`);
  }
  return { image: { repo, tag, digest, reference: `${repo}:${tag}@${digest}` }, containerOptions: options, readinessTimeout, maestroTimeout };
}

function prepareTemporaryAndroidSource(): { ok: boolean; tempDir?: string; error?: string } {
  try {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-android-'));
    const clientDir = path.join(ROOT, 'client');

    // Copy client source, excluding node_modules, .git, android
    fs.cpSync(clientDir, tempDir, {
      recursive: true,
      filter(source) {
        const relative = path.relative(clientDir, source);
        return !relative.split(path.sep).some(part => ['.git', 'android', 'node_modules'].includes(part));
      },
    });

    // Symlink canonical node_modules to temp location
    fs.symlinkSync(
      path.join(clientDir, 'node_modules'),
      path.join(tempDir, 'node_modules'),
      'dir'
    );

    console.log(`[Android] Prepared temporary Android source: ${tempDir}`);
    return { ok: true, tempDir };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function runExpoPrebuildonHost(tempDir: string): { ok: boolean; error?: string } {
  try {
    const expoExe = path.join(ROOT, 'client/node_modules/.bin/expo');
    if (!fs.existsSync(expoExe)) {
      return { ok: false, error: `Canonical expo not found: ${expoExe}` };
    }

    // Verify --no-install support
    console.log(`[Android] Checking Expo --no-install support...`);
    const helpCheck = command(expoExe, ['prebuild', '--help'], { cwd: tempDir, timeout: 10_000 });
    if (!helpCheck.output.includes('--no-install')) {
      return { ok: false, error: `Expo prebuild does not support --no-install flag` };
    }

    // Run prebuild with required flags
    console.log(`[Android] Running Expo prebuild --platform android --no-install --clean in ${tempDir}...`);
    const result = command(expoExe, ['prebuild', '--platform', 'android', '--no-install', '--clean'], { cwd: tempDir, timeout: 300_000 });
    if (!result.ok) {
      return { ok: false, error: `Expo prebuild failed: ${result.output}` };
    }

    // E2E source is bind-mounted into Podman; disable Gradle VFS watching
    // only in this generated copy because that filesystem does not support it.
    fs.appendFileSync(
      path.join(tempDir, 'android', 'gradle.properties'),
      '\norg.gradle.vfs.watch=false\n'
    );

    console.log(`[Android] Expo prebuild completed`);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function launchAndroidContainer(
  config: AndroidConfig,
  tempSourceDir: string,
  debug: boolean
): { containerId?: string; containerName?: string; adbPort?: number; error?: string } {
  try {
    const image = config.image.reference;
    const containerName = `agentic-e2e-android-${Date.now()}`;
    // The pinned Docker-Android image has no /android directory, so keep the
    // temporary build source under its writable /tmp hierarchy.
    const containerSourcePath = CONTAINER_SOURCE_PATH;
    const ports = ['--publish=127.0.0.1::5555/tcp'];
    if (debug) ports.push('--publish=127.0.0.1:6080:6080/tcp');

    const labels = [
      '--label=io.agent-remote.e2e=true',
      '--label=io.agent-remote.role=android',
      `--label=io.agent-remote.image-digest=${config.image.digest}`,
      `--label=version=${config.image.tag}`,
      `--label=timestamp=${new Date().toISOString()}`,
    ];
    // React Native's generated settings.gradle resolves
    // '@react-native/gradle-plugin' via Node's require.resolve({paths:...}),
    // which real-pathes symlinks. A node_modules symlink pointing at a
    // differently-named directory breaks that ancestor-directory walk, so
    // node_modules must be a real directory name at the mount target, not a
    // symlink to one. Podman supports nesting a nested bind mount inside an
    // already-mounted directory, so replace the host prebuild symlink with
    // an empty directory and bind the real node_modules directly over it.
    fs.unlinkSync(path.join(tempSourceDir, 'node_modules'));
    fs.mkdirSync(path.join(tempSourceDir, 'node_modules'));
    const mounts = [
      `--volume=${tempSourceDir}:${containerSourcePath}:rw`,
      `--volume=${path.join(ROOT, 'client/node_modules')}:${containerSourcePath}/node_modules:ro`,
      // budtmo/docker-android's change_permission() unconditionally chowns
      // /dev/kvm to its hardcoded 1300:1301, which rootless Podman always
      // rejects (no CAP_CHOWN over a device you don't own). --userns=keep-id
      // above already maps that identity onto the real host KVM-access UID,
      // so this patch only needs to skip the chown, not perform one.
      `--volume=${path.join(__dirname, 'patches/emulator-kvm-fix.py')}:/home/androidusr/docker-android/cli/src/device/emulator.py:ro`,
    ];
    const runCmd = ['podman', 'run', '-d', ...config.containerOptions, `--name=${containerName}`, ...ports, ...labels, ...mounts, image];

    console.log(`[Android] Launching detached container: ${runCmd.join(' ')}`);
    const proc = spawnSync(runCmd[0], runCmd.slice(1), { stdio: 'pipe', encoding: 'utf8' });
    if (proc.error || proc.status !== 0) return { error: proc.error?.message ?? proc.stderr ?? 'Launch failed' };

    const mapping = command('podman', ['port', containerName, '5555/tcp']);
    const match = mapping.output.match(/^127\.0\.0\.1:(\d+)$/m);
    const adbPort = match && Number(match[1]);
    if (!mapping.ok || !adbPort || adbPort > 65535) {
      return { containerName, error: `No numeric loopback ADB mapping: ${mapping.output}` };
    }
    console.log(`[Android] Container ${containerName} launched with ADB on 127.0.0.1:${adbPort}`);
    return { containerId: proc.stdout.trim(), containerName, adbPort };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}


function buildDebugAPKInContainer(
  containerName: string,
  containerSourcePath: string,
  timeout: number
): { ok: boolean; containerAPKPath?: string; error?: string } {
  try {
    const androidDir = `${containerSourcePath}/android`;
    const buildCmd = command('podman', ['exec',
      `--env=GRADLE_USER_HOME=/tmp/gradle-e2e`,
      containerName, 'bash', '-c',
      `cd ${androidDir} && ./gradlew assembleDebug -x test`
    ], { timeout });

    if (!buildCmd.ok) {
      return { ok: false, error: `Build failed: ${buildCmd.output}` };
    }
    console.log(`[Android] APK built successfully in container`);
    return { ok: true, containerAPKPath: `${androidDir}/app/build/outputs/apk/debug/app-debug.apk` };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function copyAPKFromContainer(
  containerName: string,
  containerAPKPath: string,
  hostTempDir: string
): { ok: boolean; hostAPKPath?: string; error?: string } {
  try {
    const hostAPKPath = path.join(hostTempDir, 'app-debug.apk');
    const copyCmd = command('podman', ['cp', `${containerName}:${containerAPKPath}`, hostAPKPath]);
    if (!copyCmd.ok) {
      return { ok: false, error: `Copy failed: ${copyCmd.output}` };
    }
    console.log(`[Android] APK copied to host: ${hostAPKPath}`);
    return { ok: true, hostAPKPath };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function hostADBConnect(port: number, timeout: number): { ok: boolean; serial?: string; error?: string } {
  const serial = `127.0.0.1:${port}`;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const connect = command('adb', ['connect', serial]);
    if (connect.ok) {
      const devices = command('adb', ['devices']);
      const escapedSerial = serial.replace(/[.:]/g, '\\$&');
      if (devices.ok && devices.output.split('\n').some(line => new RegExp(`^${escapedSerial}\\s+device$`).test(line.trim()))) {
        console.log(`[Android] Host ADB connected: ${serial}`);
        return { ok: true, serial };
      }
    }
    const elapsed = Date.now() - start;
    if (elapsed < timeout) {
      console.log(`[Android] Waiting for ADB readiness (${elapsed}ms/${timeout}ms)...`);
      spawnSync('sleep', ['0.5']);
    }
  }
  return { ok: false, error: `ADB not ready at ${serial} after ${timeout}ms` };
}

function installAPKOnDevice(serial: string, hostAPKPath: string): { ok: boolean; error?: string } {
  const install = command('adb', ['-s', serial, 'install', '-r', hostAPKPath]);
  if (!install.ok) {
    return { ok: false, error: install.output };
  }
  console.log(`[Android] APK installed on ${serial}`);
  return { ok: true };
}

function runMaestroFlows(serial: string, timeout: number): { ok: boolean; output: string } {
  const flowsPath = path.join(ROOT, 'e2e-lab/maestro/flows');
  if (!fs.existsSync(flowsPath)) {
    return { ok: false, output: `Maestro flows directory not found: ${flowsPath}` };
  }
  const flows = fs.readdirSync(flowsPath).filter(f => f.endsWith('.yaml'));
  if (!flows.length) {
    return { ok: false, output: `No Maestro flows found in ${flowsPath}` };
  }
  const result = command('maestro', ['test', '--device-id', serial, ...flows.map(f => path.join(flowsPath, f))], { timeout });
  return { ok: result.ok, output: result.output };
}

function cleanupContainer(containerName: string): { ok: boolean; output: string } {
  if (process.env.E2E_KEEP === '1') {
    console.log(`[Android] Keeping container ${containerName} (E2E_KEEP=1)`);
    return { ok: true, output: 'Kept' };
  }
  // --rm removes the stopped container; a separate rm would turn cleanup into a false failure.
  const stop = command('podman', ['stop', containerName], { timeout: 5000 });
  return { ok: stop.ok, output: stop.output };
}

function cleanupTempDir(tempDir: string): void {
  if (process.env.E2E_KEEP === '1') {
    console.log(`[Android] Keeping temporary directory ${tempDir} (E2E_KEEP=1)`);
    return;
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`[Android] Cleaned temporary directory: ${tempDir}`);
  } catch {
    console.warn(`[Android] Failed to clean temporary directory: ${tempDir}`);
  }
}

function captureContainerLogs(containerName: string): void {
  const logs = command('podman', ['logs', containerName]);
  writeArtifact('android-container.log', logs.output || 'No container logs available.');
}
export async function runAndroidVerification(): Promise<AndroidRunnerReport> {
  const report: AndroidRunnerReport = {
    status: 'BLOCKED',
    details: '',
    timestamp: new Date().toISOString(),
    blockers: [],
    remediationSteps: [],
    exitCode: 1,
    deviceStatus: {},
    containerMetadata: { name: '', labels: {} },
  };

  let tempDir: string | undefined;
  let containerName: string | undefined;

  try {
    // Validate prerequisites
    if (!validateKVMAccess()) {
      report.blockers.push('/dev/kvm not readable/writable');
      report.remediationSteps.push('chmod 666 /dev/kvm or run with sudo');
      report.details = 'KVM access required for Android emulator';
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    const podman = command('podman', ['--version']);
    if (!podman.ok) {
      report.blockers.push('podman not available');
      report.remediationSteps.push(toolRemediation('podman'));
      report.details = podman.output;
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    const adb = command('adb', ['version']);
    if (!adb.ok) {
      report.blockers.push('adb not available');
      report.remediationSteps.push(toolRemediation('adb'));
      report.details = adb.output;
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    const maestro = command('maestro', ['--version']);
    if (!maestro.ok) {
      report.blockers.push('maestro not available');
      report.remediationSteps.push('Install maestro');
      report.details = maestro.output;
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    // Read config
    const config = readAndroidConfig();
    const debug = process.env.E2E_ANDROID_DEBUG === '1';

    // Docker-Android is a multi-layer emulator image; the generic 30-second
    // command deadline is only appropriate for probes, not an initial pull.
    console.log(`[Android] Pulling image ${config.image.reference}...`);
    const pull = command('podman', ['pull', config.image.reference], { timeout: 30 * 60 * 1000 });
    if (!pull.ok) {
      report.blockers.push('Image pull failed');
      report.details = pull.output;
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    // Prepare temporary Android source with symlinked node_modules
    const prepResult = prepareTemporaryAndroidSource();
    if (!prepResult.ok || !prepResult.tempDir) {
      report.blockers.push(`Failed to prepare temporary source: ${prepResult.error}`);
      report.details = prepResult.error ?? 'Unknown error';
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }
    tempDir = prepResult.tempDir;

    // Run Expo prebuild on host BEFORE launch
    const prebuildResult = runExpoPrebuildonHost(tempDir);
    if (!prebuildResult.ok) {
      report.blockers.push(`Expo prebuild failed: ${prebuildResult.error}`);
      report.status = 'FAILED';
      report.details = prebuildResult.error ?? 'Prebuild failed';
      cleanupTempDir(tempDir);
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    // Launch container in DETACHED mode
    const launch = launchAndroidContainer(config, tempDir, debug);
    if (launch.error || !launch.containerName || !launch.adbPort) {
      report.blockers.push(`Container launch failed: ${launch.error}`);
      report.details = launch.error ?? 'Unknown error';
      if (launch.containerName) cleanupContainer(launch.containerName);
      cleanupTempDir(tempDir);
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    containerName = launch.containerName;
    report.containerMetadata.id = launch.containerId;
    report.containerMetadata.name = containerName;
    report.containerMetadata.labels = {
      'io.agent-remote.e2e': 'true',
      'io.agent-remote.role': 'android',
      'io.agent-remote.image-digest': config.image.digest,
      'version': config.image.tag,
    };

    // Docker-Android exposes emulator readiness through the published ADB port;
    // this image does not provide a device_status executable.
    console.log(`[Android] Connecting host ADB to 127.0.0.1:${launch.adbPort}...`);
    const adbResult = hostADBConnect(launch.adbPort, config.readinessTimeout);
    if (!adbResult.ok || !adbResult.serial) {
      report.blockers.push(adbResult.error ?? 'ADB connection failed');
      report.status = 'FAILED';
      report.details = adbResult.error ?? 'ADB not ready';
      captureContainerLogs(containerName);
      cleanupContainer(containerName);
      cleanupTempDir(tempDir);
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    const serial = adbResult.serial;
    report.deviceStatus[serial] = 'connected';

    // Build debug APK in container with ephemeral GRADLE_USER_HOME=/tmp/gradle-e2e
    console.log(`[Android] Building debug APK in container...`);
    const buildResult = buildDebugAPKInContainer(containerName, CONTAINER_SOURCE_PATH, 300_000);
    if (!buildResult.ok || !buildResult.containerAPKPath) {
      report.blockers.push(`APK build failed: ${buildResult.error}`);
      report.status = 'FAILED';
      report.details = buildResult.error ?? 'Build failed';
      captureContainerLogs(containerName);
      cleanupContainer(containerName);
      cleanupTempDir(tempDir);
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    // Copy APK from container to host
    console.log(`[Android] Copying APK from container to host...`);
    const copyResult = copyAPKFromContainer(containerName, buildResult.containerAPKPath, tempDir);
    if (!copyResult.ok || !copyResult.hostAPKPath) {
      report.blockers.push(`APK copy failed: ${copyResult.error}`);
      report.status = 'FAILED';
      report.details = copyResult.error ?? 'Copy failed';
      captureContainerLogs(containerName);
      cleanupContainer(containerName);
      cleanupTempDir(tempDir);
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }


    // Install APK on device using host APK path
    console.log(`[Android] Installing APK on ${serial}...`);
    const installResult = installAPKOnDevice(serial, copyResult.hostAPKPath);
    if (!installResult.ok) {
      report.blockers.push(`APK install failed: ${installResult.error}`);
      report.status = 'FAILED';
      report.details = installResult.error ?? 'Install failed';
      captureContainerLogs(containerName);
      cleanupContainer(containerName);
      cleanupTempDir(tempDir);
      writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
      return report;
    }

    // Run Maestro flows with exact serial
    console.log(`[Android] Running Maestro flows on ${serial}...`);
    const maestroResult = runMaestroFlows(serial, config.maestroTimeout);
    report.status = maestroResult.ok ? 'PASSED' : 'FAILED';
    report.details = maestroResult.ok
      ? `All Maestro E2E flows passed on ${serial}`
      : `Maestro flows failed: ${maestroResult.output}`;
    report.exitCode = maestroResult.ok ? 0 : 1;

    if (!maestroResult.ok) captureContainerLogs(containerName);
    cleanupContainer(containerName);
    cleanupTempDir(tempDir);

    writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
    return report;
  } catch (err: unknown) {
    report.status = 'BLOCKED';
    report.blockers.push(err instanceof Error ? err.message : String(err));
    report.details = err instanceof Error ? err.stack ?? err.message : String(err);

    if (containerName) {
      captureContainerLogs(containerName);
      cleanupContainer(containerName);
    }
    if (tempDir) cleanupTempDir(tempDir);

    writeArtifact('android-verification.json', JSON.stringify(report, null, 2));
    return report;
  }
}

// Entry point: only execute if run as main module, not imported
if (import.meta.main) {
  (async () => {
    const report = await runAndroidVerification();
    console.log(`\n[Android] Final Status: ${report.status}`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.exitCode);
  })().catch(err => {
    console.error(`[Android] Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
