import type { ChannelEnvelope, ChannelStatus, DaemonChannel } from '../daemon-channel';
import type { DaemonId, TabKind } from '../tabs/types';
import { MockAgentSession, MockDesktop, MockPty } from './mock-daemon';

type ChannelBackend = { handle(envelope: ChannelEnvelope): void };
function makeBackend(kind: TabKind, emit: (envelope: ChannelEnvelope) => void, channelId: string): ChannelBackend {
  switch (kind) {
    case 'terminal':
      return new MockPty((payload) => emit({ channelId, kind, ...payload }));
    case 'agent':
      return new MockAgentSession((payload) => emit({ channelId, kind, ...payload }));
    case 'desktop':
      return new MockDesktop((payload) => emit({ channelId, kind, ...payload }));
    case 'files':
      return { handle: () => {} }; // files is stateless REST, never multiplexed over the channel.
  }
}

/**
 * In-process `DaemonChannel`: every `openChannel` spins up a `Mock*`
 * backend (`mock-daemon.ts`) keyed by the returned `channelId`, and
 * `send` routes envelopes to it synchronously. Stands in for a real
 * `/v1/ws/gateway` WebSocket until the daemon ships that endpoint.
 */
export class MockDaemonChannel implements DaemonChannel {
  status: ChannelStatus = 'open';
  private backends = new Map<string, ChannelBackend>();
  private listeners = new Map<string, Set<(msg: ChannelEnvelope) => void>>();
  private pending = new Map<string, ChannelEnvelope[]>();
  private nextId = 0;

  constructor(public readonly daemonId: DaemonId) {}

  send(envelope: ChannelEnvelope): void {
    this.backends.get(envelope.channelId)?.handle(envelope);
  }

  subscribe(channelId: string, fn: (msg: ChannelEnvelope) => void): () => void {
    const set = this.listeners.get(channelId) ?? new Set();
    set.add(fn);
    this.listeners.set(channelId, set);
    const buffered = this.pending.get(channelId);
    if (buffered && buffered.length > 0) {
      this.pending.set(channelId, []);
      for (const envelope of buffered) fn(envelope);
    }
    return () => set.delete(fn);
  }

  async openChannel(kind: TabKind, _meta: Record<string, unknown>): Promise<string> {
    const channelId = `mock-${this.daemonId}-${++this.nextId}`;
    const buffered: ChannelEnvelope[] = [];
    const emit = (envelope: ChannelEnvelope) => {
      const set = this.listeners.get(envelope.channelId);
      if (!set || set.size === 0) { buffered.push(envelope); return; }
      for (const fn of set) fn(envelope);
    };
    this.backends.set(channelId, makeBackend(kind, emit, channelId));
    this.pending.set(channelId, buffered);
    return channelId;
  }

  closeChannel(channelId: string): void {
    this.backends.delete(channelId);
    this.listeners.delete(channelId);
    this.pending.delete(channelId);
  }
}
