import type { Connection } from './connection';
import { MockDaemonChannel } from './mock/mock-channel';
import type { SessionSummary, WaitState } from '../protocol';
import type { AgentSessionEvent, RpcCommand, RpcResponse } from './tabs/rpc-types';
import type { DaemonId, TabKind } from './tabs/types';

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

export type AgentChannelFrame = RpcCommand | RpcResponse | AgentSessionEvent;

export type DesktopChannelFrame =
  | { type: 'vnc.data'; data: string } // base64 raw RFB bytes, bidirectional
  | { type: 'vnc.resize'; width: number; height: number }; // server -> client

type ErrorChannelFrame = { type: 'error'; code: string; message: string };

export type ChannelFramePayload = PTYChannelFrame | AgentChannelFrame | DesktopChannelFrame | ErrorChannelFrame;

/**
 * Every PTY/agent-RPC/VNC-byte frame gets tagged with the tab's `channelId`
 * so N tabs share 1 socket. This is the frontend-authored spec the mock
 * adapter implements today (`mock/mock-channel.ts`); the real daemon
 * gateway (`/v1/ws/gateway`, follow-up phase) must match this shape.
 */
export type ChannelEnvelope = { channelId: string; kind: TabKind } & ChannelFramePayload;

export type ChannelStatus = 'connecting' | 'open' | 'closed' | 'error';

/**
 * One `DaemonChannel` per paired daemon multiplexes every open tab's traffic.
 * Implementations: `MockDaemonChannel` (in-process, phase 2) now, a real
 * `WebSocketDaemonChannel` against `/v1/ws/gateway` later (follow-up phase).
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
}

// Module-level registry: one DaemonChannel per daemonId, outliving any
// single screen/component. Tabs survive navigation because the channel
// they read from is never owned by a route. Exported directly (no
// get/set/delete wrappers) — callers use Map methods.
// ponytail: no full-channel teardown on removal yet (real WS close is a
// follow-up-phase concern); callers close individual tab channels first.
export const channelRegistry = new Map<DaemonId, DaemonChannel>();

// ============================================================================
// Factory: real WS impl is a follow-up phase (§10 of the plan); until then
// every daemon gets an in-process mock. One factory call site means the
// swap later touches this function only, not every caller.
// ============================================================================

/** Returns the channel for `connection`, creating and registering it on first use. */
export function createDaemonChannel(connection: Connection): DaemonChannel {
  const existing = channelRegistry.get(connection.hostId);
  if (existing) return existing;
  const channel = new MockDaemonChannel(connection.hostId);
  channelRegistry.set(connection.hostId, channel);
  return channel;
}
