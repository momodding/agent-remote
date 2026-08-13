import type {
  CopyFileRequest,
  CreateSessionRequest,
  ErrorEnvelope,
  FileEntry,
  GitStatus,
  ListShellsResponse,
  PairingPayload,
  ReadFileResponse,
  RenameFileRequest,
  SessionSummary,
} from '../protocol';
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

  async renameFile(path: string, newPath: string): Promise<void> {
    const body: RenameFileRequest = { path, newPath };
    await this.request('/v1/fs/rename', { method: 'POST', body: JSON.stringify(body) });
  }

  async copyFile(path: string, newPath: string): Promise<void> {
    const body: CopyFileRequest = { path, newPath };
    await this.request('/v1/fs/copy', { method: 'POST', body: JSON.stringify(body) });
  }

  downloadRequest(path: string): { url: string; headers: Record<string, string> } {
    return {
      url: apiURL(this.connection.endpoint, `/v1/fs/download?path=${encodeURIComponent(path)}`),
      headers: { Authorization: `Bearer ${this.connection.token}` },
    };
  }

  async gitStatus(path = ''): Promise<GitStatus> {
    return this.request(`/v1/git/status?path=${encodeURIComponent(path)}`);
  }

  async shells(): Promise<string[]> {
    return (await this.request<ListShellsResponse>('/v1/shells')).shells;
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
  let settled = false;
  let timeoutTimer = 0;
  const socket = new WebSocket(wsURL(endpoint, '/v1/ws/sessions/bootstrap'));
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    fn();
  };
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Connection failed';
    settle(() => {
      socket.close();
      console.error('[pairing] attemptAuth failed:', message);
      reject(new Error(message));
    });
  };

  timeoutTimer = setTimeout(() => fail(new Error('Connection timed out')), 8000);
  socket.onerror = () => fail(new Error('Connection failed'));
  socket.onclose = () => fail(new Error('Connection closed'));
  socket.onopen = () => {
    if (!settled) socket.send(JSON.stringify({ type: 'auth.hello', pairingId: payload.pairingId, clientNonce, clientName }));
  };
  socket.onmessage = async ({ data }) => {
    if (settled) return;
    let frame: Record<string, string>;
    try {
      frame = JSON.parse(String(data)) as Record<string, string>;
    } catch (error) {
      fail(error);
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
        fail(new Error(frame.message || 'Authentication failed'));
      }
    } catch (error) {
      fail(error);
    }
  };
  return promise;
}

export async function authenticatePairing(payload: PairingPayload, rawClientName: string, diagnostic: Diagnostics): Promise<PairedConnection> {
  const clientName = validateClientName(rawClientName);
  const endpoint = new URL(payload.endpoint).origin;
  if (!endpoint.startsWith('https://')) throw new Error('Pairing endpoint must use HTTPS');
  diagnostic('Resolving endpoint...');
  diagnostic('Initiating TLS Handshake...');
  diagnostic(payload.skipFingerprintVerification ? 'Using platform TLS trust' : 'Validating Certificate Fingerprint...');

  const healthError = await probeHealth(endpoint);
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
  const token = await attemptAuth(endpoint, payload, clientName);
  diagnostic('Session Established');
  return { endpoint, fingerprint: payload.fingerprint, skipFingerprintVerification: payload.skipFingerprintVerification ?? false, token, clientName };
}
