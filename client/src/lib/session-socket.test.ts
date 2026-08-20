import { base64, decodeBase64, text, utf8 } from './bytes';
import type { Connection } from './connection';
import { SessionSocket } from './session-socket';

const originalWebSocket = globalThis.WebSocket;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close = jest.fn();

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
}

globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

const connection: Connection = {
  name: 'Test daemon',
  endpoint: 'https://daemon.test',
  token: 'secret',
  fingerprint: '',
  skipFingerprintVerification: false,
  clientName: 'test',
};

const frames = (socket: MockWebSocket) => socket.sent.map((frame) => JSON.parse(frame));

describe('PTY frame byte encoding', () => {
  it('round-trips UTF-8 input through standard padded base64', () => {
    const encoded = base64(utf8('λ'));
    expect(encoded).toContain('=');
    expect(text(decodeBase64(encoded))).toBe('λ');
  });
});

describe('SessionSocket', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
  });

  afterAll(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it('flushes auth, the latest resize, and ordered input after opening', () => {
    const session = new SessionSocket(connection, 'session', jest.fn(), jest.fn(), jest.fn());
    session.connect();
    const socket = MockWebSocket.instances[0];

    session.input('first');
    session.resize(80, 24);
    session.resize(120, 40);
    session.input('second');
    expect(socket.sent).toEqual([]);

    socket.open();
    expect(frames(socket)).toEqual([
      { type: 'auth.token', token: 'secret' },
      { type: 'pty.resize', sessionId: 'session', cols: 120, rows: 40 },
      { type: 'pty.input', sessionId: 'session', data: base64(utf8('first')) },
      { type: 'pty.input', sessionId: 'session', data: base64(utf8('second')) },
    ]);

    session.input('third');
    expect(frames(socket).at(-1)).toEqual({
      type: 'pty.input',
      sessionId: 'session',
      data: base64(utf8('third')),
    });
  });

  it('drops queued frames and callbacks from a replaced socket', () => {
    const onOutput = jest.fn();
    const onState = jest.fn();
    const onError = jest.fn();
    const session = new SessionSocket(connection, 'session', onOutput, onState, onError);
    session.connect();
    const oldSocket = MockWebSocket.instances[0];
    session.input('stale');
    session.resize(10, 5);

    session.connect();
    const socket = MockWebSocket.instances[1];
    oldSocket.open();
    oldSocket.onmessage?.({
      data: JSON.stringify({ type: 'pty.output', sessionId: 'session', data: base64(utf8('stale')), seq: 1 }),
    });
    oldSocket.onmessage?.({
      data: JSON.stringify({ type: 'session.state', sessionId: 'session', state: 'exited' }),
    });
    oldSocket.onerror?.();
    expect(oldSocket.sent).toEqual([]);
    expect(onOutput).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    socket.open();
    expect(frames(socket)).toEqual([{ type: 'auth.token', token: 'secret' }]);

    session.close();
    session.input('closed');
    session.resize(20, 10);
    session.connect();
    const reconnected = MockWebSocket.instances[2];
    reconnected.open();
    expect(frames(reconnected)).toEqual([{ type: 'auth.token', token: 'secret' }]);
  });

  it('forwards error code from error frames', () => {
    const onError = jest.fn();
    const session = new SessionSocket(connection, 'session', jest.fn(), jest.fn(), onError);
    session.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();

    socket.onmessage?.({
      data: JSON.stringify({ type: 'error', code: 'session_not_found', message: 'session not found' }),
    });
    expect(onError).toHaveBeenCalledWith('session not found', 'session_not_found');

    socket.onerror?.();
    expect(onError).toHaveBeenCalledWith('Terminal connection lost', 'connection_lost');
  });

  it('reassembles a Unicode scalar split across two pty.output frames', () => {
    const onOutput = jest.fn();
    const session = new SessionSocket(connection, 'session', onOutput, jest.fn(), jest.fn());
    session.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();

    const bytes = utf8('λ');
    expect(bytes.length).toBe(2);
    socket.onmessage?.({
      data: JSON.stringify({ type: 'pty.output', sessionId: 'session', data: base64(bytes.slice(0, 1)), seq: 1 }),
    });
    expect(onOutput).not.toHaveBeenCalled();

    socket.onmessage?.({
      data: JSON.stringify({ type: 'pty.output', sessionId: 'session', data: base64(bytes.slice(1)), seq: 2 }),
    });
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith('λ');
    expect(onOutput.mock.calls.every(([chunk]) => !chunk.includes('\uFFFD'))).toBe(true);
  });
});
