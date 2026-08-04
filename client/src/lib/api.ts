import type {
  CreateSessionRequest,
  ErrorEnvelope,
  FileEntry,
  GitStatus,
  PairingPayload,
  ReadFileResponse,
  SessionSummary,
} from '../protocol';
import { Platform } from 'react-native';
import { clientProof, newClientNonce, validateClientName } from './auth';
import type { Connection, PairedConnection } from './connection';
export const wsURL = (endpoint: string, path: string) => `${endpoint.replace(/^http/, 'ws').replace(/\/$/, '')}${path}`;
export const apiURL = (endpoint: string, path: string) => `${endpoint.replace(/\/$/, '')}${path}`;

export class APIError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export class AgenticRemoteAPI {
  constructor(private readonly connection: Connection) {}

  async sessions(): Promise<SessionSummary[]> {
    return this.request('/v1/sessions');
  }

  async createSession(request: CreateSessionRequest): Promise<SessionSummary> {
    return this.request('/v1/sessions', { method: 'POST', body: JSON.stringify(request) });
  }

  async closeSession(id: string): Promise<void> {
    await this.request(`/v1/sessions/${encodeURIComponent(id)}/close`, { method: 'POST' });
  }

  async files(path = ''): Promise<FileEntry[]> {
    return (await this.request<{ entries: FileEntry[] }>(`/v1/fs/list?path=${encodeURIComponent(path)}`)).entries;
  }

  async searchFiles(path: string, query: string): Promise<FileEntry[]> {
    return (await this.request<{ entries: FileEntry[] }>(`/v1/fs/search?path=${encodeURIComponent(path)}&q=${encodeURIComponent(query)}`)).entries;
  }

  async readFile(path: string): Promise<ReadFileResponse> {
    return this.request(`/v1/fs/read?path=${encodeURIComponent(path)}`);
  }

  async writeFile(path: string, content: string, expectedSha256: string): Promise<ReadFileResponse> {
    return this.request('/v1/fs/write', { method: 'POST', body: JSON.stringify({ path, content, expectedSha256 }) });
  }

  async gitStatus(path = ''): Promise<GitStatus> {
    return this.request(`/v1/git/status?path=${encodeURIComponent(path)}`);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(apiURL(this.connection.endpoint, path), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.connection.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (response.status === 204) return undefined as T;
    const body = (await response.json()) as T | ErrorEnvelope;
    if (!response.ok) throw new APIError(response.status, (body as ErrorEnvelope).message || response.statusText);
    return body as T;
  }
}

export type Diagnostics = (message: string) => void;

// ponytail: /8, /16, /12, /10 etc. bit-boundary checks kept as plain integer math — no ip-address lib for four range checks.
export function isLocalHostname(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  if (host.endsWith('.local')) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    return (
      a === 127 ||
      (a === 169 && b === 254) ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.includes(':')) return /^fe[89ab][0-9a-f]:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host);
  return false;
}

// Retryable transport failure (pre-frame onerror/onclose) — distinct from protocol/auth failures, which never retry.
class TransportError extends Error {}

// Resolve the endpoint for auth attempt. On Android with local HTTPS + skip flag, resolve to HTTP directly.
export function resolveAuthEndpoint(
  advertised: string,
  platform: string,
  skipFingerprint: boolean,
  hostname: string,
): string {
  if (platform === 'android' && skipFingerprint && isLocalHostname(hostname)) {
    const url = new URL(advertised);
    if (url.protocol === 'https:') {
      url.protocol = 'http:';
      return url.toString().replace(/\/$/, '');
    }
  }
  return advertised;
}

// Health probe before WebSocket auth. Detects forbidden_source and other structured errors.
async function probeHealth(endpoint: string): Promise<null | { code: string; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(apiURL(endpoint, '/healthz'), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (response.ok) return null;
    const body = await response.json() as unknown;
    if (body && typeof body === 'object' && 'code' in body && 'message' in body) {
      return { code: (body as Record<string, string>).code, message: (body as Record<string, string>).message };
    }
    return null;
  } catch (error) {
    console.error('[pairing] health probe failed:', error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function attemptAuth(endpoint: string, payload: PairingPayload, clientName: string): Promise<string> {
  const clientNonce = newClientNonce();
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let frameReceived = false;
  let settled = false;
  let timeoutTimer = 0;
  const socket = new WebSocket(wsURL(endpoint, '/v1/ws/sessions/bootstrap'));
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    fn();
  };
  const fail = (error: unknown, retryable: boolean) => {
    const message = error instanceof Error ? error.message : 'Connection failed';
    settle(() => {
      socket.close();
      console.error('[pairing] attemptAuth failed:', message, 'retryable:', retryable);
      reject(retryable ? new TransportError(message) : new Error(message));
    });
  };

  timeoutTimer = setTimeout(() => fail(new Error('Connection timed out'), true), 8000);
  socket.onerror = () => fail(new Error('Connection failed'), !frameReceived);
  socket.onclose = () => fail(new Error('Connection closed'), !frameReceived);
  socket.onopen = () => {
    if (!settled) socket.send(JSON.stringify({ type: 'auth.hello', pairingId: payload.pairingId, clientNonce, clientName }));
  };
  socket.onmessage = async ({ data }) => {
    if (settled) return;
    frameReceived = true;
    let frame: Record<string, string>;
    try {
      frame = JSON.parse(String(data)) as Record<string, string>;
    } catch (error) {
      fail(error, false);
      return;
    }
    try {
      if (frame.type === 'auth.challenge') {
        const proof = await clientProof(payload.token, payload.pairingId, frame.salt, clientNonce, frame.serverNonce, frame.challengeId);
        if (!settled) {
          socket.send(JSON.stringify({
            type: 'auth.proof',
            pairingId: payload.pairingId,
            challengeId: frame.challengeId,
            proof,
          }));
        }
      } else if (frame.type === 'auth.ok') {
        settle(() => { socket.close(); resolve(frame.sessionToken); });
      } else if (frame.type === 'error') {
        fail(new Error(frame.message || 'Authentication failed'), false);
      }
    } catch (error) {
      fail(error, false);
    }
  };
  return promise;
}

export async function authenticatePairing(payload: PairingPayload, rawClientName: string, diagnostic: Diagnostics): Promise<PairedConnection> {
  const clientName = validateClientName(rawClientName);
  const advertisedURL = new URL(payload.endpoint);
  diagnostic('Resolving endpoint...');

  // Resolve endpoint: Android + local + skip = HTTP directly, no TLS attempt first.
  const resolvedEndpoint = resolveAuthEndpoint(
    payload.endpoint,
    Platform.OS,
    payload.skipFingerprintVerification === true,
    advertisedURL.hostname,
  );
  const isDirectHTTP = resolvedEndpoint !== payload.endpoint;

  if (advertisedURL.protocol === 'https:') {
    diagnostic(isDirectHTTP ? 'Direct cleartext HTTP for local pairing' : 'Initiating TLS Handshake...');
    diagnostic(payload.skipFingerprintVerification ? 'Fingerprint verification skipped' : 'Validating Certificate Fingerprint...');
  }

  // Health probe before WebSocket to surface forbidden_source and other errors.
  const healthError = await probeHealth(resolvedEndpoint);
  if (healthError) {
    if (healthError.code === 'forbidden_source') {
      throw new Error(
        `Pairing not available from this network. Daemon allowedCidrs must include your LAN subnet. ` +
        `Current error: ${healthError.message}`,
      );
    }
    throw new Error(`Pairing unavailable: ${healthError.code} - ${healthError.message}`);
  }

  diagnostic('Executing Auth-v2 Challenge...');
  let token: string;
  try {
    token = await attemptAuth(resolvedEndpoint, payload, clientName);
  } catch (error) {
    // On Android with advertised HTTPS→HTTP fallback eligible, retry once more with HTTP.
    const canFallback =
      Platform.OS === 'android' &&
      advertisedURL.protocol === 'https:' &&
      payload.skipFingerprintVerification === true &&
      isLocalHostname(advertisedURL.hostname) &&
      !isDirectHTTP; // Only fallback if we didn't already select HTTP

    if (!canFallback || !(error instanceof TransportError)) throw error;
    diagnostic('Secure transport unavailable; retrying direct LAN over HTTP...');
    const fallbackEndpoint = new URL(payload.endpoint);
    fallbackEndpoint.protocol = 'http:';
    const fallbackStr = fallbackEndpoint.toString().replace(/\/$/, '');
    try {
      token = await attemptAuth(fallbackStr, payload, clientName);
    } catch {
      throw new Error(`Connection failed on both ${payload.endpoint} and ${fallbackStr}`);
    }
  }

  diagnostic('Session Established');
  return { endpoint: resolvedEndpoint, fingerprint: payload.fingerprint, skipFingerprintVerification: payload.skipFingerprintVerification ?? false, token, clientName };
}
