jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, type AlertButton, TextInput } from 'react-native';
import { router } from 'expo-router';

import Dashboard from '../app/index';
import type { Connection, ConnectionStore, PairedConnection } from './lib/connection';
import type { PairingPayload, SessionSummary } from './protocol';

const first: Connection = {
  name: 'Primary daemon', endpoint: 'https://daemon-a.test:8765', fingerprint: 'sha256:first',
  skipFingerprintVerification: false, token: 'first-token', clientName: 'test-client',
};
const second: Connection = {
  name: 'Backup daemon', endpoint: 'https://daemon-b.test:8766', fingerprint: 'sha256:second',
  skipFingerprintVerification: true, token: 'second-token', clientName: 'test-client',
};
const storeA: ConnectionStore = { connections: [first, second], selectedEndpoint: first.endpoint };
const storeB: ConnectionStore = { connections: [first, second], selectedEndpoint: second.endpoint };

const mockLoadConnections = jest.fn();
const mockSaveConnection = jest.fn();
const mockUpdateConnection = jest.fn();
const mockSelectConnection = jest.fn();
const mockDeleteConnection = jest.fn();
const mockSessions = jest.fn();
const mockCreateSession = jest.fn();
const mockCloseSession = jest.fn();
const mockAgenticRemoteAPI = jest.fn((connection: Connection) => ({
  sessions: () => mockSessions(connection),
  createSession: (request: unknown) => mockCreateSession(connection, request),
  closeSession: (id: string) => mockCloseSession(connection, id),
}));
const mockAuthenticatePairing = jest.fn();

type MockPairingSheetProps = {
  visible: boolean;
  onDismiss: () => void;
  onConnect: (payload: PairingPayload, clientName: string) => Promise<void>;
};
let mockPairingProps: MockPairingSheetProps | undefined;

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('./lib/connection', () => ({
  loadConnections: (...args: unknown[]) => mockLoadConnections(...args),
  saveConnection: (...args: unknown[]) => mockSaveConnection(...args),
  updateConnection: (...args: unknown[]) => mockUpdateConnection(...args),
  selectConnection: (...args: unknown[]) => mockSelectConnection(...args),
  deleteConnection: (...args: unknown[]) => mockDeleteConnection(...args),
  getConnection: (store: ConnectionStore, endpoint: string | null = store.selectedEndpoint) =>
    store.connections.find((connection) => connection.endpoint === endpoint) ?? null,
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
    AgenticRemoteAPI: function AgenticRemoteAPI(connection: Connection) { return mockAgenticRemoteAPI(connection); },
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

const session = (id: string, state: SessionSummary['state']): SessionSummary => ({
  id, name: id, command: 'bash', cwd: '', state, createdAt: '', updatedAt: '', preview: [],
});

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
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert');
  mockPairingProps = undefined;
  mockLoadConnections.mockResolvedValue(storeA);
  mockSaveConnection.mockResolvedValue(storeA);
  mockUpdateConnection.mockResolvedValue(storeA);
  mockSelectConnection.mockResolvedValue(storeB);
  mockDeleteConnection.mockResolvedValue(storeA);
  mockSessions.mockImplementation(async (connection: Connection) => connection.endpoint === second.endpoint ? [] : []);
  mockCreateSession.mockResolvedValue(session('created-shell', 'running'));
  mockCloseSession.mockResolvedValue(undefined);
  mockAuthenticatePairing.mockResolvedValue({
    endpoint: first.endpoint,
    fingerprint: 'sha256:renewed',
    skipFingerprintVerification: false,
    token: 'renewed-token',
    clientName: 'renewed-client',
  } satisfies PairedConnection);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('dashboard saved-daemon lifecycle', () => {
  it('restores the selected daemon and sessions without pairing again', async () => {
    mockSessions.mockResolvedValue([session('restored-shell', 'running')]);
    const tree = await renderDashboard();

    expect(mockAuthenticatePairing).not.toHaveBeenCalled();
    expect(mockSessions).toHaveBeenCalledWith(first);
    expect(tree.root.findByProps({ accessibilityLabel: 'Open restored-shell' })).toBeTruthy();
    act(() => tree.unmount());
  });

  it('selects daemon B, clears A, and fetches B sessions', async () => {
    mockSessions.mockImplementation(async (connection: Connection) => [session(connection === second ? 'b-shell' : 'a-shell', 'running')]);
    const tree = await renderDashboard();

    act(() => actionFor(tree, 'Daemons')());
    await act(async () => {
      actionFor(tree, `Select ${second.endpoint}`)();
      await flush();
    });

    expect(mockSelectConnection).toHaveBeenCalledWith(second.endpoint);
    expect(mockSessions).toHaveBeenLastCalledWith(second);
    expect(tree.root.findByProps({ accessibilityLabel: 'Open b-shell' })).toBeTruthy();
    act(() => tree.unmount());
  });

  it('re-pairs daemon A as an upsert while preserving its display name', async () => {
    const paired = {
      endpoint: first.endpoint,
      fingerprint: 'sha256:renewed',
      skipFingerprintVerification: false,
      token: 'renewed-token',
      clientName: 'renewed-client',
    } satisfies PairedConnection;
    mockAuthenticatePairing.mockResolvedValue(paired);
    mockSaveConnection.mockResolvedValue({ connections: [{ ...first, ...paired }], selectedEndpoint: first.endpoint });
    const tree = await renderDashboard();

    await act(async () => {
      await mockPairingProps!.onConnect({ v: 2, endpoint: first.endpoint, fingerprint: first.fingerprint, pairingId: 'pair', token: 'pairing-token', expiresAt: '2030-01-01T00:00:00Z' }, 'renewed-client');
      await flush();
    });

    expect(mockSaveConnection).toHaveBeenCalledWith({ ...paired, name: first.name });
    act(() => tree.unmount());
  });

  it('propagates a pairing failure instead of swallowing it', async () => {
    mockAuthenticatePairing.mockRejectedValue(new Error('bad token'));
    const tree = await renderDashboard();

    await expect(
      act(async () => {
        await mockPairingProps!.onConnect(
          { v: 2, endpoint: first.endpoint, fingerprint: first.fingerprint, pairingId: 'pair', token: 'pairing-token', expiresAt: '2030-01-01T00:00:00Z' },
          'renewed-client',
        );
      }),
    ).rejects.toThrow('bad token');

    expect(mockSaveConnection).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('edits and deletes through ConnectionSheet callbacks', async () => {
    const renamed = { ...first, name: 'Renamed daemon' };
    mockUpdateConnection.mockResolvedValue({ connections: [renamed, second], selectedEndpoint: first.endpoint });
    mockDeleteConnection.mockResolvedValue({ connections: [renamed], selectedEndpoint: renamed.endpoint });
    const tree = await renderDashboard();

    act(() => actionFor(tree, 'Daemons')());
    act(() => actionFor(tree, `Edit ${first.endpoint}`)());
    const nameInput = tree.root.findAllByType(TextInput).find((input) => input.props.placeholder === 'Name')!;
    act(() => nameInput.props.onChangeText(renamed.name));
    await act(async () => {
      actionFor(tree, 'Save')();
      await flush();
    });
    expect(mockUpdateConnection).toHaveBeenCalledWith(first.endpoint, renamed);

    act(() => actionFor(tree, `Delete ${second.endpoint}`)());
    await act(async () => {
      confirmation()[1].onPress?.();
      await flush();
    });
    expect(mockDeleteConnection).toHaveBeenCalledWith(second.endpoint);
    act(() => tree.unmount());
  });

  it('retains saved daemon records after a 401 while clearing sessions', async () => {
    const { APIError: MockAPIError } = jest.requireMock('./lib/api') as { APIError: new (status: number, message: string) => Error };
    mockSessions.mockRejectedValue(new MockAPIError(401, 'expired'));
    const tree = await renderDashboard();

    expect(Alert.alert).toHaveBeenCalledWith('Authentication expired. Pair this daemon again or edit its saved credentials.');
    expect(mockDeleteConnection).not.toHaveBeenCalled();
    act(() => actionFor(tree, 'Daemons')());
    expect(tree.root.findByProps({ accessibilityLabel: `Select ${first.endpoint}` })).toBeTruthy();
    expect(tree.root.findByProps({ accessibilityLabel: `Select ${second.endpoint}` })).toBeTruthy();
    act(() => tree.unmount());
  });

  it('renders only active sessions and binds Files and terminal routes to the selected endpoint', async () => {
    mockSessions.mockResolvedValue([
      session('running-shell', 'running'),
      session('waiting-shell', 'waiting'),
      session('idle-shell', 'idle'),
      session('exited-shell', 'exited'),
    ]);
    const tree = await renderDashboard();

    expect(tree.root.findByProps({ accessibilityLabel: 'Open running-shell' })).toBeTruthy();
    expect(tree.root.findByProps({ accessibilityLabel: 'Open waiting-shell' })).toBeTruthy();
    expect(tree.root.findByProps({ accessibilityLabel: 'Open idle-shell' })).toBeTruthy();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Open exited-shell' })).toHaveLength(0);

    act(() => actionFor(tree, 'Files')());
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/files', params: { connectionEndpoint: first.endpoint } });
    act(() => actionFor(tree, 'Open running-shell')());
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/terminal/[id]', params: { id: 'running-shell', name: 'running-shell', connectionEndpoint: first.endpoint } });
    act(() => tree.unmount());
  });
});
