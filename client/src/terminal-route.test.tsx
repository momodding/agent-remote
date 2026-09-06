jest.mock("react-native-safe-area-context", () => ({ ...jest.requireActual("react-native-safe-area-context"), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@expo/vector-icons/Feather', () => ({ __esModule: true, default: () => null }));
jest.mock('expo-blur', () => ({ BlurView: () => null }));

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, type AlertButton } from 'react-native';
import { router } from 'expo-router';
import TerminalScreen from '../app/terminal/[id]';
import type { Connection, ConnectionStore } from './lib/connection';
import { APIError } from './lib/api';
import type { ChannelEnvelope } from './lib/daemon-channel';
import type { TerminalWorkspaceTab } from './lib/tabs/types';

const mockCloseSession = jest.fn();
const mockChannel = {
  daemonId: 'mock-host-id',
  status: 'open' as const,
  send: jest.fn(),
  subscribe: jest.fn((_channelId: string, fn: (msg: ChannelEnvelope) => void) => { mockSubscribers.push(fn); return jest.fn(); }),
  openChannel: jest.fn(async () => 'mock-channel-id'),
  closeChannel: jest.fn(),
};
let mockSubscribers: Array<(msg: ChannelEnvelope) => void> = [];
const emit = (msg: ChannelEnvelope) => act(() => mockSubscribers.forEach((fn) => fn(msg)));

let mockTerminalInput: ((data: string) => void) | undefined;
let mockShortcutInput: ((data: string) => void) | undefined;

const mockConnection: Connection = {
  name: 'Test daemon',
  endpoint: 'https://daemon.test',
  hostId: 'mock-host-id',
  token: 'secret',
  fingerprint: '',
  skipFingerprintVerification: false,
  clientName: 'test',
};
const mockStore: ConnectionStore = { connections: [mockConnection] };
const mockTab: TerminalWorkspaceTab = {
  tabId: 'session', daemonId: mockConnection.hostId, kind: 'terminal', title: 'Shell',
  createdAt: 0, lastActiveAt: 0, pinned: false, remoteSessionId: 'session', state: 'connecting',
};
let mockParams: { id: string; mode?: string } = { id: 'session', mode: undefined };
let mockCloseTab = jest.fn();

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { replace: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('./lib/connection', () => ({
  loadConnections: jest.fn(async () => mockStore),
  getConnection: jest.fn((s: ConnectionStore, hostId: string | null) =>
    s.connections.find((c) => c.hostId === hostId) ?? null),
}));
jest.mock('./lib/api', () => {
  class APIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return { AgenticRemoteAPI: jest.fn(() => ({ closeSession: mockCloseSession, shells: jest.fn(async () => []) })), APIError };
});
jest.mock('./lib/daemon-channel', () => ({ createDaemonChannel: jest.fn(() => mockChannel) }));
jest.mock('./lib/tabs/tab-store', () => ({
  useTabStore: () => ({ state: { tabs: [mockTab], activeId: 'session', layout: {} }, closeTab: mockCloseTab, activateTab: jest.fn(), getChannel: () => mockChannel }),
}));
let mockTerminalOutput: string | undefined;
jest.mock('./components/Terminal', () => ({
  Terminal: (props: { output: string; onInput: (data: string) => void }) => { mockTerminalOutput = props.output; mockTerminalInput = props.onInput; return null; },
}));
jest.mock('./components/ShortcutKeyboard', () => {
  const React = require('react');
  return { ShortcutKeyboard: React.forwardRef((props: { onInput: (data: string) => void }, ref: React.ForwardedRef<{ input: (data: string) => void }>) => {
    mockShortcutInput = props.onInput;
    React.useImperativeHandle(ref, () => ({ input: (data: string) => props.onInput(`modified:${data}`) }));
    return null;
  }) };
});

async function renderScreen() {
  let tree: ReactTestRenderer;
  await act(async () => {
    tree = create(<TerminalScreen />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return tree!;
}

it('routes native terminal input through shortcut modifier before channel send', async () => {
  await renderScreen();

  act(() => mockTerminalInput?.('c'));

  expect(mockShortcutInput).toBeDefined();
  expect(mockChannel.send).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'session', type: 'pty.input' }));
});

function actionFor(tree: ReactTestRenderer, label: string) {
  return tree.root.findByProps({ accessibilityLabel: label }).props.onPress as () => void;
}

function confirmation() {
  const buttons = (jest.mocked(Alert.alert).mock.calls.at(-1)?.[2] ?? []) as AlertButton[];
  return buttons;
}

describe('terminal route connection resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSubscribers = [];
    mockParams = { id: 'session', mode: undefined };
    jest.spyOn(Alert, 'alert');
    mockCloseSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('alerts and redirects home when the tab is not found in the store', async () => {
    mockParams = { id: 'missing-tab', mode: undefined };
    const tree = await renderScreen();

    expect(Alert.alert).toHaveBeenCalledWith('Could not load daemon connection');
    expect(router.replace).toHaveBeenCalledWith('/');
    act(() => tree.unmount());
  });

  it('alerts and redirects home when hostId does not resolve', async () => {
    const { getConnection } = jest.requireMock('./lib/connection') as { getConnection: jest.Mock };
    getConnection.mockReturnValueOnce(null);

    const tree = await renderScreen();

    expect(Alert.alert).toHaveBeenCalledWith('Could not load daemon connection');
    expect(router.replace).toHaveBeenCalledWith('/');
    act(() => tree.unmount());
  });
});

describe('terminal route natural exit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSubscribers = [];
    mockParams = { id: 'session', mode: undefined };
    jest.spyOn(Alert, 'alert');
    mockCloseSession.mockResolvedValue(undefined);
    mockTerminalOutput = undefined;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('closes the REST session, clears rendered output, and navigates home exactly once on session.state exited', async () => {
    const tree = await renderScreen();
    emit({ channelId: 'session', kind: 'terminal', type: 'pty.output', data: btoa('shell output'), seq: 0 });
    expect(mockTerminalOutput).toBe('shell output');

    await act(async () => { emit({ channelId: 'session', kind: 'terminal', type: 'session.state', state: 'exited' }); await Promise.resolve(); await Promise.resolve(); });

    expect(mockCloseSession).toHaveBeenCalledWith('session');
    expect(mockChannel.closeChannel).toHaveBeenCalledWith('session');
    expect(mockCloseTab).toHaveBeenCalledWith('session');
    expect(mockTerminalOutput).toBe('');
    expect(router.replace).toHaveBeenCalledWith('/');
    act(() => tree.unmount());
  });

  it('ignores a 404 APIError from the redundant close call (already closed server-side)', async () => {
    mockCloseSession.mockRejectedValue(new APIError(404, 'not found'));
    const tree = await renderScreen();
    await act(async () => { emit({ channelId: 'session', kind: 'terminal', type: 'session.state', state: 'exited' }); await Promise.resolve(); await Promise.resolve(); });

    expect(Alert.alert).not.toHaveBeenCalledWith('Could not close session', expect.anything());
    expect(router.replace).toHaveBeenCalledWith('/');
    act(() => tree.unmount());
  });

  it('does not double-close when natural exit and manual Close race', async () => {
    const tree = await renderScreen();
    act(() => { emit({ channelId: 'session', kind: 'terminal', type: 'session.state', state: 'exited' }); });
    act(() => closeAction(tree)());

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(mockCloseSession).toHaveBeenCalledTimes(1);
    expect(Alert.alert).not.toHaveBeenCalledWith('Close session?', expect.anything(), expect.anything());
    act(() => tree.unmount());
  });
});

function closeAction(tree: ReactTestRenderer) {
  return tree.root.findByProps({ accessibilityLabel: 'Close session' }).props.onPress as () => void;
}

describe('terminal route close action', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSubscribers = [];
    mockParams = { id: 'session', mode: undefined };
    jest.spyOn(Alert, 'alert');
    mockCloseSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('closes the remote and local session, then navigates home', async () => {
    const tree = await renderScreen();
    act(() => closeAction(tree)());

    expect(Alert.alert).toHaveBeenCalledWith('Close session?', expect.any(String), expect.any(Array));
    await act(async () => { await (confirmation()[1].onPress?.() as unknown as Promise<void> | undefined); });

    expect(mockCloseSession).toHaveBeenCalledWith('session');
    expect(mockChannel.closeChannel).toHaveBeenCalledWith('session');
    expect(mockCloseTab).toHaveBeenCalledWith('session');
    expect(router.replace).toHaveBeenCalledWith('/');
    act(() => tree.unmount());
  });

  it('leaves the session open when confirmation is cancelled', async () => {
    const tree = await renderScreen();
    act(() => closeAction(tree)());
    act(() => { confirmation()[0].onPress?.(); });

    expect(mockCloseSession).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('reports close failures without navigating away', async () => {
    mockCloseSession.mockRejectedValue(new Error('daemon unavailable'));
    const tree = await renderScreen();
    act(() => closeAction(tree)());
    await act(async () => { await (confirmation()[1].onPress?.() as unknown as Promise<void> | undefined); });

    expect(Alert.alert).toHaveBeenLastCalledWith('Could not close session', 'daemon unavailable');
    expect(mockChannel.closeChannel).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});

describe('terminal route detach', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSubscribers = [];
    mockParams = { id: 'session', mode: undefined };
    jest.spyOn(Alert, 'alert');
    mockCloseSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('unsubscribes and navigates home without any REST close call', async () => {
    const tree = await renderScreen();
    act(() => actionFor(tree, 'Detach')());

    expect(mockCloseSession).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith('/');
    act(() => tree.unmount());
  });
});

describe('terminal route multi mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSubscribers = [];
    mockParams = { id: 'session', mode: 'multi' };
    jest.spyOn(Alert, 'alert');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('confirms before closing all multi-session channels', async () => {
    const tree = await renderScreen();
    expect(mockChannel.openChannel).toHaveBeenCalledWith('terminal', expect.objectContaining({ sessionId: 'session' }));

    act(() => actionFor(tree, 'Close all')());
    expect(Alert.alert).toHaveBeenCalledWith('Close all sessions?', expect.any(String), expect.any(Array));
    await act(async () => { await (confirmation()[1].onPress?.() as unknown as Promise<void> | undefined); });

    expect(mockCloseSession).toHaveBeenCalledWith('session');
    expect(mockCloseTab).toHaveBeenCalledWith('session');
    expect(router.replace).toHaveBeenCalledWith('/');
    act(() => tree.unmount());
  });
});
