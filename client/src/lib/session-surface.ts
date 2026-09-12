import type { AgentSession, RuntimeSnapshot } from '../protocol';
import type { TabKind, WorkspaceTab } from './tabs/types';

// One dashboard row per remote runtime surface (agent/terminal) or tab-only surface
// (files/desktop), merging daemon snapshot rows with local tab presentation state.
// A local tab wins over its remote counterpart so its title/pinned/view state survives;
// an agent's backing terminal never appears as its own standalone row.
export type SessionSurface = {
  key: string;
  kind: TabKind;
  title: string;
  status: string;
  tab?: WorkspaceTab;
  agent?: AgentSession;
  terminal?: RuntimeSnapshot['terminals'][number];
};

const agentStatusRank = (state: AgentSession['state']) => ({ needsYou: 0, working: 1, idle: 2, exited: 3 })[state];

export function buildSessionSurfaces(daemonId: string, snapshot: RuntimeSnapshot | undefined, tabs: WorkspaceTab[]): SessionSurface[] {
  const daemonTabs = tabs.filter((tab) => tab.daemonId === daemonId);
  const agentTerminalIds = new Set((snapshot?.agents ?? []).map((agent) => agent.terminalSessionId));
  const consumedAgentIds = new Set<string>();
  const consumedTerminalIds = new Set<string>();
  const agentSurfaces: SessionSurface[] = [];
  const terminalSurfaces: SessionSurface[] = [];
  const otherSurfaces: SessionSurface[] = [];

  for (const tab of daemonTabs) {
    if (tab.kind === 'agent') {
      consumedAgentIds.add(tab.agentSessionId);
      const agent = snapshot?.agents.find((candidate) => candidate.id === tab.agentSessionId);
      agentSurfaces.push({ key: `agent:${tab.agentSessionId}`, kind: 'agent', tab, title: tab.title, status: agent?.state ?? tab.state, agent });
    } else if (tab.kind === 'terminal') {
      consumedTerminalIds.add(tab.remoteSessionId);
      const terminal = snapshot?.terminals.find((candidate) => candidate.id === tab.remoteSessionId);
      terminalSurfaces.push({ key: `terminal:${tab.remoteSessionId}`, kind: 'terminal', tab, title: terminal?.name || tab.title, status: terminal ? (terminal.exited ? 'exited' : 'running') : tab.state, terminal });
    } else {
      otherSurfaces.push({ key: `${tab.kind}:${tab.tabId}`, kind: tab.kind, tab, title: tab.title, status: tab.kind === 'files' ? 'Navigating' : tab.state });
    }
  }

  for (const agent of snapshot?.agents ?? []) {
    if (consumedAgentIds.has(agent.id)) continue;
    agentSurfaces.push({ key: `agent:${agent.id}`, kind: 'agent', title: agent.adapter || 'OMP Agent', status: agent.state, agent });
  }
  for (const terminal of snapshot?.terminals ?? []) {
    if (consumedTerminalIds.has(terminal.id) || agentTerminalIds.has(terminal.id)) continue;
    terminalSurfaces.push({ key: `terminal:${terminal.id}`, kind: 'terminal', title: terminal.name || 'Shell', status: terminal.exited ? 'exited' : 'running', terminal });
  }

  agentSurfaces.sort((a, b) => agentStatusRank(a.status as AgentSession['state']) - agentStatusRank(b.status as AgentSession['state']));
  return [...agentSurfaces, ...terminalSurfaces, ...otherSurfaces];
}
