import type { PairingPayload } from '../protocol';

type ApiModule = typeof import('./api');

let mockPlatform = 'web';
jest.mock('react-native', () => ({ Platform: { OS: mockPlatform } }));
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
  jest.resetModules();
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

describe('isLocalHostname', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['printer.local', true],
    ['127.0.0.1', true],
    ['169.254.1.1', true],
    ['10.0.0.5', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['100.64.0.1', true],
    ['100.127.255.255', true],
    ['::1', true],
    ['[::1]', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['8.8.8.8', false],
    ['172.32.0.1', false],
    ['172.15.0.1', false],
    ['100.128.0.1', false],
    ['daemon.example.com', false],
    ['2001:db8::1', false],
  ])('%s -> %s', (host, expected) => {
    const { isLocalHostname } = loadModule();
    expect(isLocalHostname(host)).toBe(expected);
  });
});

describe('resolveAuthEndpoint', () => {
  it('resolves Android local HTTPS + skip to HTTP', () => {
    const { resolveAuthEndpoint } = loadModule();
    const resolved = resolveAuthEndpoint('https://192.168.1.5:8765', 'android', true, '192.168.1.5');
    expect(resolved).toBe('http://192.168.1.5:8765');
  });

  it('leaves HTTP unchanged', () => {
    const { resolveAuthEndpoint } = loadModule();
    const resolved = resolveAuthEndpoint('http://192.168.1.5:8765', 'android', true, '192.168.1.5');
    expect(resolved).toBe('http://192.168.1.5:8765');
  });

  it('does not downgrade when skip is false', () => {
    const { resolveAuthEndpoint } = loadModule();
    const resolved = resolveAuthEndpoint('https://192.168.1.5:8765', 'android', false, '192.168.1.5');
    expect(resolved).toBe('https://192.168.1.5:8765');
  });

  it('does not downgrade on non-Android platforms', () => {
    const { resolveAuthEndpoint } = loadModule();
    const resolved = resolveAuthEndpoint('https://192.168.1.5:8765', 'ios', true, '192.168.1.5');
    expect(resolved).toBe('https://192.168.1.5:8765');
  });

  it('does not downgrade for public hostnames', () => {
    const { resolveAuthEndpoint } = loadModule();
    const resolved = resolveAuthEndpoint('https://daemon.example.com:8765', 'android', true, 'daemon.example.com');
    expect(resolved).toBe('https://daemon.example.com:8765');
  });
});

describe('authenticatePairing Android resolution & fallback', () => {
  const authOk = (socket: MockWebSocket) => {
    socket.open();
    socket.message({ type: 'auth.challenge', salt: 'c2FsdA', serverNonce: 'server-nonce', challengeId: 'chal-1' });
    socket.message({ type: 'auth.ok', sessionToken: 'session-token' });
  };

  const flush = () => new Promise<void>((resolve) => setImmediate(() => resolve()));

  let mockFetch: jest.Mock;
  beforeEach(() => {
    mockFetch = jest.fn().mockResolvedValue({ ok: true } as Response);
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).fetch;
  });

  const started = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('Android local HTTPS + skip resolves directly to HTTP via resolver', async () => {
    mockPlatform = 'android';
    const { authenticatePairing } = loadModule();
    const promise = authenticatePairing(payload, 'phone', jest.fn());
    await started();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe('ws://192.168.1.5:8765/v1/ws/sessions/bootstrap');
    await started();
    authOk(MockWebSocket.instances[0]);
    const result = await promise;
    expect(result.endpoint).toBe('http://192.168.1.5:8765');
    expect(result.token).toBe('session-token');
  });

  it('HTTP payload stays HTTP (no fallback needed)', async () => {
    mockPlatform = 'android';
    const { authenticatePairing } = loadModule();
    const httpPayload = { ...payload, endpoint: 'http://192.168.1.5:8765' };
    const promise = authenticatePairing(httpPayload, 'phone', jest.fn());
    await started();
    expect(MockWebSocket.instances[0].url).toBe('ws://192.168.1.5:8765/v1/ws/sessions/bootstrap');
    authOk(MockWebSocket.instances[0]);
    await started();
    const result = await promise;
    expect(result.endpoint).toBe('http://192.168.1.5:8765');
    expect(MockWebSocket.instances).toHaveLength(1); // No retry
  });

  it('non-Android platform stays HTTPS (no downgrade)', async () => {
    mockPlatform = 'ios';
    const { authenticatePairing } = loadModule();
    const promise = authenticatePairing(payload, 'phone', jest.fn());
    await started();
    expect(MockWebSocket.instances[0].url).toBe('wss://192.168.1.5:8765/v1/ws/sessions/bootstrap');
    authOk(MockWebSocket.instances[0]);
    const result = await promise;
    expect(result.endpoint).toBe('https://192.168.1.5:8765');
    await started();
  });

  it('skip=false on Android stays HTTPS (no downgrade)', async () => {
    mockPlatform = 'android';
    const { authenticatePairing } = loadModule();
    const strictPayload = { ...payload, skipFingerprintVerification: false };
    const promise = authenticatePairing(strictPayload, 'phone', jest.fn());
    await started();
    expect(MockWebSocket.instances[0].url).toBe('wss://192.168.1.5:8765/v1/ws/sessions/bootstrap');
    authOk(MockWebSocket.instances[0]);
    const result = await promise;
    expect(result.endpoint).toBe('https://192.168.1.5:8765');
  });

  it('public hostname stays HTTPS on Android + skip', async () => {
    mockPlatform = 'android';
    const { authenticatePairing } = loadModule();
    const remotePayload = { ...payload, endpoint: 'https://daemon.example.com:8765' };
    const promise = authenticatePairing(remotePayload, 'phone', jest.fn());
    await started();
    expect(MockWebSocket.instances[0].url).toBe('wss://daemon.example.com:8765/v1/ws/sessions/bootstrap');
    authOk(MockWebSocket.instances[0]);
    const result = await promise;
    expect(result.endpoint).toBe('https://daemon.example.com:8765');
  });

  it('forbidden_source from health probe surfaces CIDR guidance', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ code: 'forbidden_source', message: 'Client IP not in allowedCidrs' }),
    } as Response);
    mockPlatform = 'android';
    const { authenticatePairing } = loadModule();
    const promise = authenticatePairing(payload, 'phone', jest.fn());
    await expect(promise).rejects.toThrow(/allowedCidrs must include your LAN subnet/);
    expect(MockWebSocket.instances).toHaveLength(0); // No socket attempt
  });

  it('does not retry on non-Android even for local transport error', async () => {
    mockPlatform = 'ios';
    const { authenticatePairing } = loadModule();
    const promise = authenticatePairing(payload, 'phone', jest.fn());
    await started();
    MockWebSocket.instances[0].fail();
    await expect(promise).rejects.toThrow();
    expect(MockWebSocket.instances).toHaveLength(1);
    await started();
  });

  it('does not retry for non-local host on Android', async () => {
    mockPlatform = 'android';
    const { authenticatePairing } = loadModule();
    const remotePayload = { ...payload, endpoint: 'https://daemon.example.com:8765' };
    const promise = authenticatePairing(remotePayload, 'phone', jest.fn());
    await started();
    MockWebSocket.instances[0].fail();
    await expect(promise).rejects.toThrow();
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
describe('authenticatePairing timeouts and terminal races', () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn().mockResolvedValue({ ok: true } as Response);
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    jest.useFakeTimers();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).fetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const flush = async () => {
    await Promise.resolve();
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

