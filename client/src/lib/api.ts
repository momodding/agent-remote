import type {
  CreateSessionRequest,
  ErrorEnvelope,
  FileEntry,
  GitStatus,
  PairingPayload,
  ReadFileResponse,
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

export async function authenticatePairing(payload: PairingPayload, rawClientName: string, diagnostic: Diagnostics): Promise<PairedConnection> {
  const clientName = validateClientName(rawClientName);
  diagnostic('Resolving endpoint...');
  const endpoint = new URL(payload.endpoint);
  if (endpoint.protocol === 'https:') {
    diagnostic('Initiating TLS Handshake...');
    diagnostic(payload.skipFingerprintVerification ? 'Fingerprint verification skipped' : 'Validating Certificate Fingerprint...');
  }
  diagnostic('Executing Auth-v2 Challenge...');
  const clientNonce = newClientNonce();
  const token = await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(wsURL(payload.endpoint, '/v1/ws/sessions/bootstrap'));
    const fail = (error: unknown) => {
      socket.close();
      reject(error instanceof Error ? error : new Error('Connection failed'));
    };
    socket.onerror = () => fail(new Error('Connection failed'));
    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth.hello', pairingId: payload.pairingId, clientNonce, clientName }));
    socket.onmessage = async ({ data }) => {
      try {
        const frame = JSON.parse(String(data)) as Record<string, string>;
        if (frame.type === 'auth.challenge') {
          socket.send(
            JSON.stringify({
              type: 'auth.proof',
              pairingId: payload.pairingId,
              challengeId: frame.challengeId,
              proof: await clientProof(payload.token, payload.pairingId, frame.salt, clientNonce, frame.serverNonce, frame.challengeId),
            }),
          );
        } else if (frame.type === 'auth.ok') {
          socket.close();
          resolve(frame.sessionToken);
        } else if (frame.type === 'error') {
          fail(new Error(frame.message || 'Authentication failed'));
        }
      } catch (error) {
        fail(error);
      }
    };
  });
  diagnostic('Session Established');
  return { endpoint: payload.endpoint, fingerprint: payload.fingerprint, skipFingerprintVerification: payload.skipFingerprintVerification ?? false, token, clientName };
}
