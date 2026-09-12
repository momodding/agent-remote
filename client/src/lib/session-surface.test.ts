import { buildSessionSurfaces } from './session-surface';
import type { RuntimeSnapshot } from '../protocol';
import type { WorkspaceTab } from './tabs/types';

const agent = { id: 'agent-a', adapter: 'omp', terminalSessionId: 'term-agent', cwd: '', state: 'working' as const, capabilities: [], createdAt: '', updatedAt: '' };
const standaloneTerminal = { id: 'term-b', name: 'Shell', cwd: '', seq: 0, exited: false };
const snapshot: RuntimeSnapshot = { cursor: 1, agents: [agent], terminals: [{ id: 'term-agent', name: 'agent pty', cwd: '', seq: 0, exited: false }, standaloneTerminal], topology: [], desktops: [] };

describe('buildSessionSurfaces', () => {
  it('hides an agent backing terminal as its own row', () => {
    const surfaces = buildSessionSurfaces('host', snapshot, []);
    expect(surfaces.map((s) => s.key)).toEqual(['agent:agent-a', 'terminal:term-b']);
  });

  it('never duplicates a remote row already represented by a local tab', () => {
    const tabs: WorkspaceTab[] = [{ tabId: 'tab-1', daemonId: 'host', kind: 'agent', title: 'Pinned agent', createdAt: 0, lastActiveAt: 0, pinned: true, agentSessionId: 'agent-a', terminalSessionId: 'term-agent', state: 'working', view: 'chat' }];
    const surfaces = buildSessionSurfaces('host', snapshot, tabs);
    const agentRows = surfaces.filter((s) => s.kind === 'agent');
    expect(agentRows).toHaveLength(1);
    expect(agentRows[0]).toMatchObject({ tab: tabs[0], title: 'Pinned agent' });
  });

  it('ignores tabs and snapshot rows from other daemons', () => {
    const tabs: WorkspaceTab[] = [{ tabId: 'tab-2', daemonId: 'other-host', kind: 'files', title: 'Files', createdAt: 0, lastActiveAt: 0, pinned: false, cwd: '' }];
    const surfaces = buildSessionSurfaces('host', snapshot, tabs);
    expect(surfaces.some((s) => s.key.includes('files'))).toBe(false);
  });
});
