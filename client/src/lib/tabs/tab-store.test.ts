import { addTab, closeTab, updateTab } from './tab-store';
import type { TabDeckState, TerminalWorkspaceTab } from './types';

const baseState: TabDeckState = { tabs: [], activeId: null, layout: {} };

function terminalTab(tabId: string): TerminalWorkspaceTab {
  return { kind: 'terminal', tabId, daemonId: 'host-1', remoteSessionId: 'sess-1', title: 'term', state: 'running', createdAt: 0, lastActiveAt: 0, pinned: false };
}
describe('tab-store reducers', () => {
  it('addTab appends and activates a new tab', () => {
    const s1 = addTab(baseState, terminalTab('t1'));
    expect(s1.tabs.map((t) => t.tabId)).toEqual(['t1']);
    expect(s1.activeId).toBe('t1');
  });

  it('addTab replaces an existing tab by id instead of duplicating', () => {
    const s1 = addTab(baseState, terminalTab('t1'));
    const s2 = addTab(s1, { ...terminalTab('t1'), title: 'renamed' });
    expect(s2.tabs.length).toBe(1);
    expect(s2.tabs[0].title).toBe('renamed');
  });

  it('closeTab removes the tab and falls back activeId to the last remaining tab', () => {
    const s1 = addTab(addTab(baseState, terminalTab('t1')), terminalTab('t2'));
    const s2 = closeTab(s1, 't2');
    expect(s2.tabs.map((t) => t.tabId)).toEqual(['t1']);
    expect(s2.activeId).toBe('t1');
  });

  it('closeTab clears activeId when no tabs remain', () => {
    const s1 = addTab(baseState, terminalTab('t1'));
    const s2 = closeTab(s1, 't1');
    expect(s2.tabs).toEqual([]);
    expect(s2.activeId).toBeNull();
  });

  it('updateTab patches only the matching tab', () => {
    const s1 = addTab(addTab(baseState, terminalTab('t1')), terminalTab('t2'));
    const s2 = updateTab(s1, 't1', { title: 'patched' });
    expect(s2.tabs.find((t) => t.tabId === 't1')?.title).toBe('patched');
    expect(s2.tabs.find((t) => t.tabId === 't2')?.title).toBe('term');
  });
});
