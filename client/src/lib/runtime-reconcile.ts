import type { AgentEvent, RuntimeSnapshot } from '../protocol';
import { AgenticRemoteAPI } from './api';
import type { Connection } from './connection';
import { createRuntimeChannel } from './runtime-channel';

export type DaemonRuntime = {
	snapshot?: RuntimeSnapshot;
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

// One reconciliation owns one daemon's snapshot cursor and its live channels.
export async function reconcileDaemon(connection: Connection, update: (runtime: DaemonRuntime) => void): Promise<() => void> {
  const api = new AgenticRemoteAPI(connection);
  let snapshot = await api.runtimeSnapshot();
  let active = true;
  const channel = createRuntimeChannel(connection);
  const channelIds: string[] = [];

  update({ snapshot, status: 'ready' });
  for (const agent of snapshot.agents) {
    const { channelId } = await channel.openAgentChannel(agent.id, snapshot.cursor, (event) => {
      if (!active) return;
      snapshot = applyAgentEvent(snapshot, event);
      update({ snapshot, status: 'ready' });
    });
    channelIds.push(channelId);
  }

  return () => {
    active = false;
    for (const channelId of channelIds) channel.closeChannel(channelId);
  };
}
