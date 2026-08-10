jest.mock("react-native-safe-area-context", () => ({ ...jest.requireActual("react-native-safe-area-context"), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, type AlertButton } from 'react-native';
import { router } from 'expo-router';
import TerminalScreen from '../app/terminal/[id]';
import type { Connection, ConnectionStore } from './lib/connection';
import { APIError } from './lib/api';

const mockCloseSession = jest.fn();
const mockSocket = { connect: jest.fn(), close: jest.fn(), input: jest.fn(), resize: jest.fn() };
let mockOnState: (state: string, waitState?: unknown) => void = () => undefined;
let mockOnOutput: (data: string) => void = () => undefined;

const mockConnection: Connection = {
  name: 'Test daemon',
  endpoint: 'https://daemon.test',
  token: 'secret',
  fingerprint: '',
  skipFingerprintVerification: false,
  clientName: 'test',
};
const mockStore: ConnectionStore = { connections: [mockConnection], selectedEndpoint: mockConnection.endpoint };

let mockParams = { id: 'session', name: 'Shell', connectionEndpoint: mockConnection.endpoint, mode: 'default' };

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { replace: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('./lib/connection', () => ({
  loadConnections: jest.fn(async () => mockStore),
  getConnection: jest.fn((s: ConnectionStore, endpoint: string | null) =>
    s.connections.find((c) => c.endpoint === endpoint) ?? null),
}));
jest.mock('./lib/api', () => {
  class APIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return { AgenticRemoteAPI: jest.fn(() => ({ closeSession: mockCloseSession })), APIError };
});
jest.mock('./lib/session-socket', () => ({
  SessionSocket: jest.fn((_connection: unknown, _id: unknown, onOutputCb: (data: string) => void, onStateCb: (state: string, waitState?: unknown) => void) => {
    mockOnOutput = onOutputCb;
    mockOnState = onStateCb;
    return mockSocket;
  }),
}));
let mockTerminalOutput: string | undefined;
jest.mock('./components/Terminal', () => ({
  Terminal: (props: { output: string }) => { mockTerminalOutput = props.output; return null; },
}));
jest.mock('./components/ShortcutKeyboard', () => ({ ShortcutKeyboard: () => null }));

async function renderScreen() {
  let tree: ReactTestRenderer;
  await act(async () => {
    tree = create(<TerminalScreen />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return tree!;
}

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
    jest.spyOn(Alert, 'alert');
    mockCloseSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('alerts and redirects home when connectionEndpoint does not resolve', async () => {
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
    jest.spyOn(Alert, 'alert');
    mockCloseSession.mockResolvedValue(undefined);
    mockTerminalOutput = undefined;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('closes the REST session, clears rendered output, and navigates home exactly once on session.state exited', async () => {
    const tree = await renderScreen();
    act(() => { mockOnOutput('shell output'); });
    expect(mockTerminalOutput).toBe('shell output');

    await act(async () => { mockOnState('exited'); await Promise.resolve(); await Promise.resolve(); });

    expect(mockCloseSession).toHaveBeenCalledWith('session');
    expect(mockSocket.close).toHaveBeenCalledTimes(1);
    expect(mockTerminalOutput).toBe('');
    expect(router.replace).toHaveBeenCalledWith('/');
    act(() => tree.unmount());
  });

  it('ignores a 404 APIError from the redundant close call (already closed server-side)', async () => {
    mockCloseSession.mockRejectedValue(new APIError(404, 'not found'));
    const tree = await renderScreen();
    await act(async () => { mockOnState('exited'); await Promise.resolve(); await Promise.resolve(); });

    expect(Alert.alert).not.toHaveBeenCalledWith('Could not close session', expect.anything());
    expect(router.replace).toHaveBeenCalledWith('/');
    act(() => tree.unmount());
  });

  it('does not double-close when natural exit and manual Close race', async () => {
    const tree = await renderScreen();
    act(() => { mockOnState('exited'); });
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
    expect(mockSocket.close).toHaveBeenCalled();
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
    expect(mockSocket.close).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});

describe('terminal route detach', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert');
    mockCloseSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('closes the socket and navigates home without any REST close call', async () => {
    const tree = await renderScreen();
    act(() => actionFor(tree, 'Detach')());

    expect(mockCloseSession).not.toHaveBeenCalled();
    expect(mockSocket.close).toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith('/');
    act(() => tree.unmount());
  });
});

describe('terminal route multi mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams.mode = 'multi';
  });

  afterEach(() => {
    mockParams.mode = 'default';
  });

  it('tracks multiSocketsRef and closes legacy and new sockets on detach', async () => {
    const tree = await renderScreen();
    // simulate handleAddSession called by Effect
    await act(async () => {
      expect(mockSocket.connect).toHaveBeenCalled();
    });

    await act(async () => {
      await actionFor(tree, 'Close all')();
    });
    
    expect(mockCloseSession).toHaveBeenCalledWith('session');
    expect(router.replace).toHaveBeenCalledWith('/');
    act(() => tree.unmount());
  });
});
