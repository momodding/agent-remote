import { spawn, type ChildProcess, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';

export interface DaemonConfig {
  listenAddr: string;
  listenScheme: string;
  publicEndpoint: string;
  stateDir: string;
  workspaceRoot: string;
  uploadDir?: string;
  allowedCidrs?: string[];
  maxConnections?: number;
  maxSessions?: number;
  channelBufferSize?: number;
  allowDestructiveFiles?: boolean;
  skipFingerprintVerification?: boolean;
  pairingRotationSeconds?: number;
  pairingPageUsername?: string;
  pairingPagePassword?: string;
  terminalBackend?: string;
}

export interface PairingPayload {
  v: number;
  endpoint: string;
  fingerprint: string;
  pairingId: string;
  token: string;
  expiresAt: string;
  skipFingerprintVerification?: boolean;
}

export interface DaemonInstance {
  process: ChildProcess;
  pid: number;
  port: number;
  config: DaemonConfig;
  configPath: string;
  stateDir: string;
  workspaceDir: string;
  pairingPayload: PairingPayload;
  logs: string[];
  stop: () => Promise<void>;
  restart: () => Promise<DaemonInstance>;
}

export async function findFreePort(start = 18765): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(start, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : start;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      resolve(findFreePort(start + 1));
    });
  });
}

export function ensureDaemonBinary(): string {
  const repoRoot = path.resolve(__dirname, '../..');
  const binDir = path.join(repoRoot, 'builds/daemon/linux-amd64');
  const binPath = path.join(binDir, 'agenticRemote');

  if (!fs.existsSync(binPath)) {
    fs.mkdirSync(binDir, { recursive: true });
    console.log('[Backend] Compiling agenticRemote daemon...');
    execSync('cd backend && CGO_ENABLED=0 go build -o ../builds/daemon/linux-amd64/agenticRemote ./cmd/agenticRemote', {
      cwd: repoRoot,
      stdio: 'pipe',
      env: { ...process.env, GOFLAGS: '' },
    });
  }
  return binPath;
}

export async function spawnDaemon(options: {
  port?: number;
  workspaceDir?: string;
  strictIntegration?: boolean;
  pairingRotationSeconds?: number;
  skipFingerprint?: boolean;
}): Promise<DaemonInstance> {
  const repoRoot = path.resolve(__dirname, '../..');
  const binPath = ensureDaemonBinary();

  const port = options.port ?? (await findFreePort(18765));
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-e2e-'));
  const stateDir = path.join(tempBase, '.agenticremote');
  const workspaceDir = options.workspaceDir ?? path.join(tempBase, 'workspace');

  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  // Create test workspace files
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), '# E2E Test Workspace\n');
  fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'Hello agenticRemote E2E Lab\n');

  const config: DaemonConfig = {
    listenAddr: `127.0.0.1:${port}`,
    listenScheme: 'https',
    publicEndpoint: `https://127.0.0.1:${port}`,
    stateDir,
    workspaceRoot: workspaceDir,
    uploadDir: path.join(tempBase, 'uploads'),
    allowedCidrs: ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '192.168.0.0/16'],
    maxConnections: 16,
    maxSessions: 32,
    channelBufferSize: 256,
    allowDestructiveFiles: true,
    skipFingerprintVerification: options.skipFingerprint ?? false,
    pairingRotationSeconds: options.pairingRotationSeconds ?? 300,
    terminalBackend: 'tmux',
  };

  const configPath = path.join(tempBase, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const logs: string[] = [];
  let pairingPayload: PairingPayload | null = null;

  const env = {
    ...process.env,
    AGENTICREMOTE_STRICT_INTEGRATION: options.strictIntegration !== false ? '1' : '0',
  };

  const proc = spawn(binPath, ['serve', '--config', configPath], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pid = proc.pid ?? 0;

  proc.stdout?.on('data', (data) => {
    const text = data.toString();
    logs.push(text);
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}') && trimmed.includes('"pairingId"')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.pairingId && parsed.token) {
            pairingPayload = parsed as PairingPayload;
          }
        } catch {
          // ignore non-json
        }
      }
    }
  });

  proc.stderr?.on('data', (data) => {
    logs.push(data.toString());
  });

  // Wait for pairing payload and server readiness
  const start = Date.now();
  while (!pairingPayload && Date.now() - start < 10000) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!pairingPayload) {
    proc.kill('SIGKILL');
    throw new Error(`Daemon failed to emit pairing payload within 10s. Logs:\n${logs.join('')}`);
  }

  // Poll until HTTPS port is answering
  let ready = false;
  const readyTimeout = Date.now() + 5000;
  while (!ready && Date.now() < readyTimeout) {
    try {
      const res = await fetch(`https://127.0.0.1:${port}/healthz`, {
        headers: { Accept: 'application/json' },
      });
      if (res.status === 200 || res.status === 404) {
        ready = true;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const stop = async (): Promise<void> => {
    if (!proc.killed) {
      proc.kill('SIGTERM');
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve(undefined);
        }, 3000);
        proc.on('exit', () => {
          clearTimeout(timeout);
          resolve(undefined);
        });
      });
    }
    // Cleanup temporary directory if wanted
    try {
      if (fs.existsSync(tempBase)) {
        fs.rmSync(tempBase, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  };

  const restart = async (): Promise<DaemonInstance> => {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    return spawnDaemon({
      port,
      workspaceDir,
      strictIntegration: options.strictIntegration,
      pairingRotationSeconds: options.pairingRotationSeconds,
      skipFingerprint: options.skipFingerprint,
    });
  };

  return {
    process: proc,
    pid,
    port,
    config,
    configPath,
    stateDir,
    workspaceDir,
    pairingPayload,
    logs,
    stop,
    restart,
  };
}
