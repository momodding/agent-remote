import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CleanupCheckResult {
  allClean: boolean;
  orphanedContainers: string[];
  orphanedNetwork: boolean;
  orphanedPairingFile: boolean;
  orphanedDaemonPids: number[];
  orphanedOmpPids: number[];
  orphanedTmuxSessions: string[];
  orphanedEmulators: number[];
  orphanedPlaywrightProcesses: number[];
  orphanedWebServerPids: number[];
}

function podman(labDir: string, args: string[]): string {
  return execFileSync(path.join(labDir, 'scripts', 'podman.sh'), args, {
    encoding: 'utf8',
    env: { ...process.env, E2E_PODMAN_NO_FALLBACK_CREATE: '1' },
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  });
}

export function verifyE2eCleanup(labDir: string): CleanupCheckResult {
  const result: CleanupCheckResult = {
    allClean: true,
    orphanedContainers: [],
    orphanedNetwork: false,
    orphanedPairingFile: false,
    orphanedDaemonPids: [],
    orphanedOmpPids: [],
    orphanedTmuxSessions: [],
    orphanedEmulators: [],
    orphanedPlaywrightProcesses: [],
    orphanedWebServerPids: [],
  };

  // 1. Check Podman containers by exact name
  const androidDigest = fs.readFileSync(path.join(labDir, 'env/versions.env'), 'utf8').match(/^export ANDROID_IMAGE_DIGEST="([^"]+)"/m)?.[1];
  const containerNames = ['agenticremote-provider', 'agenticremote-daemon'];
  try {
    const containers = podman(labDir, ['ps', '-a', '--format', '{{.Names}}'])
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const name of containerNames) {
      if (containers.includes(name)) {
        result.orphanedContainers.push(name);
        result.allClean = false;
      }
    }
    if (androidDigest) {
      const androidContainers = podman(labDir, ['ps', '-a', '--filter', 'label=io.agent-remote.e2e=true', '--filter', 'label=io.agent-remote.role=android', '--filter', `label=io.agent-remote.image-digest=${androidDigest}`, '--format', '{{.Names}}'])
        .trim()
        .split('\n')
        .filter(Boolean);
      for (const name of androidContainers) if (!result.orphanedContainers.includes(name)) result.orphanedContainers.push(name);
      if (androidContainers.length > 0) result.allClean = false;
    }
  } catch {}

  // 2. Check Podman network by exact name
  try {
    const networks = podman(labDir, ['network', 'ls', '--format', '{{.Name}}'])
      .trim()
      .split('\n')
      .filter(Boolean);
    if (networks.includes('agent-remote-e2e')) {
      result.orphanedNetwork = true;
      result.allClean = false;
    }
  } catch {}

  // 3. Check pairing.json file
  const pairingJsonPath = path.join(labDir, '.runtime', 'pairing.json');
  if (fs.existsSync(pairingJsonPath)) {
    result.orphanedPairingFile = true;
    result.allClean = false;
  }

  // 4. Check for test-owned daemon and OMP PIDs
  try {
    const psOut = execSync('ps -eo pid,args', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const lines = psOut.split('\n');
    for (const line of lines) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const cmd = match[2];

      // Match test daemon processes (cmd/agenticRemote or tests)
      if (cmd.includes('agenticRemote') && (cmd.includes('/tmp/Test') || cmd.includes('e2e-lab/.runtime'))) {
        result.orphanedDaemonPids.push(pid);
        result.allClean = false;
      }

      // Match test-owned OMP processes spawned in test directories or agent workspaces
      if (cmd.startsWith('omp ') || cmd.includes('/omp ')) {
        if (cmd.includes('/tmp/Test') || cmd.includes('.agenticremote') || cmd.includes('e2e-lab')) {
          result.orphanedOmpPids.push(pid);
          result.allClean = false;
        }
      }

      // Match test-owned emulator instances (e.g. omp_verify AVD)
      if ((cmd.includes('emulator') || cmd.includes('qemu-system')) && cmd.includes('omp_verify')) {
        result.orphanedEmulators.push(pid);
        result.allClean = false;
      }

      // Match test-owned Playwright runners
      if (cmd.includes('@playwright/test') && cmd.includes('e2e-lab')) {
        result.orphanedPlaywrightProcesses.push(pid);
        result.allClean = false;
      }

      // Match the test-owned exported web server.
      if (cmd.includes('web/static-server.ts') && cmd.includes(labDir)) {
        result.orphanedWebServerPids.push(pid);
        result.allClean = false;
      }
    }
  } catch {}

  // 5. Check for test-created tmux sessions
  try {
    const tmuxSessions = execSync('tmux list-sessions -F #{session_name} 2>/dev/null || true', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    const testSessions = tmuxSessions.filter((s) => s.startsWith('agent_') || s.startsWith('TestOMP_') || s.startsWith('TestGoldenFlow_'));
    if (testSessions.length > 0) {
      result.orphanedTmuxSessions = testSessions;
      result.allClean = false;
    }
  } catch {}

  return result;
}

if (import.meta.main) {
  const labDir = path.resolve(__dirname, '..');
  const result = verifyE2eCleanup(labDir);

  console.log('=== E2E Cleanup Verification ===');
  console.log(`Overall: ${result.allClean ? 'PASS' : 'FAIL'}`);

  if (result.orphanedContainers.length > 0) {
    console.log(`Orphaned Podman containers: ${result.orphanedContainers.join(', ')}`);
  }
  if (result.orphanedNetwork) {
    console.log(`Orphaned Podman network: agent-remote-e2e`);
  }
  if (result.orphanedPairingFile) {
    console.log(`Orphaned pairing file: .runtime/pairing.json`);
  }
  if (result.orphanedDaemonPids.length > 0) {
    console.log(`Orphaned daemon PIDs: ${result.orphanedDaemonPids.join(', ')}`);
  }
  if (result.orphanedOmpPids.length > 0) {
    console.log(`Orphaned OMP PIDs: ${result.orphanedOmpPids.join(', ')}`);
  }
  if (result.orphanedTmuxSessions.length > 0) {
    console.log(`Orphaned tmux sessions: ${result.orphanedTmuxSessions.join(', ')}`);
  }
  if (result.orphanedEmulators.length > 0) {
    console.log(`Orphaned emulator PIDs: ${result.orphanedEmulators.join(', ')}`);
  }
  if (result.orphanedPlaywrightProcesses.length > 0) {
    console.log(`Orphaned Playwright PIDs: ${result.orphanedPlaywrightProcesses.join(', ')}`);
  }
  if (result.orphanedWebServerPids.length > 0) {
    console.log(`Orphaned web server PIDs: ${result.orphanedWebServerPids.join(', ')}`);
  }

  if (!result.allClean) {
    process.exit(1);
  }
}
