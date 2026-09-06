import { createDaemonChannel, channelRegistry } from './daemon-channel';
import type { Connection } from './connection';

const conn: Connection = {
  name: 'test', endpoint: 'https://127.0.0.1:8443', hostId: 'host-123',
  fingerprint: 'ff', skipFingerprintVerification: true, token: 'tok', clientName: 'test-client',
};

describe('daemon-channel', () => {
  it('creates mock channel per connection', () => {
    const channel = createDaemonChannel(conn);
    expect(channel.daemonId).toBe('host-123');
    expect(channelRegistry.get('host-123')).toBe(channel);
  });
});
