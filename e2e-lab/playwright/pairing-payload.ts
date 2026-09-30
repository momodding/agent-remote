import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const MINIMUM_PAIRING_LIFETIME_MS = 15_000;
const MAX_DAEMON_LOG_BYTES = 256 * 1024;

function currentAuthV2Payload(output: string): string {
  for (const line of output.split(/\r?\n/).reverse()) {
    const candidate = line.trim();
    if (!candidate) continue;

    try {
      const payload: unknown = JSON.parse(candidate);
      if (!payload || typeof payload !== 'object') continue;

      const authPayload = payload as { v?: unknown; expiresAt?: unknown };
      if (authPayload.v !== 2 || typeof authPayload.expiresAt !== 'string') continue;

      const expiresAt = Date.parse(authPayload.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt - Date.now() >= MINIMUM_PAIRING_LIFETIME_MS) {
        return candidate;
      }
    } catch {
      // Ignore non-payload daemon log lines.
    }
  }

  return '';
}

/** Resolves a fresh Auth-v2 pairing payload without persisting or logging it. */
export function getRealPairingPayload(): string {
  const suppliedPayload = process.env.E2E_REAL_PAIRING_PAYLOAD;
  if (suppliedPayload) {
    const currentPayload = currentAuthV2Payload(suppliedPayload);
    if (currentPayload) return currentPayload;
  }

  const composeScript = path.resolve(__dirname, '../scripts/compose.sh');
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      const output = execFileSync(composeScript, ['logs', 'daemon'], {
        encoding: 'utf-8',
        timeout: 4_000,
        maxBuffer: MAX_DAEMON_LOG_BYTES,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const currentPayload = currentAuthV2Payload(output);
      if (currentPayload) return currentPayload;
    } catch {
      // A topology may still be starting; retry without exposing its logs.
    }

    if (attempt < 24) {
      try {
        execFileSync('sleep', ['3'], { stdio: 'ignore' });
      } catch {
        break;
      }
    }
  }

  return '';
}
