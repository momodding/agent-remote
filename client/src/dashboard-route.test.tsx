import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, type AlertButton, TextInput } from 'react-native';
import { router } from 'expo-router';

import Dashboard from '../app/index';
import type { Connection, ConnectionStore, PairedConnection } from './lib/connection';
import type { PairingPayload, SessionSummary } from './protocol';
import type { TabDeckState } from './lib/tabs/types';
import type { ChannelEnvelope, DaemonChannel } from './lib/daemon-channel';

jest.mock("react-native-safe-area-context", () => ({ ...jest.requireActual("react-native-safe-area-context"), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@expo/vector-icons/Feather', () => ({ __esModule: true, default: () => null }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'mock-uuid') }));

const first: Connection = {
  name: 'Primary daemon', endpoint: 'https://daemon-a.test:8765', hostId: 'hostA', fingerprint: 'sha256:first',
  skipFingerprintVerification: false, token: 'first-token', clientName: 'test-client',
};
const second: Connection = {
  name: 'Backup daemon', endpoint: 'https://daemon-b.test:8766', hostId: 'hostB', fingerprint: 'sha256:second',
  skipFingerprintVerification: true, token: 'second-token', clientName: 'test-client',
};
const storeA: ConnectionStore = { connections: [first, second] };

const mockLoadConnections = jest.fn();
const mockSaveConnection = jest.fn();
const mockUpdateConnection = jest.fn();
const mockDeleteConnection = jest.fn();
const mockAuthenticatePairing = jest.fn();
const mockReconcileDaemon = jest.fn();

type MockPairingSheetProps = {
  visible: boolean;
  onDismiss: () => void;
  onConnect: (payload: PairingPayload, clientName: string) => Promise<void>;
};
let mockPairingProps: MockPairingSheetProps | undefined;

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

let mockTabStoreState: TabDeckState = { tabs: [], activeId: null, layout: {} };
const mockCloseTab = jest.fn((tabId: string) => {
  mockTabStoreState = { ...mockTabStoreState, tabs: mockTabStoreState.tabs.filter((t) => t.tabId !== tabId) };
});
const mockActivateTab = jest.fn();
const mockDispatch = jest.fn((updater: (prev: TabDeckState) => TabDeckState) => {
  mockTabStoreState = updater(mockTabStoreState);
});

const mockChannel: DaemonChannel = {
  daemonId: 'mock',
  status: 'open',
  send: jest.fn(),
  subscribe: jest.fn(),
  openChannel: jest.fn(async () => 'remote-session-id'),
  closeChannel: jest.fn(),
  dispose: jest.fn(),
};

jest.mock('./lib/tabs/tab-store', () => ({
  useTabStore: () => ({
    state: mockTabStoreState,
    closeTab: mockCloseTab,
    activateTab: mockActivateTab,
    getChannel: () => mockChannel,
    dispatch: mockDispatch,
  }),
  removeExitedAgentTabs: jest.fn((state: TabDeckState) => state),
  removeExitedTerminalTabs: jest.fn((state: TabDeckState) => state),
}));

jest.mock('./lib/daemon-channel', () => ({
  createDaemonChannel: jest.fn(() => mockChannel),
  disposeDaemonChannel: jest.fn(),
}));
jest.mock('./lib/runtime-channel', () => ({
  disposeRuntimeChannel: jest.fn(),
}));
const mockCreateAgent = jest.fn();
jest.mock('./lib/runtime-reconcile', () => ({
  reconcileDaemon: (...args: unknown[]) => mockReconcileDaemon(...args),
}));

jest.mock('./lib/connection', () => ({
  loadConnections: (...args: unknown[]) => mockLoadConnections(...args),
  saveConnection: (...args: unknown[]) => mockSaveConnection(...args),
  deleteConnection: (...args: unknown[]) => mockDeleteConnection(...args),
  updateConnection: (...args: unknown[]) => mockUpdateConnection(...args),
  normalizeHostId: (s: string) => s,
  getConnection: (s: ConnectionStore, h: string) => s.connections.find((c) => c.hostId === h) ?? null,
}));
const mockTerminateAgent = jest.fn<Promise<void>, [string]>(async () => undefined);
const mockCloseSession = jest.fn<Promise<void>, [string]>(async () => undefined);
jest.mock('./lib/api', () => {
  class APIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    AgenticRemoteAPI: jest.fn(function AgenticRemoteAPI(_connection: Connection) {
      return { createAgent: mockCreateAgent, terminateAgent: mockTerminateAgent, closeSession: mockCloseSession };
    }),
    APIError,
    authenticatePairing: (...args: unknown[]) => mockAuthenticatePairing(...args),
  };
});
jest.mock('./components/PairingSheet', () => ({
  PairingSheet: (props: MockPairingSheetProps) => {
    mockPairingProps = props;
    return null;
  },
}));

async function flush() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}
async function renderDashboard() {
  let tree: ReactTestRenderer;
  await act(async () => {
    tree = create(<Dashboard />);
    await flush();
  });
  return tree!;
}

function actionFor(tree: ReactTestRenderer, label: string) {
  return tree.root.findByProps({ accessibilityLabel: label }).props.onPress as (event?: { stopPropagation: () => void }) => void;
}
function confirmation() {
  return (jest.mocked(Alert.alert).mock.calls.at(-1)?.[2] ?? []) as AlertButton[];
}



beforeEach(() => {
  mockTabStoreState = { tabs: [], activeId: null, layout: {} };
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert');
  mockPairingProps = undefined;
  mockLoadConnections.mockResolvedValue(storeA);
  mockSaveConnection.mockResolvedValue(storeA);
  mockUpdateConnection.mockResolvedValue(storeA);
  mockDeleteConnection.mockResolvedValue(storeA);
  mockCreateAgent.mockReset();
  mockTerminateAgent.mockReset();
  mockTerminateAgent.mockResolvedValue(undefined);
  mockCloseSession.mockReset();
  mockCloseSession.mockResolvedValue(undefined);
  mockCreateAgent.mockResolvedValue({
    id: 'agent-1',
    terminalSessionId: 'term-1',
    state: 'idle',
    adapter: 'OMP Agent',
  });
  mockAuthenticatePairing.mockResolvedValue({
    endpoint: first.endpoint,
    hostId: 'hostA',
    fingerprint: 'sha256:renewed',
    skipFingerprintVerification: false,
    token: 'renewed-token',
    clientName: 'renewed-client',
  } satisfies PairedConnection);
	mockReconcileDaemon.mockImplementation((_connection: Connection, update: (runtime: { snapshot: { cursor: number; terminals: never[]; agents: never[]; topology: never[]; desktops: never[] }; capabilities: Array<{ name: string; enabled: boolean }>; status: 'ready' }) => void) => {
		update({
			snapshot: { cursor: 0, terminals: [], agents: [], topology: [], desktops: [] },
			capabilities: [
				{ name: 'sessions', enabled: true }, { name: 'files', enabled: true },
				{ name: 'terminal.pty', enabled: true }, { name: 'terminal.tmux', enabled: false },
				{ name: 'agent.omp', enabled: true }, { name: 'vnc', enabled: true },
			],
			status: 'ready',
		});
		return Promise.resolve(() => {});
	});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('dashboard empty state', () => {
  it('opens the pairing sheet when no daemon is saved yet', async () => {
    mockLoadConnections.mockResolvedValue({ connections: [] });
    const tree = await renderDashboard();

    expect(mockPairingProps!.visible).toBe(false);
    act(() => actionFor(tree, 'Connect daemon')());
    expect(mockPairingProps!.visible).toBe(true);
    act(() => tree.unmount());
  });
});

describe('dashboard saved-daemon lifecycle', () => {
  it('re-pairs daemon A as an upsert while preserving its display name', async () => {
    const paired = {
      endpoint: first.endpoint,
      fingerprint: 'sha256:renewed',
      hostId: 'hostA',
      skipFingerprintVerification: false,
      token: 'renewed-token',
      clientName: 'renewed-client',
    } satisfies PairedConnection;
    mockAuthenticatePairing.mockResolvedValue(paired);
    mockSaveConnection.mockResolvedValue({ connections: [{ ...first, ...paired }] });
    const tree = await renderDashboard();

    await act(async () => {
      await mockPairingProps!.onConnect({ v: 2, endpoint: first.endpoint, fingerprint: first.fingerprint, pairingId: 'pair', token: 'pairing-token', expiresAt: '2030-01-01T00:00:00Z' }, 'renewed-client');
      await flush();
    });

    expect(mockSaveConnection).toHaveBeenCalledWith({ ...paired, name: first.name });
    act(() => tree.unmount());
  });

  it('edits and deletes through ConnectionSheet callbacks and cascades tabs deletion', async () => {
    mockTabStoreState.tabs = [
      { tabId: 'tab1', daemonId: first.hostId, kind: 'terminal', title: 'term', createdAt: 0, lastActiveAt: 0, pinned: false, remoteSessionId: 'sess1', state: 'running' }
    ];
    const renamed = { ...first, name: 'Renamed daemon' };
    mockUpdateConnection.mockResolvedValue({ connections: [renamed, second] });
    mockDeleteConnection.mockResolvedValue({ connections: [renamed] });
    const tree = await renderDashboard();

    act(() => actionFor(tree, 'Daemons')());
    act(() => actionFor(tree, `Edit ${first.endpoint}`)());
    const nameInput = tree.root.findAllByType(TextInput).find((input) => input.props.placeholder === 'Name')!;
    act(() => nameInput.props.onChangeText(renamed.name));
    await act(async () => {
      actionFor(tree, 'Save')();
      await flush();
    });
    expect(mockUpdateConnection).toHaveBeenCalledWith(first.hostId, renamed);

    act(() => actionFor(tree, `Delete ${first.endpoint}`)()); // delete daemon with tab
    await act(async () => {
      confirmation()[1].onPress?.();
      await flush();
    });
    expect(mockDeleteConnection).toHaveBeenCalledWith(first.hostId);
    expect(mockCloseTab).toHaveBeenCalledWith('tab1');
    act(() => tree.unmount());
  });
});

describe('dashboard tab deck actions', () => {
  it('spawns new terminal tabs and pushes routing', async () => {
    const tree = await renderDashboard();
    
    await act(async () => {
      actionFor(tree, `New Terminal ${first.endpoint}`)();
      await flush();
    });
    
    expect(mockChannel.openChannel).toHaveBeenCalledWith('terminal', {});
    expect(mockDispatch).toHaveBeenCalled();
    expect(mockTabStoreState.tabs[0].kind).toBe('terminal');
    expect(mockTabStoreState.tabs[0].daemonId).toBe(first.hostId);
    expect(router.push).toHaveBeenCalledWith({ pathname: '/terminal/[id]', params: { id: 'mock-uuid' } });
    
    act(() => tree.unmount());
  });

  it('spawns new files tabs directly without PTY multiplex channel', async () => {
    const tree = await renderDashboard();
    
    await act(async () => {
      actionFor(tree, `New Files ${second.endpoint}`)();
      await flush();
    });
    
    expect(mockChannel.openChannel).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalled();
    expect(mockTabStoreState.tabs[0].kind).toBe('files');
    expect(router.push).toHaveBeenCalledWith({ pathname: '/files/[id]', params: { id: 'mock-uuid' } });
    
    act(() => tree.unmount());
  });

  it('renders active tabs bound to daemons and opens them', async () => {
    mockTabStoreState.tabs = [
      { tabId: 'tab-2', daemonId: second.hostId, kind: 'desktop', title: 'Desktop', createdAt: 0, lastActiveAt: 0, pinned: false, remoteSessionId: 'sess', state: 'connected' }
    ];
    
    const tree = await renderDashboard();
    
    expect(tree.root.findByProps({ children: 'Desktop' })).toBeTruthy();
    
    act(() => { actionFor(tree, 'Open desktop Desktop')(); });
    
    expect(mockActivateTab).toHaveBeenCalledWith('tab-2');
    expect(router.push).toHaveBeenCalledWith({ pathname: '/desktop', params: { tabId: 'tab-2' } });

    act(() => tree.unmount());
  });
  it('opens NewAgentSheet and creates agent with user workspace and backend selection', async () => {
    const tree = await renderDashboard();

    // Press New Agent button
    await act(async () => {
      actionFor(tree, `New Agent ${first.endpoint}`)();
    });

    // Verify createAgent was not called immediately
    expect(mockCreateAgent).not.toHaveBeenCalled();

    // Workspace path input and backend option are available in the sheet
    const input = tree.root.findByProps({ accessibilityLabel: 'Workspace Path' });
    await act(async () => {
      input.props.onChangeText('packages/app');
    });

    const tmuxOption = tree.root.findByProps({ accessibilityLabel: 'Backend tmux' });
    await act(async () => {
      tmuxOption.props.onPress();
    });

    const submitBtn = tree.root.findByProps({ accessibilityLabel: 'Create Agent' });
    await act(async () => {
      await submitBtn.props.onPress();
    });

    expect(mockCreateAgent).toHaveBeenCalledWith({
      name: 'OMP Agent',
      args: [],
      cwd: 'packages/app',
      backend: 'tmux',
    });
    expect(mockTabStoreState.tabs[0]).toMatchObject({
      kind: 'agent',
      daemonId: first.hostId,
      agentSessionId: 'agent-1',
    });
    expect(router.push).toHaveBeenCalledWith({ pathname: '/agent/[id]', params: { id: 'mock-uuid' } });
  });


  it('closes an agent view locally without terminating the remote agent', async () => {
    mockTabStoreState.tabs = [{ tabId: 'agent-tab', daemonId: first.hostId, kind: 'agent', title: 'Agent', createdAt: 0, lastActiveAt: 0, pinned: false, agentSessionId: 'agent-1', terminalSessionId: 'term-1', state: 'idle', view: 'chat' }];
    const tree = await renderDashboard();

    act(() => actionFor(tree, 'Close view agent-tab')({ stopPropagation: jest.fn() }));
    await act(async () => {
      actionFor(tree, 'Close session view')();
      await flush();
    });

    expect(mockCloseTab).toHaveBeenCalledWith('agent-tab');
    expect(mockTerminateAgent).not.toHaveBeenCalled();
    expect(mockCloseSession).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('terminates an agent remotely before removing its local tab', async () => {
    mockTabStoreState.tabs = [{ tabId: 'agent-tab', daemonId: first.hostId, kind: 'agent', title: 'Agent', createdAt: 0, lastActiveAt: 0, pinned: false, agentSessionId: 'agent-1', terminalSessionId: 'term-1', state: 'idle', view: 'chat' }];
    let resolveTermination!: () => void;
    mockTerminateAgent.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveTermination = resolve; }));
    const tree = await renderDashboard();

    act(() => actionFor(tree, 'Close view agent-tab')({ stopPropagation: jest.fn() }));
    act(() => actionFor(tree, 'Terminate session')());
    await act(async () => { await flush(); });

    expect(mockTerminateAgent).toHaveBeenCalledWith('agent-1');
    expect(mockCloseTab).not.toHaveBeenCalled();
    act(() => resolveTermination());
    await act(async () => { await flush(); });

    expect(mockCloseSession).not.toHaveBeenCalled();
    expect(mockCloseTab).toHaveBeenCalledWith('agent-tab');
    act(() => tree.unmount());
  });

  it('terminates a terminal remotely before removing its local tab', async () => {
    mockTabStoreState.tabs = [{ tabId: 'terminal-tab', daemonId: first.hostId, kind: 'terminal', title: 'Shell', createdAt: 0, lastActiveAt: 0, pinned: false, remoteSessionId: 'session-1', state: 'running' }];
    const tree = await renderDashboard();

    act(() => actionFor(tree, 'Close view terminal-tab')({ stopPropagation: jest.fn() }));
    await act(async () => {
      actionFor(tree, 'Terminate session')();
      await flush();
    });

    expect(mockCloseSession).toHaveBeenCalledWith('session-1');
    expect(mockTerminateAgent).not.toHaveBeenCalled();
    expect(mockCloseTab).toHaveBeenCalledWith('terminal-tab');
    act(() => tree.unmount());
  });

  it.each([
    ['agent', { agents: [{ id: 'remote-agent', adapter: 'OMP Agent', terminalSessionId: 'agent-terminal', cwd: '', state: 'idle', capabilities: [], createdAt: '', updatedAt: '' }], terminals: [{ id: 'agent-terminal', name: 'Agent PTY', cwd: '', seq: 0, exited: false }] }],
    ['terminal', { agents: [], terminals: [{ id: 'remote-terminal', name: 'Remote shell', cwd: '', seq: 0, exited: false }] }],
  ] as const)('terminates a remote-only %s without offering Close view', async (kind, runtime) => {
    mockReconcileDaemon.mockImplementationOnce((_connection: Connection, update: (value: unknown) => void) => {
      update({
        snapshot: { cursor: 1, topology: [], desktops: [], ...runtime },
        capabilities: [{ name: 'sessions', enabled: true }],
        status: 'ready',
      });
      return Promise.resolve(() => {});
    });
    const tree = await renderDashboard();
    expect(tree.root.findAll((node) => typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.startsWith('Close view '))).toHaveLength(0);
    act(() => actionFor(tree, `Terminate ${kind} ${kind}:remote-${kind}`)({ stopPropagation: jest.fn() }));
    expect(tree.root.findByProps({ children: 'Terminate remote session?' })).toBeTruthy();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Close session view' })).toHaveLength(0);
    await act(async () => {
      actionFor(tree, 'Terminate session')();
      await flush();
    });

    if (kind === 'agent') expect(mockTerminateAgent).toHaveBeenCalledWith('remote-agent');
    else expect(mockCloseSession).toHaveBeenCalledWith('remote-terminal');
    expect(mockCloseTab).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('keeps an agent card present and reports an error when remote termination fails', async () => {
    mockTabStoreState.tabs = [{ tabId: 'agent-tab', daemonId: first.hostId, kind: 'agent', title: 'Agent', createdAt: 0, lastActiveAt: 0, pinned: false, agentSessionId: 'agent-1', terminalSessionId: 'term-1', state: 'idle', view: 'chat' }];
    mockTerminateAgent.mockRejectedValueOnce(new Error('daemon unavailable'));
    const tree = await renderDashboard();

    act(() => actionFor(tree, 'Close view agent-tab')({ stopPropagation: jest.fn() }));
    await act(async () => {
      actionFor(tree, 'Terminate session')();
      await flush();
    });

    expect(mockCloseTab).not.toHaveBeenCalled();
    expect(mockTabStoreState.tabs).toHaveLength(1);
    expect(tree.root.findByProps({ children: 'Could not terminate session' })).toBeTruthy();
    expect(tree.root.findByProps({ children: 'daemon unavailable' })).toBeTruthy();
    act(() => tree.unmount());
  });
});

describe('dashboard capability gating', () => {
  it('keeps New Agent available when a connected daemon reports agent capability disabled', async () => {
    mockReconcileDaemon.mockImplementationOnce((_connection: Connection, update: (runtime: { snapshot: { cursor: number; terminals: never[]; agents: never[]; topology: never[]; desktops: never[] }; capabilities: Array<{ name: string; enabled: boolean }>; status: 'ready' }) => void) => {
      update({
        snapshot: { cursor: 0, terminals: [], agents: [], topology: [], desktops: [] },
        capabilities: [
          { name: 'sessions', enabled: true },
			{ name: 'files', enabled: false },
			{ name: 'terminal.pty', enabled: false },
			{ name: 'terminal.tmux', enabled: false },
          { name: 'agent.omp', enabled: false },
          { name: 'vnc', enabled: false },
        ],
        status: 'ready',
      });
      return Promise.resolve(() => {});
    });

    const tree = await renderDashboard();
    await act(async () => { await flush(); });

		expect(() => tree.root.findByProps({ accessibilityLabel: `New Terminal ${first.endpoint}` })).toThrow();
		expect(() => tree.root.findByProps({ accessibilityLabel: `New Files ${first.endpoint}` })).toThrow();
		expect(tree.root.findByProps({ accessibilityLabel: `New Agent ${first.endpoint}` })).toBeTruthy();
		expect(() => tree.root.findByProps({ accessibilityLabel: `New Desktop ${first.endpoint}` })).toThrow();

    act(() => tree.unmount());
  });

	it('hides daemon actions while capability discovery is incomplete', async () => {
		mockReconcileDaemon.mockImplementationOnce(() => new Promise<() => void>(() => {}));
		const tree = await renderDashboard();

		for (const label of ['New Terminal', 'New Files', 'New Agent', 'New Desktop']) {
			expect(() => tree.root.findByProps({ accessibilityLabel: `${label} ${first.endpoint}` })).toThrow();
		}

		act(() => tree.unmount());
	});

	it('retains known capabilities when a later runtime update omits them', async () => {
		mockReconcileDaemon.mockImplementationOnce((_connection: Connection, update: (runtime: { snapshot: { cursor: number; terminals: never[]; agents: never[]; topology: never[]; desktops: never[] }; capabilities?: Array<{ name: string; enabled: boolean }>; status: 'ready' }) => void) => {
			const snapshot = { cursor: 0, terminals: [], agents: [], topology: [], desktops: [] };
			update({ snapshot, capabilities: [{ name: 'agent.omp', enabled: true }], status: 'ready' });
			update({ snapshot, status: 'ready' });
			return Promise.resolve(() => {});
		});
		const tree = await renderDashboard();

		expect(tree.root.findByProps({ accessibilityLabel: `New Agent ${first.endpoint}` })).toBeTruthy();
		act(() => tree.unmount());
	});
});