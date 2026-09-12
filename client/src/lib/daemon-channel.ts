import { AgenticRemoteAPI } from './api';
import { base64, decodeBase64 } from './bytes';
import type { Connection } from './connection';
import type { SessionSummary, WaitState } from '../protocol';
import type { DaemonId, TabKind } from './tabs/types';

export const flushImmediate = (fn: () => void): (() => void) => {
  if (typeof setImmediate === 'function') {
    const handle = setImmediate(fn);
    return () => clearImmediate(handle);
  }
  const handle = setTimeout(fn, 0);
  return () => clearTimeout(handle);
};

// ============================================================================
// Per-kind frame payloads. `channelId` + `kind` are added by ChannelEnvelope;
// these mirror the wire shapes session-socket.ts and desktop.tsx use today,
// minus the sessionId (channelId is the multiplexing key now).
// ============================================================================

export type PTYChannelFrame =
  | { type: 'pty.output'; data: string; seq: number } // base64, server -> client
  | { type: 'pty.input'; data: string } // base64, client -> server
  | { type: 'pty.resize'; cols: number; rows: number } // client -> server
  | { type: 'session.state'; state: SessionSummary['state']; waitState?: WaitState }; // server -> client


export type DesktopChannelFrame =
  | { type: 'vnc.data'; data: string } // base64 raw RFB bytes, bidirectional
  | { type: 'vnc.resize'; width: number; height: number }; // server -> client

type ErrorChannelFrame = { type: 'error'; code: string; message: string };

export type ChannelFramePayload = PTYChannelFrame | DesktopChannelFrame | ErrorChannelFrame;

/**
 * Every PTY/VNC-byte frame gets tagged with the tab's `channelId`
 * so tabs share multiplexing routing.
 */
export type ChannelEnvelope = { channelId: string; kind: TabKind } & ChannelFramePayload;

export type ChannelStatus = 'connecting' | 'open' | 'closed' | 'error';

/**
 * One `DaemonChannel` per paired daemon multiplexes every open tab's traffic.
 */
export interface DaemonChannel {
  daemonId: DaemonId;
  status: ChannelStatus;
  send(envelope: ChannelEnvelope): void;
  /** Registers `fn` for frames on `channelId`; call the returned function to unsubscribe. */
  subscribe(channelId: string, fn: (msg: ChannelEnvelope) => void): () => void;
  /** Opens a new multiplexed channel for one tab; resolves once the daemon acks it. */
  openChannel(kind: TabKind, meta: Record<string, unknown>): Promise<string>;
  closeChannel(channelId: string): void;
  dispose(): void;
}

export class WebSocketDaemonChannel implements DaemonChannel {
  daemonId: DaemonId;
  status: ChannelStatus = 'open';
  private api: AgenticRemoteAPI;
  private subscribers = new Map<string, Set<(msg: ChannelEnvelope) => void>>();
  private sockets = new Map<string, WebSocket>();
  private pendingSends = new Map<string, Array<string | ArrayBuffer | ArrayBufferView | object>>();

  constructor(private readonly connection: Connection) {
    this.daemonId = connection.hostId;
    this.api = new AgenticRemoteAPI(connection);
  }

  async openChannel(kind: TabKind, meta: Record<string, unknown> = {}): Promise<string> {
    if (kind === 'terminal') {
      if (typeof meta.sessionId === 'string' && meta.sessionId) {
        return meta.sessionId;
      }
      const session = await this.api.createSession({
        name: typeof meta.name === 'string' ? meta.name : 'Terminal',
        command: typeof meta.command === 'string' ? meta.command : typeof meta.shell === 'string' ? meta.shell : '',
        args: Array.isArray(meta.args) ? (meta.args as string[]) : [],
        cwd: typeof meta.cwd === 'string' ? meta.cwd : '',
        cols: typeof meta.cols === 'number' ? meta.cols : 80,
        rows: typeof meta.rows === 'number' ? meta.rows : 24,
      });
      return session.id;
    }
    if (kind === 'desktop') {
      return typeof meta.channelId === 'string' && meta.channelId ? meta.channelId : 'vnc';
    }
    throw new Error(`openChannel: unsupported tab kind "${kind}"`);
  }

  subscribe(channelId: string, fn: (msg: ChannelEnvelope) => void): () => void {
    let set = this.subscribers.get(channelId);
    if (!set) {
      set = new Set();
      this.subscribers.set(channelId, set);
    }
    set.add(fn);

    this.ensureSocket(channelId);

    return () => {
      const current = this.subscribers.get(channelId);
      if (current) {
        current.delete(fn);
        if (current.size === 0) {
          this.subscribers.delete(channelId);
          this.closeSocket(channelId);
        }
      }
    };
  }

  send(envelope: ChannelEnvelope): void {
    const { channelId, kind } = envelope;
    const socket = this.sockets.get(channelId);

    if (kind === 'terminal') {
      let wireFrame: { type: string; sessionId: string; data?: string; cols?: number; rows?: number } | undefined;
      if (envelope.type === 'pty.input') {
        wireFrame = { type: 'pty.input', sessionId: channelId, data: envelope.data };
      } else if (envelope.type === 'pty.resize') {
        wireFrame = { type: 'pty.resize', sessionId: channelId, cols: envelope.cols, rows: envelope.rows };
      }
      if (wireFrame) {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(wireFrame));
        } else {
          this.queuePending(channelId, wireFrame);
          this.ensureSocket(channelId);
        }
      }
    } else if (kind === 'desktop') {
      if (envelope.type === 'vnc.data') {
        const u8 = decodeBase64(envelope.data);
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(u8);
        } else {
          this.queuePending(channelId, u8);
          this.ensureSocket(channelId);
        }
      }
    }
  }

  closeChannel(channelId: string): void {
    this.subscribers.delete(channelId);
    this.closeSocket(channelId);
  }

  dispose(): void {
    for (const channelId of this.sockets.keys()) this.closeSocket(channelId);
    this.subscribers.clear();
    this.pendingSends.clear();
    this.status = 'closed';
  }

  private ensureSocket(channelId: string): void {
    if (this.sockets.has(channelId)) return;

    const isDesktop = channelId === 'vnc' || channelId.startsWith('desktop');
    let url: string;
    if (isDesktop) {
      url = `${this.connection.endpoint.replace(/^http/, 'ws').replace(/\/$/, '')}/v1/ws/vnc?token=${encodeURIComponent(this.connection.token)}`;
    } else {
      url = `${this.connection.endpoint.replace(/^http/, 'ws').replace(/\/$/, '')}/v1/ws/sessions/${encodeURIComponent(channelId)}`;
    }

    const socket = new WebSocket(url);
    if (isDesktop) {
      socket.binaryType = 'arraybuffer';
    }
    this.sockets.set(channelId, socket);

    socket.onopen = () => {
      if (!isDesktop) {
        socket.send(JSON.stringify({ type: 'auth.token', token: this.connection.token }));
      }
      const pending = this.pendingSends.get(channelId) || [];
      this.pendingSends.delete(channelId);
      for (const item of pending) {
        if (typeof item === 'string') {
          socket.send(item);
        } else if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) {
          socket.send(item);
        } else {
          socket.send(JSON.stringify(item));
        }
      }
    };

    socket.onmessage = (event) => {
      if (isDesktop) {
        const u8 = new Uint8Array(event.data as ArrayBuffer);
        const b64 = base64(u8);
        this.dispatch(channelId, { channelId, kind: 'desktop', type: 'vnc.data', data: b64 });
      } else {
        try {
          const frame = JSON.parse(String(event.data));
          if (frame.type === 'pty.output') {
            this.dispatch(channelId, { channelId, kind: 'terminal', type: 'pty.output', data: frame.data, seq: frame.seq });
          } else if (frame.type === 'session.state') {
            this.dispatch(channelId, { channelId, kind: 'terminal', type: 'session.state', state: frame.state, waitState: frame.waitState });
          } else if (frame.type === 'error') {
            this.dispatch(channelId, { channelId, kind: 'terminal', type: 'error', code: frame.code, message: frame.message });
          }
        } catch {}
      }
    };

    socket.onerror = () => {
      this.dispatch(channelId, { channelId, kind: isDesktop ? 'desktop' : 'terminal', type: 'error', code: 'ws_error', message: 'WebSocket connection error' });
    };

    socket.onclose = () => {
      this.sockets.delete(channelId);
    };

  }

  private queuePending(channelId: string, item: string | ArrayBuffer | ArrayBufferView | object): void {
    let list = this.pendingSends.get(channelId);
    if (!list) {
      list = [];
      this.pendingSends.set(channelId, list);
    }
    list.push(item);
  }

  private dispatch(channelId: string, msg: ChannelEnvelope): void {
    const set = this.subscribers.get(channelId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(msg);
      } catch (err) {
        console.error('Subscriber error:', err);
      }
    }
  }

  private closeSocket(channelId: string): void {
    const socket = this.sockets.get(channelId);
    if (socket) {
      try {
        socket.close();
      } catch {}
      this.sockets.delete(channelId);
    }
    this.pendingSends.delete(channelId);
  }
}

// Module-level registry: one DaemonChannel per daemonId, outliving any single screen/component.
export const channelRegistry = new Map<DaemonId, DaemonChannel>();

/** Returns the channel for `connection`, creating and registering it on first use. */
export function createDaemonChannel(connection: Connection): DaemonChannel {
  const existing = channelRegistry.get(connection.hostId);
  if (existing) return existing;
  const channel = new WebSocketDaemonChannel(connection);
  channelRegistry.set(connection.hostId, channel);
  return channel;
}

export function disposeDaemonChannel(hostId: DaemonId): void {
  const channel = channelRegistry.get(hostId);
  channel?.dispose();
  channelRegistry.delete(hostId);
}
