jest.mock('react-native', () => {
  const React = require('react');
  const element = (name: string) => ({ children, ...props }: { children?: React.ReactNode }) => React.createElement(name, props, children);
  const View = element('View');
  return {
    ActivityIndicator: element('ActivityIndicator'), Alert: { alert: jest.fn() }, FlatList: ({ ListEmptyComponent, data, renderItem, ...props }: { ListEmptyComponent?: React.ReactNode; data?: unknown[]; renderItem?: (info: { item: unknown; index: number }) => React.ReactNode }) => React.createElement('FlatList', props, data && renderItem ? data.map((item, index) => renderItem({ item, index })) : ListEmptyComponent),
    Keyboard: { addListener: () => ({ remove: jest.fn() }), dismiss: jest.fn() }, KeyboardAvoidingView: element('KeyboardAvoidingView'), Platform: { OS: 'web' }, Pressable: element('Pressable'),
    StyleSheet: { create: <T,>(styles: T) => styles }, Text: element('Text'), TextInput: element('TextInput'), View,
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  };
});
jest.mock('expo-crypto', () => ({ randomUUID: () => 'generated-tab' }));

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  return { SafeAreaView: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('SafeAreaView', props, children), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
jest.mock('@expo/vector-icons/Feather', () => ({ __esModule: true, default: () => null }));

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import AgentScreen from '../app/agent/[id]';
import type { AgentCapability, AgentEvent, AgentHistoryResponse } from './protocol';
import type { Connection, ConnectionStore } from './lib/connection';
import type { AgentWorkspaceTab } from './lib/tabs/types';

const mockConnection: Connection = {
  name: 'Test daemon', endpoint: 'https://daemon.test', hostId: 'host-1', token: 'secret', fingerprint: '', skipFingerprintVerification: false, clientName: 'test',
};
const mockStore: ConnectionStore = { connections: [mockConnection] };
const mockTab: AgentWorkspaceTab = {
  tabId: 'agent-tab', daemonId: mockConnection.hostId, kind: 'agent', title: 'Agent', createdAt: 0, lastActiveAt: 0, pinned: false,
  agentSessionId: 'agent-1', terminalSessionId: 'terminal-1', state: 'working', view: 'chat',
};
let mockCapabilities: AgentCapability[] = [];
const mockAgentHistory = jest.fn<Promise<AgentHistoryResponse>, [string]>(async () => ({ cursor: 0, events: [] }));

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null }, router: { replace: jest.fn(), push: jest.fn() }, useLocalSearchParams: () => ({ id: mockTab.tabId }),
}));
jest.mock('./lib/connection', () => ({
  loadConnections: jest.fn(async () => mockStore), getConnection: jest.fn(() => mockConnection),
}));
jest.mock('./lib/api', () => ({
  AgenticRemoteAPI: jest.fn(() => ({
    agent: jest.fn(async () => ({ state: 'working', capabilities: mockCapabilities })),
    agentHistory: mockAgentHistory,
    runtimeSnapshot: jest.fn(async () => ({ topology: [] })),
    submitAgentPrompt: jest.fn(), abortAgent: jest.fn(), closeSession: jest.fn(),
  })),
  APIError: class APIError extends Error {},
}));
jest.mock('./lib/daemon-channel', () => ({
  createDaemonChannel: jest.fn(() => ({ subscribe: jest.fn(() => jest.fn()), send: jest.fn(), closeChannel: jest.fn() })),
}));
let mockHandleEvent: ((event: AgentEvent) => void) | undefined;
let mockHandleCursorExpired: (() => Promise<number>) | undefined;
jest.mock('./lib/runtime-channel', () => ({
  createRuntimeChannel: jest.fn(() => ({
    openAgentChannel: jest.fn(async (_agentId: string, _after: number, fn: (event: AgentEvent) => void, onCursorExpired?: () => Promise<number>) => {
      mockHandleEvent = fn;
      mockHandleCursorExpired = onCursorExpired;
      return { channelId: 'agent-channel' };
    }),
    closeChannel: jest.fn(),
  })),
}));
const mockDispatch = jest.fn();
const mockCloseTab = jest.fn();
jest.mock('./lib/tabs/tab-store', () => ({
  useTabStore: () => ({ state: { tabs: [mockTab], activeId: mockTab.tabId, layout: {} }, dispatch: mockDispatch, closeTab: mockCloseTab }),
  addTab: jest.fn(), updateTab: jest.fn((state: unknown) => state),
}));
jest.mock('./components/Terminal', () => ({ Terminal: () => null }));
jest.mock('./components/ShortcutKeyboard', () => ({ ShortcutKeyboard: () => null }));
jest.mock('./components/TmuxPaneSheet', () => ({ TmuxPaneSheet: () => null }));

async function renderScreen(): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer;
  await act(async () => {
    tree = create(<AgentScreen />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return tree!;
}


beforeEach(() => {
  mockCapabilities = [];
  mockHandleEvent = undefined;
  mockHandleCursorExpired = undefined;
  mockAgentHistory.mockReset();
  mockAgentHistory.mockResolvedValue({ cursor: 0, events: [] });
  mockDispatch.mockClear();
  mockCloseTab.mockClear();
});

describe('AgentScreen capability gates', () => {
  it('shows terminal fallback and hides interactive controls without bridge capabilities', async () => {
    mockCapabilities = [{ name: 'chat', enabled: true }, { name: 'prompt', enabled: false }, { name: 'abort', enabled: false }];
    const tree = await renderScreen();

    expect(tree.root.findByProps({ accessibilityLabel: 'Open Terminal to interact' })).toBeTruthy();
    expect(() => tree.root.findByProps({ accessibilityLabel: 'Send Prompt' })).toThrow();
    expect(() => tree.root.findByProps({ accessibilityLabel: 'Abort' })).toThrow();
    act(() => tree.unmount());
  });

  it('shows prompt and Abort only when the bridge enables them', async () => {
    mockCapabilities = [{ name: 'chat', enabled: true }, { name: 'prompt', enabled: true }, { name: 'abort', enabled: true }];
    const tree = await renderScreen();

    expect(tree.root.findByProps({ accessibilityLabel: 'Send Prompt' })).toBeTruthy();
    expect(tree.root.findByProps({ accessibilityLabel: 'Abort' })).toBeTruthy();
    expect(() => tree.root.findByProps({ accessibilityLabel: 'Open Terminal to interact' })).toThrow();
    act(() => tree.unmount());
  });

  it('disables prompt/Abort when bridge fires a capability state event clearing them', async () => {
    mockCapabilities = [{ name: 'chat', enabled: true }, { name: 'prompt', enabled: true }, { name: 'abort', enabled: true }];
    const tree = await renderScreen();
    expect(tree.root.findByProps({ accessibilityLabel: 'Send Prompt' })).toBeTruthy();

    await act(async () => {
      mockHandleEvent?.({ type: 'state', agentId: 'agent-1', state: 'idle', capabilities: [{ name: 'chat', enabled: true }, { name: 'prompt', enabled: false }, { name: 'abort', enabled: false }] });
    });

    expect(tree.root.findByProps({ accessibilityLabel: 'Open Terminal to interact' })).toBeTruthy();
    expect(() => tree.root.findByProps({ accessibilityLabel: 'Send Prompt' })).toThrow();
    expect(() => tree.root.findByProps({ accessibilityLabel: 'Abort' })).toThrow();
    act(() => tree.unmount());
  });

  it('enables prompt/Abort when bridge fires a capability state event enabling them', async () => {
    mockCapabilities = [{ name: 'chat', enabled: true }, { name: 'prompt', enabled: false }, { name: 'abort', enabled: false }];
    const tree = await renderScreen();
    expect(tree.root.findByProps({ accessibilityLabel: 'Open Terminal to interact' })).toBeTruthy();

    await act(async () => {
      mockHandleEvent?.({ type: 'state', agentId: 'agent-1', state: 'working', capabilities: [{ name: 'chat', enabled: true }, { name: 'prompt', enabled: true }, { name: 'abort', enabled: true }] });
    });

    expect(tree.root.findByProps({ accessibilityLabel: 'Send Prompt' })).toBeTruthy();
    expect(tree.root.findByProps({ accessibilityLabel: 'Abort' })).toBeTruthy();
    expect(() => tree.root.findByProps({ accessibilityLabel: 'Open Terminal to interact' })).toThrow();
    act(() => tree.unmount());
  });

  it('recovers and resyncs visible screen after transient history failure on cursor expiry', async () => {
    mockCapabilities = [{ name: 'chat', enabled: true }, { name: 'prompt', enabled: true }, { name: 'abort', enabled: true }];
    mockAgentHistory.mockResolvedValueOnce({ cursor: 0, events: [] });
    const tree = await renderScreen();

    expect(mockHandleCursorExpired).toBeDefined();

    mockAgentHistory
      .mockRejectedValueOnce(new Error('transient history failure'))
      .mockResolvedValueOnce({
        cursor: 12,
        events: [
          {
            eventId: 'evt-rec-1',
            agentId: 'agent-1',
            type: 'message.assistant',
            text: 'Resynced after transient error',
            state: 'idle',
            cursor: 12,
          },
        ],
      });

    jest.useFakeTimers();
    let cursorPromise: Promise<number> | undefined;
    act(() => {
      cursorPromise = mockHandleCursorExpired!();
    });

    await act(async () => {
      await jest.advanceTimersByTimeAsync(300);
    });

    const cursor = await cursorPromise!;
    expect(cursor).toBe(12);
    expect(mockAgentHistory).toHaveBeenCalledTimes(3);

    expect(
      tree.root.findAll((node) => node.props?.children === 'Resynced after transient error').length,
    ).toBeGreaterThan(0);
    expect(mockDispatch).toHaveBeenCalledWith(expect.any(Function));

    act(() => tree.unmount());
    jest.useRealTimers();
  });
});