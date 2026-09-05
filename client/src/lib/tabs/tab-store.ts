import { createContext, useContext, useMemo, useState } from 'react';
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
const DeckContext = createContext<TabStore | null>(null);

export function useTabStore(): TabStore {
  const ctx = useContext(DeckContext);
  if (!ctx) throw new Error('useTabStore must be bounded by a TabDeckProvider');
  return ctx;
}

/** Root provider rendering wrapping the layout */
export function useProvideTabStore(): TabStore {
  const [state, setState] = useState<TabDeckState>(defaultState);

  const contextValue = useMemo<TabStore>(() => {
    return {
      state,
      dispatch: setState,
      closeTab: (tabId) => setState((prev) => closeTab(prev, tabId)),
      activateTab: (tabId) => setState((prev) => ({ ...prev, activeId: tabId })),
      getChannel: (daemonId) => channelRegistry.get(daemonId),
    };
  }, [state]);

  return contextValue;
}

export const TabDeckProvider = DeckContext.Provider;
