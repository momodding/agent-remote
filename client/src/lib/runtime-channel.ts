import * as Crypto from 'expo-crypto';
import type { Connection } from './connection';
import type { AgentEvent, RuntimeLifecycleEvent } from '../protocol';

// One `RuntimeChannel` per daemon multiplexes the JSON control-plane socket
// (`/v1/ws/runtime`): agent event subscriptions + request/response commands.
// Distinct from `DaemonChannel`, which multiplexes raw PTY/VNC byte streams.

type Pending = { resolve: (v: any) => void; reject: (err: Error) => void };

export class RuntimeChannel {
  private socket: WebSocket | null = null;
  private queue: object[] = [];
  private subscribers = new Map<string, Set<(event: unknown) => void>>();
  private pendingOpens = new Map<string, Pending>(); // requestId -> resolves with cursor
  private pendingCommands = new Map<string, Pending>(); // requestId -> resolves with result

  constructor(private readonly connection: Connection) {}

  private ensureSocket(): void {
    if (this.socket) return;
    const url = `${this.connection.endpoint.replace(/^http/, 'ws').replace(/\/$/, '')}/v1/ws/runtime`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'auth.token', token: this.connection.token }));
      const pending = this.queue;
      this.queue = [];
      for (const frame of pending) socket.send(JSON.stringify(frame));
    };
    socket.onmessage = (event) => {
      let frame: any;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.handleFrame(frame);
    };
    const fail = (message: string) => {
      const err = new Error(message);
      for (const p of this.pendingOpens.values()) p.reject(err);
      for (const p of this.pendingCommands.values()) p.reject(err);
      this.pendingOpens.clear();
      this.pendingCommands.clear();
    };
    socket.onerror = () => fail('runtime connection error');
    socket.onclose = () => {
      this.socket = null;
      fail('runtime connection closed');
    };
  }

  private handleFrame(frame: any): void {
    switch (frame.type) {
      case 'channel.opened': {
        const pending = this.pendingOpens.get(frame.requestId);
        if (pending) {
          this.pendingOpens.delete(frame.requestId);
          pending.resolve(frame.cursor as number);
        }
        return;
      }
      case 'command.result': {
        const openPending = this.pendingOpens.get(frame.requestId);
        if (openPending) {
          this.pendingOpens.delete(frame.requestId);
          openPending.reject(new Error(frame.error || 'channel open failed'));
          return;
        }
        const cmdPending = this.pendingCommands.get(frame.requestId);
        if (cmdPending) {
          this.pendingCommands.delete(frame.requestId);
          if (frame.ok) cmdPending.resolve(frame.result);
          else cmdPending.reject(new Error(frame.error || 'command failed'));
        }
        return;
      }
      case 'event': {
		const set = this.subscribers.get(frame.channelId);
		if (!set) return;
		const event = { ...(frame.event as AgentEvent), cursor: frame.cursor as number };
		for (const fn of set) {
          try {
            fn(event);
          } catch (err) {
            console.error('runtime event subscriber error:', err);
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private send(frame: object): void {
    this.ensureSocket();
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    } else {
      this.queue.push(frame);
    }
  }

	/** Opens an agent event channel and replays history from `after`. */
	async openAgentChannel(agentId: string, after = 0, subscriber?: (event: AgentEvent) => void): Promise<{ channelId: string; cursor: number }> {
		const channelId = Crypto.randomUUID();
		if (subscriber) this.subscribeChannel(channelId, (event) => subscriber(event as AgentEvent));
		const requestId = Crypto.randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<number>();
		this.pendingOpens.set(requestId, { resolve, reject });
		this.send({ type: 'channel.open', requestId, channelId, kind: 'agent', targetId: agentId, after });
		const cursor = await promise;
		return { channelId, cursor };
	}

	/** Opens the daemon-wide lifecycle channel; agent semantic streams stay separate. */
	async openRuntimeChannel(after = 0, subscriber?: (event: RuntimeLifecycleEvent) => void): Promise<{ channelId: string; cursor: number }> {
		const channelId = Crypto.randomUUID();
		if (subscriber) this.subscribeChannel(channelId, (event) => subscriber(event as RuntimeLifecycleEvent));
		const requestId = Crypto.randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<number>();
		this.pendingOpens.set(requestId, { resolve, reject });
		this.send({ type: 'channel.open', requestId, channelId, kind: 'runtime', targetId: 'runtime', after });
		const cursor = await promise;
		return { channelId, cursor };
	}

  subscribeChannel(channelId: string, fn: (event: unknown) => void): () => void {
    let set = this.subscribers.get(channelId);
    if (!set) {
      set = new Set();
      this.subscribers.set(channelId, set);
    }
    set.add(fn);
    return () => {
      const current = this.subscribers.get(channelId);
      if (current) {
        current.delete(fn);
        if (current.size === 0) this.subscribers.delete(channelId);
      }
    };
  }

  closeChannel(channelId: string): void {
    this.subscribers.delete(channelId);
    this.send({ type: 'channel.close', channelId });
  }

  async sendCommand(command: string, targetId: string, args?: unknown): Promise<unknown> {
    const requestId = Crypto.randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.pendingCommands.set(requestId, { resolve, reject });
    this.send({ type: 'command', requestId, targetId, command, args });
    return promise;
  }
}

export const runtimeChannelRegistry = new Map<string, RuntimeChannel>();

export function createRuntimeChannel(connection: Connection): RuntimeChannel {
  const existing = runtimeChannelRegistry.get(connection.hostId);
  if (existing) return existing;
  const channel = new RuntimeChannel(connection);
  runtimeChannelRegistry.set(connection.hostId, channel);
  return channel;
}
