import { createDaemonChannel, channelRegistry, disposeDaemonChannel, WebSocketDaemonChannel } from './daemon-channel';
import type { Connection } from './connection';

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send(value: string) { this.sent.push(value); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(frame: object) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

const conn: Connection = {
  name: 'test', endpoint: 'https://127.0.0.1:8443', hostId: 'host-123',
  fingerprint: 'ff', skipFingerprintVerification: true, token: 'tok', clientName: 'test-client',
};

describe('daemon-channel', () => {
  it('creates channel per connection', () => {
    const channel = createDaemonChannel(conn);
    expect(channel.daemonId).toBe('host-123');
    expect(channelRegistry.get('host-123')).toBe(channel);
    expect(channel).toBeInstanceOf(WebSocketDaemonChannel);
  });

  it('dispose removes the registry entry and closes its sockets', () => {
    const channel = createDaemonChannel({ ...conn, hostId: 'host-456' });
    const closeSpy = jest.fn();
    (channel as any).sockets.set('chan-1', { close: closeSpy, readyState: 1 });
    disposeDaemonChannel('host-456');
    expect(closeSpy).toHaveBeenCalled();
    expect(channelRegistry.has('host-456')).toBe(false);
    expect(createDaemonChannel({ ...conn, hostId: 'host-456' })).not.toBe(channel);
  });

  it('gives each daemon its own registry entry and socket set', () => {
    const channelA = createDaemonChannel({ ...conn, hostId: 'daemon-a' });
    const channelB = createDaemonChannel({ ...conn, hostId: 'daemon-b' });
    expect(channelA).not.toBe(channelB);
    expect(channelA.daemonId).toBe('daemon-a');
    expect(channelB.daemonId).toBe('daemon-b');

    const closeA = jest.fn();
    const closeB = jest.fn();
    (channelA as any).sockets.set('shared-channel-id', { close: closeA, readyState: 1 });
    (channelB as any).sockets.set('shared-channel-id', { close: closeB, readyState: 1 });

    disposeDaemonChannel('daemon-a');
    expect(closeA).toHaveBeenCalled();
    expect(closeB).not.toHaveBeenCalled();
    expect(channelRegistry.has('daemon-a')).toBe(false);
    expect(channelRegistry.get('daemon-b')).toBe(channelB);
    disposeDaemonChannel('daemon-b');
  });
});

describe('WebSocketDaemonChannel raw terminal reconnect', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeSocket.instances = [];
    jest.useFakeTimers();
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    jest.useRealTimers();
    disposeDaemonChannel('reconnect-host');
  });

  it('reconnects an active subscription after an unexpected close, without reconnecting a closed channel', () => {
    const channel = createDaemonChannel({ ...conn, hostId: 'reconnect-host' }) as WebSocketDaemonChannel;
    const received: unknown[] = [];
    const unsubscribe = channel.subscribe('term-1', (msg) => received.push(msg));
    const first = FakeSocket.instances[0];
    first.open();
    first.close();
    expect(FakeSocket.instances.length).toBe(1);
    jest.advanceTimersByTime(250);
    expect(FakeSocket.instances.length).toBe(2);

    unsubscribe();
    const second = FakeSocket.instances[1];
    second.open();
    second.close();
    jest.advanceTimersByTime(250);
    expect(FakeSocket.instances.length).toBe(2);
  });

  it('dispatches pty.baseline distinctly from pty.output for viewport replacement', () => {
    const channel = createDaemonChannel({ ...conn, hostId: 'reconnect-host' }) as WebSocketDaemonChannel;
    const received: unknown[] = [];
    channel.subscribe('term-1', (msg) => received.push(msg));
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.receive({ type: 'pty.baseline', sessionId: 'term-1', data: 'YQ==', seq: 5 });
    expect(received).toEqual([{ channelId: 'term-1', kind: 'terminal', type: 'pty.baseline', data: 'YQ==', seq: 5 }]);
  });

  it('drops duplicate output at or before the baseline sequence', () => {
    const channel = createDaemonChannel({ ...conn, hostId: 'reconnect-host' }) as WebSocketDaemonChannel;
    const received: unknown[] = [];
    channel.subscribe('term-1', (msg) => received.push(msg));
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.receive({ type: 'pty.baseline', sessionId: 'term-1', data: 'YQ==', seq: 5 });
    socket.receive({ type: 'pty.output', sessionId: 'term-1', data: 'Yg==', seq: 5 });
    socket.receive({ type: 'pty.output', sessionId: 'term-1', data: 'Yw==', seq: 6 });
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ type: 'pty.output', seq: 6 });
  });

  it('drops terminal input but retains the latest resize during reconnect', () => {
    const channel = createDaemonChannel({ ...conn, hostId: 'reconnect-host' }) as WebSocketDaemonChannel;
    channel.subscribe('term-1', jest.fn());
    const first = FakeSocket.instances[0];
    first.open();
    first.close();

    channel.send({ channelId: 'term-1', kind: 'terminal', type: 'pty.input', data: 'c3RhbGU=' });
    channel.send({ channelId: 'term-1', kind: 'terminal', type: 'pty.resize', cols: 80, rows: 24 });
    channel.send({ channelId: 'term-1', kind: 'terminal', type: 'pty.resize', cols: 120, rows: 40 });
    jest.advanceTimersByTime(250);

    const second = FakeSocket.instances[1];
    second.open();
    expect(second.sent).toEqual([
      JSON.stringify({ type: 'auth.token', token: 'tok' }),
      JSON.stringify({ type: 'pty.resize', sessionId: 'term-1', cols: 120, rows: 40 }),
    ]);
  });
});
