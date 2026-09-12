import * as Crypto from 'expo-crypto';
import type { Connection } from './connection';
import type { AgentEvent, RuntimeLifecycleEvent } from '../protocol';

// One `RuntimeChannel` per daemon multiplexes the JSON control-plane socket
// (`/v1/ws/runtime`): agent event subscriptions + request/response commands.
// Distinct from `DaemonChannel`, which multiplexes raw PTY/VNC byte streams.

type Pending = { resolve: (v: any) => void; reject: (err: Error) => void };
type Subscription = { kind: 'agent' | 'runtime'; targetId: string; cursor: number; onCursorExpired: () => Promise<number>; pending?: Pending };
type PendingOpen = { channelId: string; pending?: Pending };

export class RuntimeChannel {
  private socket: WebSocket | null = null;
  private queue: object[] = [];
  private subscribers = new Map<string, Set<(event: unknown) => void>>();
  private subscriptions = new Map<string, Subscription>();
  private pendingOpens = new Map<string, PendingOpen>();
  private pendingCommands = new Map<string, Pending>();
  private reconnectTimer: number | null = null;
  private disposed = false;

  constructor(private readonly connection: Connection) {}

  private ensureSocket(): void {
    if (this.disposed || this.socket) return;
    const url = `${this.connection.endpoint.replace(/^http/, 'ws').replace(/\/$/, '')}/v1/ws/runtime`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'auth.token', token: this.connection.token }));
      const queued = this.queue;
      this.queue = [];
      for (const frame of queued) socket.send(JSON.stringify(frame));
      for (const [channelId, subscription] of this.subscriptions) {
        if (![...this.pendingOpens.values()].some((open) => open.channelId === channelId)) this.openSubscription(channelId, subscription);
      }
    };
    socket.onmessage = (event) => {
      try { this.handleFrame(JSON.parse(String(event.data))); } catch {}
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.queue = [];
      for (const pending of this.pendingCommands.values()) pending.reject(new Error('runtime connection closed'));
      this.pendingCommands.clear();
      this.pendingOpens.clear();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.subscriptions.size === 0 || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSocket();
    }, 250);
  }

  private handleFrame(frame: any): void {
    if (frame.type === 'channel.opened') {
      const open = this.pendingOpens.get(frame.requestId);
      if (!open) return;
      this.pendingOpens.delete(frame.requestId);
      const subscription = this.subscriptions.get(open.channelId);
      if (subscription) subscription.cursor = Math.max(subscription.cursor, frame.cursor as number);
      open.pending?.resolve(frame.cursor as number);
      if (subscription) subscription.pending = undefined;
      return;
    }
    if (frame.type === 'command.result') {
      const open = this.pendingOpens.get(frame.requestId);
      if (open) {
        this.pendingOpens.delete(frame.requestId);
        const subscription = this.subscriptions.get(open.channelId);
        if (subscription && String(frame.error || '').includes('cursor expired')) {
          void subscription.onCursorExpired().then((cursor) => {
            subscription.cursor = cursor;
            this.openSubscription(open.channelId, subscription);
          }).catch((error) => open.pending?.reject(error instanceof Error ? error : new Error(String(error))));
          return;
        }
        open.pending?.reject(new Error(frame.error || 'channel open failed'));
        if (subscription) subscription.pending = undefined;
        return;
      }
      const command = this.pendingCommands.get(frame.requestId);
      if (!command) return;
      this.pendingCommands.delete(frame.requestId);
      if (frame.ok) command.resolve(frame.result); else command.reject(new Error(frame.error || 'command failed'));
      return;
    }
    if (frame.type === 'event') {
      const subscription = this.subscriptions.get(frame.channelId);
      const listeners = this.subscribers.get(frame.channelId);
      if (!subscription || !listeners || frame.cursor <= subscription.cursor) return;
      subscription.cursor = frame.cursor as number;
      const event = { ...(frame.event as object), cursor: frame.cursor as number };
      for (const listener of listeners) {
        try { listener(event); } catch (error) { console.error('runtime event subscriber error:', error); }
      }
    }
  }

  private send(frame: object): void {
    this.ensureSocket();
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
    else this.queue.push(frame);
  }

  private openSubscription(channelId: string, subscription: Subscription): void {
    const requestId = Crypto.randomUUID();
    this.pendingOpens.set(requestId, { channelId, pending: subscription.pending });
    this.send({ type: 'channel.open', requestId, channelId, kind: subscription.kind, targetId: subscription.targetId, after: subscription.cursor });
  }

  private async openChannel(kind: Subscription['kind'], targetId: string, after: number, subscriber: (event: unknown) => void, onCursorExpired: () => Promise<number>): Promise<{ channelId: string; cursor: number }> {
    const channelId = Crypto.randomUUID();
    this.subscribeChannel(channelId, subscriber);
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const subscription: Subscription = { kind, targetId, cursor: after, onCursorExpired, pending: { resolve, reject } };
    this.subscriptions.set(channelId, subscription);
    this.openSubscription(channelId, subscription);
    const cursor = await promise;
    return { channelId, cursor };
  }

  openAgentChannel(agentId: string, after = 0, subscriber?: (event: AgentEvent) => void, onCursorExpired = async () => 0): Promise<{ channelId: string; cursor: number }> {
    return this.openChannel('agent', agentId, after, (event) => subscriber?.(event as AgentEvent), onCursorExpired);
  }

  openRuntimeChannel(after = 0, subscriber?: (event: RuntimeLifecycleEvent) => void, onCursorExpired = async () => 0): Promise<{ channelId: string; cursor: number }> {
    return this.openChannel('runtime', 'runtime', after, (event) => subscriber?.(event as RuntimeLifecycleEvent), onCursorExpired);
  }

  subscribeChannel(channelId: string, fn: (event: unknown) => void): () => void {
    let set = this.subscribers.get(channelId);
    if (!set) this.subscribers.set(channelId, set = new Set());
    set.add(fn);
    return () => {
      const current = this.subscribers.get(channelId);
      if (!current) return;
      current.delete(fn);
      if (current.size === 0) this.subscribers.delete(channelId);
    };
  }

  closeChannel(channelId: string): void {
    this.subscribers.delete(channelId);
    this.subscriptions.delete(channelId);
    this.send({ type: 'channel.close', channelId });
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    this.queue = [];
    for (const { pending } of this.pendingOpens.values()) pending?.reject(new Error('Runtime channel disposed'));
    for (const pending of this.pendingCommands.values()) pending.reject(new Error('Runtime channel disposed'));
    this.pendingOpens.clear();
    this.pendingCommands.clear();
    this.subscriptions.clear();
    this.subscribers.clear();
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

export function disposeRuntimeChannel(hostId: string): void {
  const channel = runtimeChannelRegistry.get(hostId);
  channel?.dispose();
  runtimeChannelRegistry.delete(hostId);
}
