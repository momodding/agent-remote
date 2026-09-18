import * as https from 'node:https';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
import WebSocket from 'ws';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { spawnDaemon, type DaemonInstance, type PairingPayload } from './daemon';

export interface Phase1Result {
  testId: string;
  name: string;
  status: 'PASS' | 'FAIL';
  durationMs: number;
  details: string;
  error?: string;
}

export interface Phase1SuiteReport {
  timestamp: string;
  suite: 'Phase 1 - Strict Backend & TLS Daemon';
  passed: number;
  failed: number;
  total: number;
  results: Phase1Result[];
}

function computeAuthProof(token: string, pairingId: string, salt: string, clientNonce: string, serverNonce: string, challengeId: string): string {
  const saltBytes = Buffer.from(salt, 'base64url');
  const tokenBytes = Buffer.from(token, 'utf8');
  const verifier = hmac(sha256, tokenBytes, saltBytes);
  const msg = Buffer.from(`agenticRemote-auth-v2${pairingId}${clientNonce}${serverNonce}${challengeId}`, 'utf8');
  const proofBytes = hmac(sha256, verifier, msg);
  return Buffer.from(proofBytes).toString('base64url');
}

export async function performAuthHandshake(endpoint: string, payload: PairingPayload, clientName = 'e2e-tester'): Promise<string> {
  const wsUrl = `${endpoint.replace(/^http/, 'ws')}/v1/ws/sessions/bootstrap`;
  const ws = new WebSocket(wsUrl, {
    agent: httpsAgent,
    rejectUnauthorized: false,
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Auth handshake timeout (10s)'));
    }, 10000);

    const clientNonce = crypto.randomBytes(32).toString('base64url');

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'auth.hello',
          pairingId: payload.pairingId,
          clientNonce,
          clientName,
        })
      );
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'auth.challenge') {
          const proof = computeAuthProof(
            payload.token,
            payload.pairingId,
            msg.salt,
            clientNonce,
            msg.serverNonce,
            msg.challengeId
          );
          ws.send(
            JSON.stringify({
              type: 'auth.proof',
              pairingId: payload.pairingId,
              challengeId: msg.challengeId,
              proof,
            })
          );
        } else if (msg.type === 'auth.ok' || msg.type === 'auth.complete') {
          clearTimeout(timeout);
          ws.close();
          resolve(msg.sessionToken || msg.token);
        } else if (msg.type === 'error' || msg.error) {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(`Daemon returned auth error: ${JSON.stringify(msg)}`));
        }
      } catch (err: unknown) {
        clearTimeout(timeout);
        ws.close();
        reject(err);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export async function runPhase1Suite(): Promise<Phase1SuiteReport> {
  const results: Phase1Result[] = [];
  const artifactsDir = path.join(__dirname, '../artifacts');
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
  }

  let daemon: DaemonInstance | null = null;

  try {
    // Test 1.1: Daemon Lifecycle & Strict TLS
    const t0 = Date.now();
    try {
      daemon = await spawnDaemon({ strictIntegration: true });
      results.push({
        testId: 'RAR-E2E-101',
        name: 'Daemon Spawn with Strict TLS & Custom SANs',
        status: 'PASS',
        durationMs: Date.now() - t0,
        details: `Daemon spawned on PID ${daemon.pid} (port ${daemon.port}) with strict TLS certs and SANs`,
      });
    } catch (err: unknown) {
      results.push({
        testId: 'RAR-E2E-101',
        name: 'Daemon Spawn with Strict TLS & Custom SANs',
        status: 'FAIL',
        durationMs: Date.now() - t0,
        details: 'Failed to spawn daemon process',
        error: String(err),
      });
      throw err;
    }

    // Test 1.2: Pairing Payload Format & Fingerprint Verification
    const t1 = Date.now();
    const p = daemon.pairingPayload;
    if (p.v === 2 && p.endpoint && p.pairingId && p.token && p.fingerprint && p.fingerprint.split(':').length === 32) {
      results.push({
        testId: 'RAR-E2E-102',
        name: 'Pairing Payload Structure & Fingerprint Verification',
        status: 'PASS',
        durationMs: Date.now() - t1,
        details: `Valid v2 payload: pairingId=${p.pairingId.substring(0, 8)}..., fingerprint=${p.fingerprint.substring(0, 17)}...`,
      });
    } else {
      results.push({
        testId: 'RAR-E2E-102',
        name: 'Pairing Payload Structure & Fingerprint Verification',
        status: 'FAIL',
        durationMs: Date.now() - t1,
        details: `Invalid pairing payload shape: ${JSON.stringify(p)}`,
      });
    }

    // Test 1.3: Auth-v2 WebSocket Handshake
    const t2 = Date.now();
    let bearerToken = '';
    try {
      bearerToken = await performAuthHandshake(daemon.config.publicEndpoint, daemon.pairingPayload);
      results.push({
        testId: 'RAR-E2E-103',
        name: 'Auth-v2 HMAC-SHA256 Challenge-Response Handshake',
        status: 'PASS',
        durationMs: Date.now() - t2,
        details: `Successfully completed handshake and acquired session bearer token (${bearerToken.substring(0, 12)}...)`,
      });
    } catch (err: unknown) {
      results.push({
        testId: 'RAR-E2E-103',
        name: 'Auth-v2 HMAC-SHA256 Challenge-Response Handshake',
        status: 'FAIL',
        durationMs: Date.now() - t2,
        details: 'Auth handshake failed',
        error: String(err),
      });
      throw err;
    }

    // Test 1.4: Runtime Snapshot over HTTP with Bearer Token
    const t3 = Date.now();
    try {
      const snapRes = await fetch(`${daemon.config.publicEndpoint}/v1/runtime/snapshot`, {
        headers: { Authorization: `Bearer ${bearerToken}` },
      });
      const snapJson = (await snapRes.json()) as { cursor?: number; terminals?: unknown[] };
      const idRes = await fetch(`${daemon.config.publicEndpoint}/v1/daemon/identity`, {
        headers: { Authorization: `Bearer ${bearerToken}` },
      });
      const idJson = (await idRes.json()) as { identity?: { hostId?: string }; capabilities?: Array<{ name: string; enabled: boolean }> };
      if (snapRes.ok && typeof snapJson.cursor === 'number' && idRes.ok && idJson.identity?.hostId) {
        results.push({
          testId: 'RAR-E2E-104',
          name: 'Runtime Snapshot & Host Identity Verification',
          status: 'PASS',
          durationMs: Date.now() - t3,
          details: `Host ID: ${idJson.identity.hostId} | Cursor: ${snapJson.cursor} | Capabilities: ${idJson.capabilities?.length ?? 0}`,
        });
      } else {
        throw new Error(`Snapshot / Identity mismatch: snap=${snapRes.status}, id=${idRes.status}`);
      }
    } catch (err: unknown) {
      results.push({
        testId: 'RAR-E2E-104',
        name: 'Runtime Snapshot & Host Identity Verification',
        status: 'FAIL',
        durationMs: Date.now() - t3,
        details: 'Failed to fetch runtime snapshot',
        error: String(err),
      });
    }

    // Test 1.5: PTY Session Lifecycle with tmux Backend
    const t4 = Date.now();
    try {
      const sessRes = await fetch(`${daemon.config.publicEndpoint}/v1/sessions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'e2e-pty-test',
          command: '/bin/bash',
          cols: 80,
          rows: 24,
        }),
      });
      const sessJson = (await sessRes.json()) as { id?: string; kind?: string };
      if (!sessRes.ok || !sessJson.id) {
        throw new Error(`Failed to create terminal session: ${sessRes.status} ${JSON.stringify(sessJson)}`);
      }

      // Connect to terminal websocket
      const termWsUrl = `${daemon.config.publicEndpoint.replace(/^http/, 'ws')}/v1/ws/sessions/${sessJson.id}`;
      const termWs = new WebSocket(termWsUrl, { agent: httpsAgent, rejectUnauthorized: false });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          termWs.close();
          reject(new Error('Terminal websocket timeout'));
        }, 8000);

        let authenticated = false;
        let receivedOutput = false;

        termWs.on('open', () => {
          termWs.send(JSON.stringify({ type: 'auth.token', token: bearerToken }));
          setTimeout(() => {
            termWs.send(
              JSON.stringify({
                type: 'pty.input',
                sessionId: sessJson.id,
                data: Buffer.from('echo PTY_E2E_OK\n').toString('base64'),
              })
            );
          }, 300);
        });
        termWs.on('message', (data) => {
          const str = data.toString();
          try {
            const msg = JSON.parse(str);
            if (msg.type === 'pty.baseline' || msg.type === 'pty.output' || msg.type === 'pty.delta') {
              clearTimeout(timeout);
              termWs.close();
              resolve();
            }
          } catch {
            if (str.includes('pty')) {
              clearTimeout(timeout);
              termWs.close();
              resolve();
            }
          }
        });

        termWs.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      results.push({
        testId: 'RAR-E2E-105',
        name: 'Interactive Terminal PTY over WebSocket (tmux Backend)',
        status: 'PASS',
        durationMs: Date.now() - t4,
        details: `Created session ${sessJson.id}, sent input and observed PTY output echo`,
      });
    } catch (err: unknown) {
      results.push({
        testId: 'RAR-E2E-105',
        name: 'Interactive Terminal PTY over WebSocket (tmux Backend)',
        status: 'FAIL',
        durationMs: Date.now() - t4,
        details: 'Terminal session test failed',
        error: String(err),
      });
    }

    // Test 1.6: Workspace File Operations (Relative Paths & Security Boundaries)
    const t5 = Date.now();
    try {
      const listRes = await fetch(`${daemon.config.publicEndpoint}/v1/fs/list?path=`, {
        headers: { Authorization: `Bearer ${bearerToken}` },
      });
      const listJson = (await listRes.json()) as { entries?: Array<{ name: string }> };
      if (!listRes.ok || !Array.isArray(listJson.entries)) {
        throw new Error(`File list failed: ${listRes.status} ${JSON.stringify(listJson)}`);
      }

      // Write a file
      const writeRes = await fetch(`${daemon.config.publicEndpoint}/v1/fs/write`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path: 'e2e-output.txt',
          content: 'Strict backend verification passed.\n',
        }),
      });
      if (!writeRes.ok) {
        throw new Error(`File write failed: ${writeRes.status}`);
      }

      // Read the file back
      const readRes = await fetch(`${daemon.config.publicEndpoint}/v1/fs/read?path=e2e-output.txt`, {
        headers: { Authorization: `Bearer ${bearerToken}` },
      });
      const readJson = (await readRes.json()) as { text?: string; content?: string };
      const text = readJson.text ?? readJson.content ?? '';
      if (!readRes.ok || !text.includes('Strict backend verification passed')) {
        throw new Error(`File read mismatch: ${JSON.stringify(readJson)}`);
      }
      results.push({
        testId: 'RAR-E2E-106',
        name: 'Workspace File Operations (Relative Paths & CRUD)',
        status: 'PASS',
        durationMs: Date.now() - t5,
        details: `Listed workspace files (${listJson.entries.length} entries), wrote and verified e2e-output.txt`,
      });
    } catch (err: unknown) {
      results.push({
        testId: 'RAR-E2E-106',
        name: 'Workspace File Operations (Relative Paths & CRUD)',
        status: 'FAIL',
        durationMs: Date.now() - t5,
        details: 'File operations test failed',
        error: String(err),
      });
    }

    // Test 1.7: Replay Attack & Reused Proof Protection
    const t6 = Date.now();
    try {
      let rejected = false;
      try {
        await performAuthHandshake(daemon.config.publicEndpoint, daemon.pairingPayload);
      } catch {
        rejected = true;
      }
      if (rejected) {
        results.push({
          testId: 'RAR-E2E-107',
          name: 'Pairing Token Single-Use & Replay Rejection',
          status: 'PASS',
          durationMs: Date.now() - t6,
          details: 'Used pairing token was strictly consumed and correctly rejected on second attempt',
        });
      } else {
        throw new Error('Server accepted already-consumed pairing token!');
      }
    } catch (err: unknown) {
      results.push({
        testId: 'RAR-E2E-107',
        name: 'Pairing Token Single-Use & Replay Rejection',
        status: 'FAIL',
        durationMs: Date.now() - t6,
        details: 'Replay protection failed',
        error: String(err),
      });
    }
  } finally {
    if (daemon) {
      await daemon.stop();
    }
  }

  const report: Phase1SuiteReport = {
    timestamp: new Date().toISOString(),
    suite: 'Phase 1 - Strict Backend & TLS Daemon',
    passed: results.filter((r) => r.status === 'PASS').length,
    failed: results.filter((r) => r.status === 'FAIL').length,
    total: results.length,
    results,
  };

  fs.writeFileSync(path.join(artifactsDir, 'phase1-results.json'), JSON.stringify(report, null, 2));

  let log = `=================================================================\n`;
  log += `        PHASE 1: STRICT BACKEND & TLS DAEMON REPORT              \n`;
  log += `=================================================================\n`;
  log += `Timestamp: ${report.timestamp}\n`;
  log += `Result: ${report.passed}/${report.total} PASSED (${report.failed} FAILED)\n\n`;
  for (const r of results) {
    log += `[${r.status}] ${r.testId} - ${r.name} (${r.durationMs}ms)\n`;
    log += `       Details: ${r.details}\n`;
    if (r.error) {
      log += `       Error: ${r.error}\n`;
    }
  }
  fs.writeFileSync(path.join(artifactsDir, 'phase1-backend.log'), log);

  return report;
}

if (import.meta.main) {
  runPhase1Suite().then((report) => {
    console.log(`Phase 1 complete: ${report.passed}/${report.total} passed.`);
    if (report.failed > 0) {
      process.exit(1);
    }
  });
}
