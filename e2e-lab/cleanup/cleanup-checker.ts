import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CleanupCheckResult {
  allClean: boolean;
  orphanedContainers: string[];
  legacyRootlessContainers: string[];
  orphanedNetwork: boolean;
  orphanedPairingFile: boolean;
  inspectionErrors: string[];
  orphanedDaemonPids: number[];
  orphanedOmpPids: number[];
  orphanedTmuxSessions: string[];
  orphanedEmulators: number[];
  orphanedPlaywrightProcesses: number[];
  orphanedWebServerPids: number[];
}

function compose(labDir: string, args: string[]): string {
  return execFileSync(path.join(labDir, 'scripts', 'compose.sh'), args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  });
}

function rootlessPodman(args: string[]): string {
  return execFileSync('podman', ['--remote=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  });
}


export function verifyE2eCleanup(labDir: string): CleanupCheckResult {
  const result: CleanupCheckResult = {
    allClean: true,
    orphanedContainers: [],
    orphanedNetwork: false,
    legacyRootlessContainers: [],
    orphanedPairingFile: false,
    inspectionErrors: [],
    orphanedDaemonPids: [],
    orphanedOmpPids: [],
    orphanedTmuxSessions: [],
    orphanedEmulators: [],
    orphanedPlaywrightProcesses: [],
    orphanedWebServerPids: [],
  };
  const inspectionError = (scope: string, error: unknown) => {
    result.inspectionErrors.push(`${scope}: ${error instanceof Error ? error.message : String(error)}`);
    result.allClean = false;
  };

  // 1. Compose owns the rootful project and limits this inspection to it.
  try {
    const services = JSON.parse(compose(labDir, ['ps', '--all', '--format', 'json'])) as unknown;
    if (!Array.isArray(services)) throw new Error('Compose ps returned a non-array JSON value');
    for (const service of services) {
      if (typeof service !== 'object' || service === null || !('Name' in service) || !('Labels' in service)) continue;
      const labels = service.Labels;
      const labelOwned = typeof labels === 'string'
        ? labels.split(',').includes('io.agent-remote.e2e=true')
        : typeof labels === 'object' && labels !== null && (labels as Record<string, unknown>)['io.agent-remote.e2e'] === 'true';
      if (typeof service.Name === 'string' && labelOwned) {
        result.orphanedContainers.push(service.Name);
      }
    }
    if (result.orphanedContainers.length > 0) result.allClean = false;
  } catch (error) {
    inspectionError('rootful Compose project inspection', error);
  }

  // 2. Rootless resources are read-only legacy contamination, not Compose-owned cleanup.
  try {
    const containers = rootlessPodman([
      'ps', '-a',
      '--filter', 'label=io.podman.compose.project=agent-remote-e2e',
      '--format', '{{.Names}}',
    ]).trim().split('\n').filter(Boolean);
    for (const name of ['agenticremote-provider', 'agenticremote-daemon']) {
      const match = rootlessPodman(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}']).trim();
      if (match) containers.push(match);
    }
    const seen: Record<string, true> = {};
    const legacyContainers = containers.filter((name) => {
      if (seen[name]) return false;
      seen[name] = true;
      return true;
    });
    if (legacyContainers.length > 0) {
      result.legacyRootlessContainers = legacyContainers;
      result.allClean = false;
    }
  } catch (error) {
    inspectionError('legacy rootless container inspection', error);
  }

  try {
    const network = rootlessPodman(['network', 'ls', '--filter', 'name=^agent-remote-e2e$', '--format', '{{.Name}}']).trim();
    if (network) {
      result.orphanedNetwork = true;
      result.allClean = false;
    }
  } catch (error) {
    inspectionError('legacy rootless network inspection', error);
  }

  // 3. This is a legacy rootless pairing artifact; current pairing stays in memory.
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
  } catch (error) {
    inspectionError('process inspection', error);
  }

  // 5. Check for test-created tmux sessions
  try {
    const tmuxSessions = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
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
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'status' in error && error.status === 1)) inspectionError('tmux session inspection', error);
  }

  return result;
}

if (import.meta.main) {
  const labDir = path.resolve(__dirname, '..');
  const result = verifyE2eCleanup(labDir);

  console.log('=== E2E Cleanup Verification ===');
  console.log(`Overall: ${result.allClean ? 'PASS' : 'FAIL'}`);

  if (result.orphanedContainers.length > 0) {
    console.log(`Rootful Compose orphan resources: ${result.orphanedContainers.join(', ')}`);
  }
  if (result.legacyRootlessContainers.length > 0) {
    console.log(`Read-only legacy rootless contamination (containers): ${result.legacyRootlessContainers.join(', ')}`);
  }
  if (result.orphanedNetwork) {
    console.log('Read-only legacy rootless contamination (network): agent-remote-e2e');
  }
  if (result.orphanedPairingFile) {
    console.log('Read-only legacy contamination (pairing file): .runtime/pairing.json');
  }
  if (result.inspectionErrors.length > 0) {
    console.log(`Read-only inspection failures: ${result.inspectionErrors.join('; ')}`);
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
