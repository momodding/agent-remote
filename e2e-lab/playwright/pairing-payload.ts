import * as path from "node:path";
import { execFileSync } from "node:child_process";

const MINIMUM_PAIRING_LIFETIME_MS = 15_000;
const MAX_DAEMON_LOG_BYTES = 10 * 1024 * 1024;

function currentAuthV2Payload(output: string): string {
  for (const line of output.split(/\r?\n/).reverse()) {
    const candidate = line.trim();
    if (!candidate) continue;

    const jsonStart = candidate.indexOf("{");
    if (jsonStart === -1) continue;

    const rawPayload = candidate.slice(jsonStart);
    try {
      const payload: unknown = JSON.parse(rawPayload);
      if (
        !payload ||
        typeof payload !== "object" ||
        !("v" in payload) ||
        !("expiresAt" in payload)
      )
        continue;
      if (payload.v !== 2 || typeof payload.expiresAt !== "string") continue;

      const expiresAt = Date.parse(payload.expiresAt);
      if (
        Number.isFinite(expiresAt) &&
        expiresAt - Date.now() >= MINIMUM_PAIRING_LIFETIME_MS
      ) {
        return rawPayload;
      }
    } catch {
      // Ignore non-payload daemon log lines.
    }
  }

  return "";
}

function applyTestEndpointOverride(rawPayload: string): string {
  const endpoint = process.env.E2E_REAL_PAIRING_ENDPOINT;
  if (!endpoint) return rawPayload;

  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("E2E_REAL_PAIRING_ENDPOINT must be an HTTPS origin without credentials or a path");
  }

  const payload: unknown = JSON.parse(rawPayload);
  if (!payload || typeof payload !== "object" || !("endpoint" in payload)) {
    throw new Error("Current Auth-v2 pairing payload has no endpoint");
  }

  return JSON.stringify({ ...payload, endpoint: url.origin });
}

/** Resolves a fresh Auth-v2 pairing payload without persisting or logging it. */
export function getRealPairingPayload(): string {
  const suppliedPayload = process.env.E2E_REAL_PAIRING_PAYLOAD;
  if (suppliedPayload) {
    const currentPayload = currentAuthV2Payload(suppliedPayload);
    if (currentPayload) return applyTestEndpointOverride(currentPayload);
  }

  const composeScript = path.resolve(__dirname, "../scripts/compose.sh");
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      const output = execFileSync(
        composeScript,
        ["logs", "--tail", "5000", "daemon"],
        {
          encoding: "utf-8",
          timeout: 15_000,
          maxBuffer: MAX_DAEMON_LOG_BYTES,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const currentPayload = currentAuthV2Payload(output);
      if (currentPayload) return applyTestEndpointOverride(currentPayload);
    } catch {
      // A topology may still be starting; retry without exposing its logs.
    }

    if (attempt < 24) {
      try {
        execFileSync("sleep", ["3"], { stdio: "ignore" });
      } catch {
        break;
      }
    }
  }

  return "";
}
