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
  private nextId = 0;

  constructor(public readonly daemonId: DaemonId) {}

  send(envelope: ChannelEnvelope): void {
    this.backends.get(envelope.channelId)?.handle(envelope);
  }

  subscribe(channelId: string, fn: (msg: ChannelEnvelope) => void): () => void {
    const set = this.listeners.get(channelId) ?? new Set();
    set.add(fn);
    this.listeners.set(channelId, set);
    return () => set.delete(fn);
  }

  async openChannel(kind: TabKind, _meta: Record<string, unknown>): Promise<string> {
    const channelId = `mock-${this.daemonId}-${++this.nextId}`;
    const emit = (envelope: ChannelEnvelope) => {
      for (const fn of this.listeners.get(envelope.channelId) ?? []) fn(envelope);
    };
    this.backends.set(channelId, makeBackend(kind, emit, channelId));
    return channelId;
  }

  closeChannel(channelId: string): void {
    this.backends.delete(channelId);
    this.listeners.delete(channelId);
  }
}
