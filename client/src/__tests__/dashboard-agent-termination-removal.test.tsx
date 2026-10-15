/**
 * MANUAL-004: Dashboard Agent Termination Removal Regression Tests
 *
 * **Scope**: Runtime event reconciliation, local tab cleanup, and dashboard
 * surface construction for exited agents.
 *
 * **What These Tests Prove**:
 * 1. An `agent.updated` event can update a runtime snapshot to `exited`.
 * 2. Dashboard reconciliation removes a matching local agent tab.
 * 3. Surface construction never renders an exited agent, including one with a
 *    stale local tab.
 *
 * **Manual Operator Finding — OPEN**:
 * Real daemon/browser validation remains pending. These tests do not prove
 * backend event delivery or the browser subscription lifecycle.
 */

import { act } from 'react-test-renderer';
import { buildSessionSurfaces } from '../lib/session-surface';
import { applyRuntimeEvent } from '../lib/runtime-reconcile';
import type { RuntimeSnapshot, AgentEvent } from '../protocol';
import type { WorkspaceTab } from '../lib/tabs/types';

describe('MANUAL-004: Dashboard Agent Termination Removal', () => {
  describe('Scenario: Remote agent terminated without local tab', () => {
    it('dashboard card auto-removes when agent.exited event received and snapshot resynced', () => {
      // Setup: Initial snapshot with one running agent, no local tab
      const initialSnapshot: RuntimeSnapshot = {
        cursor: 10,
        agents: [
          {
            id: 'remote-agent-1',
            adapter: 'omp',
            terminalSessionId: 'term-remote-1',
            cwd: '/home/user',
            state: 'working',
            capabilities: [
              { name: 'chat', enabled: true },
              { name: 'prompt', enabled: true },
            ],
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ],
        terminals: [
          {
            id: 'term-remote-1',
            name: 'agent pty',
            cwd: '/home/user',
            seq: 0,
            exited: false,
          },
        ],
        topology: [],
        desktops: [],
      };

      // Initial state: no local tabs for this daemon
      const localTabs: WorkspaceTab[] = [];

      // Verify initial surface: card is active (agent running, no local tab)
      let surfaces = buildSessionSurfaces('daemon-a', initialSnapshot, localTabs);
      expect(surfaces).toContainEqual(
        expect.objectContaining({
          key: 'agent:remote-agent-1',
          kind: 'agent',
          status: 'working',
          active: true,
          agent: initialSnapshot.agents[0],
        })
      );
      const exitedAgentSnapshot = applyRuntimeEvent(
        initialSnapshot,
        {
          type: 'agent.updated',
          surfaceId: 'remote-agent-1',
          payload: {
            id: 'remote-agent-1',
            adapter: 'omp',
            terminalSessionId: 'term-remote-1',
            cwd: '/home/user',
            state: 'exited', // ← State changed to exited
            capabilities: [
              { name: 'chat', enabled: true },
              { name: 'prompt', enabled: false },
              { name: 'abort', enabled: false },
              { name: 'model', enabled: false },
              { name: 'thinking', enabled: false },
            ],
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:05:00Z',
          },
        },
        11
      );

      // Verify snapshot reflects exited state
      expect(exitedAgentSnapshot.agents[0].state).toBe('exited');
      expect(exitedAgentSnapshot.cursor).toBe(11);

      // KEY TEST: Rebuild surfaces after snapshot update
      // Dashboard component calls buildSessionSurfaces on every render with new snapshot
      surfaces = buildSessionSurfaces('daemon-a', exitedAgentSnapshot, localTabs);

      // Card MUST disappear because:
      // 1. Agent state = 'exited'
      // 2. No local tab exists for this agent (consumedAgentIds is empty)
      // 3. session-surface.ts:47 filters out exited agents with no tabs
      expect(surfaces).not.toContainEqual(
        expect.objectContaining({
          key: 'agent:remote-agent-1',
        })
      );
      expect(surfaces.length).toBe(0); // Only one agent, it's exited, no other surfaces
    });

    it('hides an exited agent card even when a local tab is stale', () => {
      // Setup: Agent running, user has a pinned local tab for it
      const initialSnapshot: RuntimeSnapshot = {
        cursor: 20,
        agents: [
          {
            id: 'pinned-agent',
            adapter: 'omp',
            terminalSessionId: 'term-pinned',
            cwd: '/home/user',
            state: 'working',
            capabilities: [
              { name: 'chat', enabled: true },
              { name: 'prompt', enabled: true },
            ],
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ],
        terminals: [
          {
            id: 'term-pinned',
            name: 'agent pty',
            cwd: '/home/user',
            seq: 0,
            exited: false,
          },
        ],
        topology: [],
        desktops: [],
      };

      const localTabs: WorkspaceTab[] = [
        {
          tabId: 'tab-pinned-agent',
          daemonId: 'daemon-a',
          kind: 'agent',
          title: 'My Pinned Agent',
          createdAt: 1000,
          lastActiveAt: 2000,
          pinned: true,
          agentSessionId: 'pinned-agent',
          terminalSessionId: 'term-pinned',
          state: 'working',
          view: 'chat',
        },
      ];

      // Simulate agent exiting
      const exitedSnapshot = applyRuntimeEvent(
        initialSnapshot,
        {
          type: 'agent.updated',
          surfaceId: 'pinned-agent',
          payload: {
            id: 'pinned-agent',
            adapter: 'omp',
            terminalSessionId: 'term-pinned',
            cwd: '/home/user',
            state: 'exited',
            capabilities: [
              { name: 'chat', enabled: true },
              { name: 'prompt', enabled: false },
              { name: 'abort', enabled: false },
              { name: 'model', enabled: false },
              { name: 'thinking', enabled: false },
            ],
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:05:00Z',
          },
        },
        21
      );

      const surfaces = buildSessionSurfaces('daemon-a', exitedSnapshot, localTabs);
      // The runtime snapshot is authoritative; a stale local tab must not retain
      // an exited agent card while the dashboard reconciliation removes the tab.
      expect(surfaces).not.toContainEqual(
        expect.objectContaining({ key: 'agent:pinned-agent' }),
      );
    });

    it('dashboard card removal persists across refresh when backend state reloaded', () => {
      // Setup: Daemon reconnects, backend re-syncs state including exited agent
      const refreshedSnapshot: RuntimeSnapshot = {
        cursor: 50,
        agents: [
          {
            id: 'exited-after-reconnect',
            adapter: 'omp',
            terminalSessionId: 'term-exited-reconnect',
            cwd: '/home/user',
            state: 'exited', // Persisted to disk, reloaded on reconnect
            capabilities: [
              { name: 'chat', enabled: true },
              { name: 'prompt', enabled: false },
              { name: 'abort', enabled: false },
              { name: 'model', enabled: false },
              { name: 'thinking', enabled: false },
            ],
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:05:00Z',
          },
        ],
        terminals: [],
        topology: [],
        desktops: [],
      };

      const localTabs: WorkspaceTab[] = []; // User didn't open a tab for this agent

      // Rebuild surfaces from refreshed snapshot
      const surfaces = buildSessionSurfaces('daemon-b', refreshedSnapshot, localTabs);

      // Card MUST remain absent: exited agent, no local tab → filtered out
      expect(surfaces).not.toContainEqual(
        expect.objectContaining({
          key: 'agent:exited-after-reconnect',
        })
      );
      expect(surfaces.length).toBe(0);
    });
  });

  describe('Scenario: Mixed agents and terminals', () => {
    it('only terminated agent card removed, terminals and other agents unaffected', () => {
      const initialSnapshot: RuntimeSnapshot = {
        cursor: 30,
        agents: [
          {
            id: 'keep-agent',
            adapter: 'omp',
            terminalSessionId: 'term-keep',
            cwd: '/home',
            state: 'idle',
            capabilities: [],
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
          {
            id: 'terminate-agent',
            adapter: 'omp',
            terminalSessionId: 'term-term',
            cwd: '/home',
            state: 'working',
            capabilities: [],
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ],
        terminals: [
          {
            id: 'term-keep',
            name: 'Keep agent pty',
            cwd: '/home',
            seq: 0,
            exited: false,
          },
          {
            id: 'term-term',
            name: 'Terminate agent pty',
            cwd: '/home',
            seq: 0,
            exited: false,
          },
          {
            id: 'term-standalone',
            name: 'Standalone Shell',
            cwd: '/home',
            seq: 0,
            exited: false,
          },
        ],
        topology: [],
        desktops: [],
      };

      let surfaces = buildSessionSurfaces('daemon-c', initialSnapshot, []);
      expect(surfaces.length).toBe(3); // 2 agents + 1 standalone terminal
      expect(surfaces.map((s) => s.key)).toEqual(
        expect.arrayContaining([
          'agent:keep-agent',
          'agent:terminate-agent',
          'terminal:term-standalone',
        ])
      );

      // Only terminate-agent exits
      const updatedSnapshot = applyRuntimeEvent(
        initialSnapshot,
        {
          type: 'agent.updated',
          surfaceId: 'terminate-agent',
          payload: {
            ...initialSnapshot.agents[1],
            state: 'exited',
          },
        },
        31
      );

      surfaces = buildSessionSurfaces('daemon-c', updatedSnapshot, []);

      // keep-agent and standalone terminal remain; terminate-agent gone
      expect(surfaces.length).toBe(2);
      expect(surfaces.map((s) => s.key)).toEqual(
        expect.arrayContaining(['agent:keep-agent', 'terminal:term-standalone'])
      );
      expect(surfaces.map((s) => s.key)).not.toContain('agent:terminate-agent');
    });
  });
});
