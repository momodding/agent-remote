import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Resolves a fresh, non-expired Auth-v2 pairing payload from daemon container, env, or .runtime/pairing.json.
 */
export function getRealPairingPayload(): string {
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      const output = execSync('podman logs agenticremote-daemon 2>&1 | grep -E "^{\\"v\\":2," | tail -n 1', {
        encoding: 'utf-8',
        timeout: 4000,
      }).trim();
      if (output) {
        try {
          const parsed = JSON.parse(output);
          if (parsed.expiresAt) {
            const expiresMs = new Date(parsed.expiresAt).getTime();
            const nowMs = Date.now();
            const remainingMs = expiresMs - nowMs;
            // Valid if remaining lifetime is at least 15 seconds
            if (remainingMs >= 15000) {
              return output;
            }
            // If expired or expiring soon, wait for daemon's 45s rotation timer
            execSync('sleep 3');
            continue;
          }
          return output;
        } catch {
          return output;
        }
      }
    } catch {
      // ignore
    }
  }
  const runtimeFile = path.join(__dirname, '../.runtime/pairing.json');
  if (fs.existsSync(runtimeFile)) {
    try {
      const fileContent = fs.readFileSync(runtimeFile, 'utf-8').trim();
      if (fileContent) return fileContent;
    } catch {
      // ignore
    }
  }
  if (process.env.E2E_REAL_PAIRING_PAYLOAD) {
    return process.env.E2E_REAL_PAIRING_PAYLOAD.trim();
  }
  return '';
}
