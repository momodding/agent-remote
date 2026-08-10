import type { PairingPayload } from '../protocol';

type ApiModule = typeof import('./api');

let mockPlatform = 'web';
jest.mock('react-native', () => ({ Platform: { get OS() { return mockPlatform; } } }));
// clientProof is mocked to keep auth-flow tests independent of the real crypto path.
jest.mock('./auth', () => ({
  clientProof: jest.fn(async () => 'mock-proof'),
  newClientNonce: jest.fn(() => 'mock-nonce'),
  validateClientName: jest.fn((raw: string) => raw.trim()),
}));

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];
  close = jest.fn();

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.onopen?.();
  }

  fail() {
    this.onerror?.();
  }

  closeAbnormally() {
    this.onclose?.();
  }

  message(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const originalWebSocket = globalThis.WebSocket;
const loadModule = (): ApiModule => require('./api') as ApiModule;

const payload: PairingPayload = {
  v: 2,
  endpoint: 'https://192.168.1.5:8765',
  fingerprint: 'sha256:abc',
  skipFingerprintVerification: true,
  pairingId: 'pair-1',
  token: 'secret-token',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

beforeEach(() => {
  MockWebSocket.instances = [];
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
});

describe('transport URLs', () => {
  it('preserves endpoint paths and upgrades only the WebSocket scheme', () => {
    const { apiURL, wsURL } = loadModule();
    expect(apiURL('https://daemon.example/', '/v1/sessions')).toBe('https://daemon.example/v1/sessions');
    expect(wsURL('https://daemon.example/', '/v1/ws/sessions/bootstrap')).toBe('wss://daemon.example/v1/ws/sessions/bootstrap');
    expect(wsURL('http://127.0.0.1:8765', '/v1/ws/sessions/id')).toBe('ws://127.0.0.1:8765/v1/ws/sessions/id');
  });
});


describe('authenticatePairing HTTPS transport', () => {
  const authOk = (socket: MockWebSocket) => {
    socket.open();
    socket.message({ type: 'auth.challenge', salt: 'c2FsdA', serverNonce: 'server-nonce', challengeId: 'chal-1' });
    socket.message({ type: 'auth.ok', sessionToken: 'session-token' });
  };

  const started = () => new Promise<void>((resolve) => setImmediate(resolve));

  let mockFetch: jest.Mock;
  beforeEach(() => {
    mockFetch = jest.fn().mockResolvedValue({ ok: true } as Response);
    Object.defineProperty(globalThis, 'fetch', { value: mockFetch, writable: true, configurable: true });
  });
  it('keeps local Android pairing on HTTPS/WSS', async () => {
    mockPlatform = 'android';
    const { authenticatePairing } = loadModule();
    const promise = authenticatePairing(payload, 'phone', jest.fn());
    await started();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe('wss://192.168.1.5:8765/v1/ws/sessions/bootstrap');
    authOk(MockWebSocket.instances[0]);
    const result = await promise;
    expect(result.endpoint).toBe('https://192.168.1.5:8765');
    expect(result.token).toBe('session-token');
  });

  it('rejects plaintext pairing endpoints', async () => {
    const { authenticatePairing } = loadModule();
    await expect(authenticatePairing({ ...payload, endpoint: 'http://192.168.1.5:8765' }, 'phone', jest.fn()))
      .rejects.toThrow('Pairing endpoint must use HTTPS');
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('forbidden_source from health probe surfaces CIDR guidance', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ code: 'forbidden_source', message: 'Client IP not in allowedCidrs' }),
    } as Response);
    const { authenticatePairing } = loadModule();
    await expect(authenticatePairing(payload, 'phone', jest.fn())).rejects.toThrow(/allowedCidrs must include your LAN subnet/);
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});
describe('authenticatePairing timeouts and terminal races', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn().mockResolvedValue({ ok: true } as Response);
    Object.defineProperty(globalThis, 'fetch', { value: mockFetch, writable: true, configurable: true });
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const flush = async () => {
    await Promise.resolve();
  };

  it('aborts a stuck health probe after 5 seconds', async () => {
    const response = Promise.withResolvers<Response>();
    let signal: AbortSignal | undefined;
    mockFetch.mockImplementation((_url, init: RequestInit) => {
      signal = init.signal ?? undefined;
      signal?.addEventListener('abort', () => response.reject(new DOMException('Aborted', 'AbortError')));
      return response.promise;
    });
    const { authenticatePairing } = loadModule();
    const promise = authenticatePairing(payload, 'phone', jest.fn());
    await flush();

    expect(signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(5000);
    expect(signal?.aborted).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(1);

    MockWebSocket.instances[0].fail();
    await expect(promise).rejects.toThrow('Connection failed');
  });

  it('rejects when no WebSocket connection opens within 8 seconds', async () => {
    const { authenticatePairing } = loadModule();
    const promise = authenticatePairing(payload, 'phone', jest.fn());
    await flush();

    const socket = MockWebSocket.instances[0];
    const rejected = expect(promise).rejects.toThrow('Connection timed out');
    await jest.advanceTimersByTimeAsync(8000);

    await rejected;
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps the handshake deadline after auth.challenge', async () => {
    const { authenticatePairing } = loadModule();
    const promise = authenticatePairing(payload, 'phone', jest.fn());
    await flush();

    const socket = MockWebSocket.instances[0];
    socket.open();
    await jest.advanceTimersByTimeAsync(7000);
    socket.message({ type: 'auth.challenge', salt: 'c2FsdA', serverNonce: 'server', challengeId: 'chal-1' });
    await flush();

    const rejected = expect(promise).rejects.toThrow('Connection timed out');
    await jest.advanceTimersByTimeAsync(1000);
    expect(socket.close).toHaveBeenCalledTimes(1);
    await rejected;
  });

  it('settles once when an error is followed by close and later frames', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation();
    const { authenticatePairing } = loadModule();
    const promise = authenticatePairing(payload, 'phone', jest.fn());
    await flush();

    const socket = MockWebSocket.instances[0];
    socket.fail();
    socket.closeAbnormally();
    socket.message({ type: 'auth.ok', sessionToken: 'late-token' });

    await expect(promise).rejects.toThrow('Connection failed');
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not send a proof that resolves after the auth timeout', async () => {
    const proof = Promise.withResolvers<string>();
    const mockedClientProof = require('./auth').clientProof as jest.Mock;
    mockedClientProof.mockImplementationOnce(() => proof.promise);
    const { authenticatePairing } = loadModule();
    const promise = authenticatePairing(payload, 'phone', jest.fn());
    await flush();

    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.message({ type: 'auth.challenge', salt: 'c2FsdA', serverNonce: 'server', challengeId: 'chal-1' });
    await flush();
    const rejected = expect(promise).rejects.toThrow('Connection timed out');
    await jest.advanceTimersByTimeAsync(8000);
    await rejected;

    proof.resolve('late-proof');
    await flush();
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toContain('auth.hello');
  });
});

