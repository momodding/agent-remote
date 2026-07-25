import type { PairingPayload } from '../protocol';

type ApiModule = typeof import('./api');

let mockPlatform = 'web';
jest.mock('react-native', () => ({ Platform: { OS: mockPlatform } }));
// Real clientProof runs Argon2id (~seconds); mock it so fallback tests stay fast and deterministic.
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

describe('authenticatePairing Android HTTPS->HTTP fallback', () => {
  const authOk = (socket: MockWebSocket) => {
    socket.open();
    socket.message({ type: 'auth.challenge', salt: 'c2FsdA', serverNonce: 'server-nonce', challengeId: 'chal-1' });
    socket.message({ type: 'auth.ok', sessionToken: 'session-token' });
  };

  const flush = () => new Promise<void>((resolve) => setImmediate(() => resolve()));

  it('does not retry on non-Android platforms even after a transport error', async () => {
    mockPlatform = 'ios';
    const { authenticatePairing } = loadModule();
    const promise = authenticatePairing(payload, 'phone', jest.fn());
    MockWebSocket.instances[0].fail();
    await expect(promise).rejects.toThrow();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('does not retry for a non-local host on Android', async () => {
    mockPlatform = 'android';
    const { authenticatePairing } = loadModule();
    const remotePayload = { ...payload, endpoint: 'https://daemon.example.com:8765' };
    const promise = authenticatePairing(remotePayload, 'phone', jest.fn());
    MockWebSocket.instances[0].fail();
    await expect(promise).rejects.toThrow();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('does not retry when skipFingerprintVerification is false', async () => {
    mockPlatform = 'android';
    const { authenticatePairing } = loadModule();
    const strictPayload = { ...payload, skipFingerprintVerification: false };
    const promise = authenticatePairing(strictPayload, 'phone', jest.fn());
    MockWebSocket.instances[0].fail();
    await expect(promise).rejects.toThrow();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('retries over ws: after a pre-frame transport error on Android with a local https host', async () => {
    mockPlatform = 'android';
    const { authenticatePairing } = loadModule();
    const diagnostic = jest.fn();
    const promise = authenticatePairing(payload, 'phone', diagnostic);
    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.instances[0].fail();
    await flush();
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toBe('ws://192.168.1.5:8765/v1/ws/sessions/bootstrap');
    authOk(MockWebSocket.instances[1]);
    const result = await promise;
    expect(result.endpoint).toBe('http://192.168.1.5:8765');
    expect(result.token).toBe('session-token');
    expect(diagnostic).toHaveBeenCalledWith('Secure transport unavailable; retrying direct LAN over HTTP...');
  });

  it('does not retry after a protocol-level auth error even when fallback-eligible', async () => {
    mockPlatform = 'android';
    const { authenticatePairing } = loadModule();
    const promise = authenticatePairing(payload, 'phone', jest.fn());
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.message({ type: 'error', message: 'bad token' });
    await expect(promise).rejects.toThrow('bad token');
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('throws a combined error when the http fallback also fails', async () => {
    mockPlatform = 'android';
    const { authenticatePairing } = loadModule();
    const promise = authenticatePairing(payload, 'phone', jest.fn());
    MockWebSocket.instances[0].fail();
    await flush();
    MockWebSocket.instances[1].fail();
    await expect(promise).rejects.toThrow('Connection failed on both https://192.168.1.5:8765 and http://192.168.1.5:8765');
  });

  it('succeeds without any retry when the first attempt completes', async () => {
    mockPlatform = 'android';
    const { authenticatePairing } = loadModule();
    const promise = authenticatePairing(payload, 'phone', jest.fn());
    authOk(MockWebSocket.instances[0]);
    const result = await promise;
    expect(result.endpoint).toBe('https://192.168.1.5:8765');
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
