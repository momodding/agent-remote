import type { AgentEvent, Capability, RuntimeLifecycleEvent, RuntimeSnapshot } from '../protocol';
import { AgenticRemoteAPI } from './api';
import type { Connection } from './connection';
import { createRuntimeChannel } from './runtime-channel';

export type DaemonRuntime = {
	snapshot?: RuntimeSnapshot;
	capabilities?: Capability[];
	status: 'ready' | 'error';
	error?: string;
}

export function applyAgentEvent(snapshot: RuntimeSnapshot, event: AgentEvent): RuntimeSnapshot {
  if (!event.state) return snapshot;
  return {
    ...snapshot,
    agents: snapshot.agents.map((agent) => agent.id === event.agentId ? { ...agent, state: event.state as typeof agent.state } : agent),
  };
}

export function applyRuntimeEvent(snapshot: RuntimeSnapshot, event: RuntimeLifecycleEvent, cursor: number): RuntimeSnapshot {
  const payload = event.payload as Record<string, unknown>;
  const withCursor = { ...snapshot, cursor: Math.max(snapshot.cursor, cursor) };
  if (event.type === 'terminal.removed') return { ...withCursor, terminals: snapshot.terminals.filter((terminal) => terminal.id !== event.surfaceId) };
  if (event.type.startsWith('terminal.')) {
    const terminal = payload as RuntimeSnapshot['terminals'][number];
    return { ...withCursor, terminals: [...snapshot.terminals.filter((current) => current.id !== terminal.id), terminal] };
  }
  if (event.type.startsWith('agent.')) {
    const agent = payload as RuntimeSnapshot['agents'][number];
    return { ...withCursor, agents: [...snapshot.agents.filter((current) => current.id !== agent.id), agent] };
  }
  if (event.type === 'tmux.topology' && Array.isArray(event.payload)) return { ...withCursor, topology: event.payload as RuntimeSnapshot['topology'] };
  return withCursor;
}

// One reconciliation owns one daemon's snapshot cursor and its live channels.
export async function reconcileDaemon(connection: Connection, update: (runtime: DaemonRuntime) => void): Promise<() => void> {
  const api = new AgenticRemoteAPI(connection);
  let snapshot = await api.runtimeSnapshot();
  let active = true;
  const capabilities = await api.capabilities().then((info) => info.capabilities).catch(() => undefined);
  if (active) update({ snapshot, capabilities, status: 'ready' });
  const channel = createRuntimeChannel(connection);
  const { channelId } = await channel.openRuntimeChannel(snapshot.cursor, (event) => {
    if (!active) return;
    snapshot = applyRuntimeEvent(snapshot, event, event.cursor ?? snapshot.cursor);
    update({ snapshot, capabilities, status: 'ready' });
  }, async () => {
    snapshot = await api.runtimeSnapshot();
    if (active) update({ snapshot, capabilities, status: 'ready' });
    return snapshot.cursor;
  });

  return () => {
    active = false;
    channel.closeChannel(channelId);
  };
}

