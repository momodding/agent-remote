import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';

export interface DoctorCheck {
  id: string;
  name: string;
  category: 'core' | 'backend' | 'web' | 'android' | 'security';
  status: 'PASS' | 'WARN' | 'FAIL' | 'BLOCKED_ENVIRONMENT';
  details: string;
  remediation?: string;
}

export interface DoctorReport {
  timestamp: string;
  workspaceRoot: string;
  checks: DoctorCheck[];
  summary: {
    passed: number;
    warned: number;
    failed: number;
    blocked: number;
  };
}

function runCmd(cmd: string, env: Record<string, string> = {}): { stdout: string; ok: boolean } {
  try {
    const res = execSync(cmd, {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return { stdout: res.trim(), ok: true };
  } catch (err: unknown) {
    let out = '';
    if (err && typeof err === 'object') {
      if ('stdout' in err && err.stdout) out += String(err.stdout);
      if ('stderr' in err && err.stderr) out += String(err.stderr);
    }
    if (!out) out = String(err);
    return { stdout: out.trim(), ok: false };
  }
}

async function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

export async function runDoctor(): Promise<DoctorReport> {
  const rootDir = path.resolve(__dirname, '../..');
  const artifactsDir = path.join(__dirname, '../artifacts');
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }

  const checks: DoctorCheck[] = [];

  // 1. Git clean status
  const gitStatus = runCmd('git status --porcelain', { cwd: rootDir });
  const gitHead = runCmd('git rev-parse HEAD', { cwd: rootDir });
  checks.push({
    id: 'git-status',
    name: 'Git Clean Tree & HEAD',
    category: 'core',
    status: gitStatus.ok && gitStatus.stdout === '' ? 'PASS' : 'WARN',
    details: `HEAD: ${gitHead.stdout.substring(0, 7)} | Modified files: ${gitStatus.stdout ? gitStatus.stdout.split('\n').length : 0}`,
  });

  // 2. Go Toolchain
  const goVer = runCmd('go version');
  checks.push({
    id: 'go-compiler',
    name: 'Go Compiler (1.24+)',
    category: 'backend',
    status: goVer.ok && goVer.stdout.includes('go version') ? 'PASS' : 'FAIL',
    details: goVer.stdout || 'Go binary not found',
    remediation: 'Install Go 1.24+ and ensure it is in PATH',
  });

  // 3. Bun Runtime
  const bunVer = runCmd('bun --version');
  checks.push({
    id: 'bun-runtime',
    name: 'Bun Runtime',
    category: 'core',
    status: bunVer.ok ? 'PASS' : 'FAIL',
    details: bunVer.ok ? `bun v${bunVer.stdout}` : 'Bun not found',
    remediation: 'Install Bun (https://bun.sh)',
  });

  // 4. Node & NPM
  const nodeVer = runCmd('node --version');
  checks.push({
    id: 'node-runtime',
    name: 'Node.js Runtime (v20+)',
    category: 'core',
    status: nodeVer.ok ? 'PASS' : 'WARN',
    details: nodeVer.ok ? `node ${nodeVer.stdout}` : 'Node not found',
  });

  // 5. tmux
  const tmuxVer = runCmd('tmux -V');
  checks.push({
    id: 'tmux',
    name: 'tmux Session Backend',
    category: 'backend',
    status: tmuxVer.ok ? 'PASS' : 'FAIL',
    details: tmuxVer.stdout || 'tmux not found',
    remediation: 'sudo apt-get install -y tmux',
  });

  // 6. Oh My Pi (OMP)
  const ompVer = runCmd('omp --version');
  checks.push({
    id: 'omp-binary',
    name: 'Oh My Pi (OMP CLI)',
    category: 'backend',
    status: ompVer.ok ? 'PASS' : 'FAIL',
    details: ompVer.stdout || 'omp not found in PATH',
    remediation: 'bun add -g @oh-my-pi/pi-coding-agent@18.1.22',
  });

  // 7. Podman
  const podmanVer = runCmd('podman --version');
  checks.push({
    id: 'podman',
    name: 'Podman Container Engine',
    category: 'backend',
    status: podmanVer.ok ? 'PASS' : 'WARN',
    details: podmanVer.stdout || 'podman not found',
    remediation: 'sudo apt-get install -y podman',
  });

  // 8. Playwright / Chromium
  const pwVer = runCmd('bun x playwright --version');
  checks.push({
    id: 'playwright',
    name: 'Playwright Browser Engine',
    category: 'web',
    status: pwVer.ok ? 'PASS' : 'WARN',
    details: pwVer.stdout || 'Playwright CLI available',
  });

  // 9. Java JDK
  const javaVer = runCmd('java -version');
  checks.push({
    id: 'java-jdk',
    name: 'Java JDK (17+)',
    category: 'android',
    status: javaVer.ok ? 'PASS' : 'WARN',
    details: javaVer.stdout.split('\n')[0] || 'Java not found',
  });

  // 10. Android SDK & adb
  const androidHome = process.env.ANDROID_HOME || '/home/momodding/android-sdk';
  const adbCheck = runCmd(`${path.join(androidHome, 'platform-tools/adb')} version`);
  checks.push({
    id: 'android-sdk-adb',
    name: 'Android SDK & adb',
    category: 'android',
    status: adbCheck.ok ? 'PASS' : 'BLOCKED_ENVIRONMENT',
    details: adbCheck.ok ? adbCheck.stdout.split('\n')[0] : 'Android SDK/adb not found at $ANDROID_HOME',
    remediation: 'Export ANDROID_HOME pointing to valid Android SDK',
  });

  // 11. KVM Device & Acceleration
  const kvmStat = runCmd('ls -la /dev/kvm');
  const kvmTest = runCmd('[ -r /dev/kvm ] && [ -w /dev/kvm ] && echo OK || echo DENIED');
  const accelCheck = runCmd(`export ANDROID_HOME=${androidHome} && ${path.join(androidHome, 'emulator/emulator')} -accel-check`);
  const kvmUsable = kvmTest.stdout === 'OK' && !accelCheck.stdout.includes('ProbeKVM: This user');
  checks.push({
    id: 'kvm-acceleration',
    name: 'KVM Hardware Acceleration (/dev/kvm)',
    category: 'android',
    status: kvmUsable ? 'PASS' : 'BLOCKED_ENVIRONMENT',
    details: kvmUsable
      ? 'KVM acceleration active and writable'
      : `KVM blocked: /dev/kvm exists (${kvmStat.stdout.split(' ')[0]}) but user lacks permission (${accelCheck.stdout.split('\n')[0]})`,
    remediation: 'Add user to kvm group: sudo gpasswd -a $USER kvm and re-login',
  });

  // 12. Maestro CLI
  const maestroVer = runCmd('maestro --version');
  checks.push({
    id: 'maestro-cli',
    name: 'Maestro Mobile UI Test CLI',
    category: 'android',
    status: maestroVer.ok ? 'PASS' : 'BLOCKED_ENVIRONMENT',
    details: maestroVer.ok ? maestroVer.stdout : 'Maestro CLI not installed',
    remediation: 'curl -fsSL "https://get.maestro.mobile.dev" | bash',
  });

  // 13. Ports Check
  const testPorts = [8765, 8766, 8081, 19006, 5900];
  const portResults: string[] = [];
  for (const port of testPorts) {
    const free = await checkPortAvailable(port);
    portResults.push(`${port}: ${free ? 'FREE' : 'IN_USE'}`);
  }
  checks.push({
    id: 'test-ports',
    name: 'E2E Test Ports Availability',
    category: 'backend',
    status: portResults.every((p) => p.includes('FREE')) ? 'PASS' : 'WARN',
    details: portResults.join(', '),
  });

  const summary = {
    passed: checks.filter((c) => c.status === 'PASS').length,
    warned: checks.filter((c) => c.status === 'WARN').length,
    failed: checks.filter((c) => c.status === 'FAIL').length,
    blocked: checks.filter((c) => c.status === 'BLOCKED_ENVIRONMENT').length,
  };

  const report: DoctorReport = {
    timestamp: new Date().toISOString(),
    workspaceRoot: rootDir,
    checks,
    summary,
  };

  // Write artifacts
  fs.writeFileSync(path.join(artifactsDir, 'doctor-report.json'), JSON.stringify(report, null, 2));

  let txt = `=================================================================\n`;
  txt += `           AGENTIC-REMOTE E2E LAB DOCTOR REPORT                  \n`;
  txt += `=================================================================\n`;
  txt += `Timestamp: ${report.timestamp}\n`;
  txt += `Summary: ${summary.passed} PASS | ${summary.warned} WARN | ${summary.failed} FAIL | ${summary.blocked} BLOCKED\n\n`;

  for (const c of checks) {
    const icon = c.status === 'PASS' ? '[PASS]' : c.status === 'WARN' ? '[WARN]' : c.status === 'FAIL' ? '[FAIL]' : '[BLOCKED]';
    txt += `${icon.padEnd(10)} ${c.name.padEnd(35)} : ${c.details}\n`;
    if (c.remediation && c.status !== 'PASS') {
      txt += `           -> Remediation: ${c.remediation}\n`;
    }
  }
  fs.writeFileSync(path.join(artifactsDir, 'doctor-report.txt'), txt);

  return report;
}

if (import.meta.main) {
  runDoctor().then((report) => {
    console.log(`Doctor completed with ${report.summary.passed} passed, ${report.summary.blocked} blocked.`);
    if (report.summary.failed > 0) {
      process.exit(1);
    }
  });
}
