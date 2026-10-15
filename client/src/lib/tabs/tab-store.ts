import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { AgentSession, RuntimeSnapshot } from '../../protocol';
import type { DaemonChannel } from '../daemon-channel';
import { channelRegistry } from '../daemon-channel';
import type { DaemonId, SplitLayout, TabDeckState, WorkspaceTab } from './types';

// ============================================================================
// State Reducers
// ============================================================================

export function addTab(state: TabDeckState, tab: WorkspaceTab, replaceActive?: boolean): TabDeckState {
  const tabs = [...state.tabs];
  const existing = tabs.findIndex((t) => t.tabId === tab.tabId);
  if (existing >= 0) {
    tabs[existing] = tab;
  } else if (replaceActive && state.activeId) {
    const activeIdx = tabs.findIndex((t) => t.tabId === state.activeId);
    if (activeIdx >= 0) tabs[activeIdx] = tab;
    else tabs.push(tab);
  } else {
    tabs.push(tab);
  }
  return { ...state, tabs, activeId: tab.tabId, layout: state.layout };
}

export function closeTab(state: TabDeckState, tabId: string): TabDeckState {
  const tabs = state.tabs.filter((t) => t.tabId !== tabId);
  let activeId = state.activeId;
  if (activeId === tabId) {
    activeId = tabs.length > 0 ? tabs[tabs.length - 1].tabId : null;
  }
  return { ...state, tabs, activeId, layout: state.layout };
}

export function updateTab(state: TabDeckState, tabId: string, diff: Partial<WorkspaceTab>): TabDeckState {
  const tabs = state.tabs.map((t) => (t.tabId === tabId ? ({ ...t, ...diff } as WorkspaceTab) : t));
  return { ...state, tabs };
}

// Runtime snapshots are authoritative for remote agent lifetime. Remove local
// presentation tabs for agents that have exited so they cannot keep a dead card
// alive across a runtime resync.
export function removeExitedAgentTabs(state: TabDeckState, daemonId: DaemonId, agents: readonly AgentSession[]): TabDeckState {
  const exitedAgentIds = new Set(agents.filter((agent) => agent.state === 'exited').map((agent) => agent.id));
  if (exitedAgentIds.size === 0) return state;

  const tabs = state.tabs.filter((tab) => tab.daemonId !== daemonId || tab.kind !== 'agent' || !exitedAgentIds.has(tab.agentSessionId));
  if (tabs.length === state.tabs.length) return state;

  const activeId = tabs.some((tab) => tab.tabId === state.activeId) ? state.activeId : (tabs.length > 0 ? tabs[tabs.length - 1].tabId : null);
  return { ...state, tabs, activeId, layout: state.layout };
}

// Runtime snapshots are authoritative for remote terminal lifetime. Remove local
// presentation tabs for terminals that have exited so a stuck/orphaned tab (e.g.
// one whose exited-session.state frame never reached this client) cannot keep a
// dead card alive across a runtime resync or reload.
export function removeExitedTerminalTabs(state: TabDeckState, daemonId: DaemonId, terminals: ReadonlyArray<RuntimeSnapshot['terminals'][number]>): TabDeckState {
  const exitedTerminalIds = new Set(terminals.filter((terminal) => terminal.exited).map((terminal) => terminal.id));
  if (exitedTerminalIds.size === 0) return state;

  const tabs = state.tabs.filter((tab) => tab.daemonId !== daemonId || tab.kind !== 'terminal' || !exitedTerminalIds.has(tab.remoteSessionId));
  if (tabs.length === state.tabs.length) return state;

  const activeId = tabs.some((tab) => tab.tabId === state.activeId) ? state.activeId : (tabs.length > 0 ? tabs[tabs.length - 1].tabId : null);
  return { ...state, tabs, activeId, layout: state.layout };
}

// ============================================================================
// Store Implementation (Plain React Context + State)
// ============================================================================

export type TabStore = {
  state: TabDeckState;
  dispatch: (updater: (prev: TabDeckState) => TabDeckState) => void;
  closeTab: (tabId: string) => void;
  activateTab: (tabId: string) => void;
  getChannel: (daemonId: string) => DaemonChannel | undefined;
};
const defaultState: TabDeckState = { tabs: [], activeId: null, layout: {} };
const webDeckStorageKey = 'agenticremote.tab-deck';
const DeckContext = createContext<TabStore | null>(null);

export function useTabStore(): TabStore {
  const ctx = useContext(DeckContext);
  if (!ctx) throw new Error('useTabStore must be bounded by a TabDeckProvider');
  return ctx;
}

/** Root provider rendering wrapping the layout */
export function useProvideTabStore(): TabStore {
  const [state, setState] = useState<TabDeckState>(() => {
    if (typeof sessionStorage === 'undefined') return defaultState;
    try {
      const stored = sessionStorage.getItem(webDeckStorageKey);
      if (!stored) return defaultState;
      const parsed: unknown = JSON.parse(stored);
      if (!parsed || typeof parsed !== 'object' || !('tabs' in parsed) || !Array.isArray(parsed.tabs)) return defaultState;
      return parsed as TabDeckState;
    } catch {
      return defaultState;
    }
  });

  const dispatch = useCallback((updater: (prev: TabDeckState) => TabDeckState) => setState((previous) => {
    const next = updater(previous);
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(webDeckStorageKey, JSON.stringify(next));
    return next;
  }), []);
  const closeTabAction = useCallback((tabId: string) => setState((previous) => {
    const next = closeTab(previous, tabId);
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(webDeckStorageKey, JSON.stringify(next));
    return next;
  }), []);
  const activateTab = useCallback((tabId: string) => setState((previous) => {
    const next = { ...previous, activeId: tabId };
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(webDeckStorageKey, JSON.stringify(next));
    return next;
  }), []);
  const getChannel = useCallback((daemonId: string) => channelRegistry.get(daemonId), []);

  return useMemo<TabStore>(
    () => ({ state, dispatch, closeTab: closeTabAction, activateTab, getChannel }),
    [state, dispatch, closeTabAction, activateTab, getChannel],
  );
}

export const TabDeckProvider = DeckContext.Provider;
