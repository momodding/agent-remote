import { applyAgentEvent } from './runtime-reconcile';

describe('applyAgentEvent', () => {
  const snapshot = {
    cursor: 42,
    terminals: [],
    topology: [],
    desktops: [],
    agents: [
      { id: 'agent-a', adapter: 'omp', terminalSessionId: 'terminal-a', cwd: '', state: 'idle' as const, capabilities: [], createdAt: '', updatedAt: '' },
      { id: 'agent-b', adapter: 'omp', terminalSessionId: 'terminal-b', cwd: '', state: 'working' as const, capabilities: [], createdAt: '', updatedAt: '' },
    ],
  };

  it('updates only the event target inside its daemon snapshot', () => {
    const next = applyAgentEvent(snapshot, { type: 'state', agentId: 'agent-a', state: 'needsYou', cursor: 43 });
    expect(next.agents.map((agent) => agent.state)).toEqual(['needsYou', 'working']);
    expect(snapshot.agents.map((agent) => agent.state)).toEqual(['idle', 'working']);
  });
});
