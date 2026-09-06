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
};

jest.mock('./lib/tabs/tab-store', () => ({
  useTabStore: () => ({
    state: mockTabStoreState,
    closeTab: mockCloseTab,
    activateTab: mockActivateTab,
    getChannel: () => mockChannel,
    dispatch: mockDispatch,
  }),
}));

jest.mock('./lib/daemon-channel', () => ({
  createDaemonChannel: jest.fn(() => mockChannel),
}));

jest.mock('./lib/connection', () => ({
  loadConnections: (...args: unknown[]) => mockLoadConnections(...args),
  saveConnection: (...args: unknown[]) => mockSaveConnection(...args),
  deleteConnection: (...args: unknown[]) => mockDeleteConnection(...args),
  updateConnection: (...args: unknown[]) => mockUpdateConnection(...args),
  normalizeHostId: (s: string) => s,
  getConnection: (s: ConnectionStore, h: string) => s.connections.find((c) => c.hostId === h) ?? null,
}));
jest.mock('./lib/api', () => {
  class APIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    AgenticRemoteAPI: function AgenticRemoteAPI(connection: Connection) { return {}; },
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
  await Promise.resolve();
  await Promise.resolve();
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
  return tree.root.findByProps({ accessibilityLabel: label }).props.onPress as () => void;
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
  mockAuthenticatePairing.mockResolvedValue({
    endpoint: first.endpoint,
    hostId: 'hostA',
    fingerprint: 'sha256:renewed',
    skipFingerprintVerification: false,
    token: 'renewed-token',
    clientName: 'renewed-client',
  } satisfies PairedConnection);
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
  }, 10000);

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
      { tabId: 'tab-1', daemonId: first.hostId, kind: 'agent', title: 'Agent Session', createdAt: 0, lastActiveAt: 0, pinned: false, remoteSessionId: 'sess', adapter: 'omp', sessionState: null, pendingApproval: null },
      { tabId: 'tab-2', daemonId: second.hostId, kind: 'desktop', title: 'Desktop', createdAt: 0, lastActiveAt: 0, pinned: false, remoteSessionId: 'sess', state: 'connected' }
    ];
    
    const tree = await renderDashboard();
    
    // Checks that they render correctly in the deck grid under correct daemon
    expect(tree.root.findByProps({ children: 'Agent Session' })).toBeTruthy();
    expect(tree.root.findByProps({ children: 'Desktop' })).toBeTruthy();
    
    act(() => { actionFor(tree, 'Open tab Desktop')(); });
    
    expect(mockActivateTab).toHaveBeenCalledWith('tab-2');
    expect(router.push).toHaveBeenCalledWith({ pathname: '/desktop', params: { tabId: 'tab-2' } });

    act(() => tree.unmount());
  });
});