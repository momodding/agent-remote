import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, type AlertButton } from 'react-native';
import { router } from 'expo-router';

import TerminalScreen from '../app/terminal/[id]';
import type { Connection } from './lib/connection';

const mockCloseSession = jest.fn();
const mockSocket = { connect: jest.fn(), close: jest.fn(), input: jest.fn(), resize: jest.fn() };

const connection: Connection = {
  endpoint: 'https://daemon.test',
  token: 'secret',
  fingerprint: '',
  skipFingerprintVerification: false,
  clientName: 'test',
};

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { back: jest.fn() },
  useLocalSearchParams: () => ({ id: 'session', name: 'Shell' }),
}));
jest.mock('./lib/connection', () => ({ loadConnection: jest.fn(async () => connection) }));
jest.mock('./lib/api', () => ({ AgenticRemoteAPI: jest.fn(() => ({ closeSession: mockCloseSession })) }));
jest.mock('./lib/session-socket', () => ({ SessionSocket: jest.fn(() => mockSocket) }));
jest.mock('./components/Terminal', () => ({ Terminal: () => null }));
jest.mock('./components/ShortcutKeyboard', () => ({ ShortcutKeyboard: () => null }));

async function renderScreen() {
  let tree: ReactTestRenderer;
  await act(async () => {
    tree = create(<TerminalScreen />);
    await Promise.resolve();
  });
  return tree!;
}

function closeAction(tree: ReactTestRenderer) {
  return tree.root.findByProps({ accessibilityLabel: 'Close session' }).props.onPress as () => void;
}

function confirmation() {
  const buttons = (jest.mocked(Alert.alert).mock.calls.at(-1)?.[2] ?? []) as AlertButton[];
  return buttons;
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

  it('closes the remote and local session, then navigates back', async () => {
    const tree = await renderScreen();
    act(() => closeAction(tree)());

    expect(Alert.alert).toHaveBeenCalledWith('Close session?', expect.any(String), expect.any(Array));
    await act(async () => { await (confirmation()[1].onPress?.() as unknown as Promise<void> | undefined); });

    expect(mockCloseSession).toHaveBeenCalledWith('session');
    expect(mockSocket.close).toHaveBeenCalled();
    expect(router.back).toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('leaves the session open when confirmation is cancelled', async () => {
    const tree = await renderScreen();
    act(() => closeAction(tree)());
    act(() => { confirmation()[0].onPress?.(); });

    expect(mockCloseSession).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('reports close failures without navigating away', async () => {
    mockCloseSession.mockRejectedValue(new Error('daemon unavailable'));
    const tree = await renderScreen();
    act(() => closeAction(tree)());
    await act(async () => { await (confirmation()[1].onPress?.() as unknown as Promise<void> | undefined); });

    expect(Alert.alert).toHaveBeenLastCalledWith('Could not close session', 'daemon unavailable');
    expect(mockSocket.close).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});
