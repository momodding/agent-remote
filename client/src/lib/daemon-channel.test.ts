import { createDaemonChannel, channelRegistry, disposeDaemonChannel, WebSocketDaemonChannel } from './daemon-channel';
import type { Connection } from './connection';

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
