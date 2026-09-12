import { RuntimeChannel, runtimeChannelRegistry, createRuntimeChannel, disposeRuntimeChannel } from './runtime-channel';
import type { Connection } from './connection';

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(_: string) { FakeWebSocket.instances.push(this); }
  send(value: string) { this.sent.push(value); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(frame: object) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

const connection: Connection = {
  name: 'test', endpoint: 'https://daemon.test', hostId: 'daemon', fingerprint: '', skipFingerprintVerification: true, token: 'token', clientName: 'test',
};

describe('RuntimeChannel reconnects subscriptions', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    jest.useFakeTimers();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    jest.useRealTimers();
  });

  it('reopens from its last cursor and drops replay duplicates', async () => {
    const channel = new RuntimeChannel(connection);
    const received: number[] = [];
    const opening = channel.openRuntimeChannel(7, (event) => received.push(event.cursor ?? 0));
    const first = FakeWebSocket.instances[0];
    first.open();
    const firstOpen = JSON.parse(first.sent[1]);
    first.receive({ type: 'channel.opened', requestId: firstOpen.requestId, channelId: firstOpen.channelId, cursor: 7 });
    await opening;
    first.receive({ type: 'event', channelId: firstOpen.channelId, cursor: 8, event: { surfaceId: 't1', type: 'terminal.created', payload: {} } });
    first.close();

    jest.advanceTimersByTime(250);
    const second = FakeWebSocket.instances[1];
    second.open();
    expect(second.sent).toHaveLength(2);
    const secondOpen = JSON.parse(second.sent[1]);
    expect(secondOpen.after).toBe(8);
    second.receive({ type: 'channel.opened', requestId: secondOpen.requestId, channelId: firstOpen.channelId, cursor: 8 });
    second.receive({ type: 'event', channelId: firstOpen.channelId, cursor: 8, event: {} });
    second.receive({ type: 'event', channelId: firstOpen.channelId, cursor: 9, event: { surfaceId: 't1', type: 'terminal.exited', payload: {} } });
    expect(received).toEqual([8, 9]);
  });


  it('refreshes its cursor when replay expires', async () => {
    const channel = new RuntimeChannel(connection);
    const opening = channel.openRuntimeChannel(7, undefined, async () => 20);
    const socket = FakeWebSocket.instances[0];
    socket.open();
    const firstOpen = JSON.parse(socket.sent[1]);
    socket.receive({ type: 'command.result', requestId: firstOpen.requestId, ok: false, error: 'runtime cursor expired' });
    await Promise.resolve();
    const retry = JSON.parse(socket.sent[2]);
    expect(retry.after).toBe(20);
    socket.receive({ type: 'channel.opened', requestId: retry.requestId, channelId: firstOpen.channelId, cursor: 20 });
    await expect(opening).resolves.toMatchObject({ cursor: 20 });
  });

  it('dispose rejects pending opens and removes the registry entry', async () => {
    const channel = createRuntimeChannel({ ...connection, hostId: 'host-x' });
    const opening = channel.openRuntimeChannel(0);
    disposeRuntimeChannel('host-x');
    await expect(opening).rejects.toThrow('Runtime channel disposed');
    expect(runtimeChannelRegistry.has('host-x')).toBe(false);
  });
});