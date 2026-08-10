import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, Linking } from 'react-native';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual('react-native').View,
}));
import { PairingSheet } from './PairingSheet';

let mockPermission: { granted: boolean; canAskAgain: boolean } | null = null;
const mockRequestPermission = jest.fn();
let mockIsAvailable: () => Promise<boolean> = async () => true;
let mockMountError: (() => void) | undefined;
let mockScanned: ((event: { data: string }) => void) | undefined;

jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [mockPermission, mockRequestPermission, jest.fn()],
  CameraView: Object.assign(
    (props: { onBarcodeScanned?: (event: { data: string }) => void; onMountError?: () => void }) => {
      mockScanned = props.onBarcodeScanned;
      mockMountError = props.onMountError;
      return null;
    },
    { isAvailableAsync: () => mockIsAvailable() },
  ),
}));

const validPayload = JSON.stringify({
  v: 2,
  endpoint: 'https://daemon.example:8765',
  fingerprint: 'sha256:abc',
  pairingId: 'pair-1',
  token: 'token-1',
  expiresAt: '2030-01-01T00:00:00Z',
});

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

async function renderSheet(onConnect: jest.Mock = jest.fn().mockResolvedValue(undefined), onDismiss = jest.fn()) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<PairingSheet visible onDismiss={onDismiss} onConnect={onConnect} />);
    await flush();
  });
  return tree;
}

// RN forwards accessibilityLabel from a composite Pressable/Text down through its host
// node(s), so a plain findAllByProps match can return more than one entry for one button.
// Existence (any match) is what the UI states care about, not the exact node count.
function has(tree: ReactTestRenderer, label: string) {
  return tree.root.findAllByProps({ accessibilityLabel: label }).length > 0;
}

function byLabel(tree: ReactTestRenderer, label: string) {
  const [first] = tree.root.findAllByProps({ accessibilityLabel: label });
  if (!first) throw new Error(`no match for accessibilityLabel "${label}"`);
  return first;
}

// Buttons without an accessibilityLabel are located by their visible text: find the
// Text node carrying that literal string, then walk up to the nearest onPress owner.
function pressableWithText(tree: ReactTestRenderer, text: string) {
  const textNode = tree.root.findByProps({ children: text });
  let node = textNode.parent;
  while (node && typeof node.props.onPress !== 'function') node = node.parent;
  if (!node) throw new Error(`no pressable ancestor for text "${text}"`);
  return node;
}

function payloadInput(tree: ReactTestRenderer) {
  return tree.root.findByProps({ placeholder: 'Paste pairing JSON' });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert');
  jest.spyOn(Linking, 'openSettings').mockResolvedValue();
  mockPermission = null;
  mockIsAvailable = async () => true;
  mockMountError = undefined;
  mockScanned = undefined;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('PairingSheet camera states', () => {
  it('shows a loading state while permission is undetermined', async () => {
    const tree = await renderSheet();
    act(() => pressableWithText(tree, 'Scan QR code').props.onPress());
    expect(has(tree, 'camera-loading')).toBe(true);
  });

  it('offers a request button for a requestable denial', async () => {
    mockPermission = { granted: false, canAskAgain: true };
    const tree = await renderSheet();
    act(() => pressableWithText(tree, 'Scan QR code').props.onPress());
    act(() => byLabel(tree, 'allow-camera').props.onPress());
    expect(mockRequestPermission).toHaveBeenCalled();
  });

  it('directs to system settings on a permanent denial', async () => {
    mockPermission = { granted: false, canAskAgain: false };
    const tree = await renderSheet();
    act(() => pressableWithText(tree, 'Scan QR code').props.onPress());
    act(() => byLabel(tree, 'open-camera-settings').props.onPress());
    expect(Linking.openSettings).toHaveBeenCalled();
  });

  it('renders the camera immediately after permission is granted on native', async () => {
    mockPermission = { granted: true, canAskAgain: true };
    const tree = await renderSheet();

    act(() => pressableWithText(tree, 'Scan QR code').props.onPress());
    expect(has(tree, 'camera-loading')).toBe(false);
    expect(has(tree, 'retry-camera')).toBe(false);
  });

  it('offers a retry when the camera mount fails, and retrying resets it', async () => {
    mockPermission = { granted: true, canAskAgain: true };
    const tree = await renderSheet();

    act(() => pressableWithText(tree, 'Scan QR code').props.onPress());
    act(() => mockMountError?.());
    expect(has(tree, 'retry-camera')).toBe(true);

    act(() => byLabel(tree, 'retry-camera').props.onPress());
    expect(has(tree, 'retry-camera')).toBe(false);
  });

  it('treats a camera mount error as unavailable and offers retry', async () => {
    mockPermission = { granted: true, canAskAgain: true };
    const tree = await renderSheet();
    await act(async () => {
      pressableWithText(tree, 'Scan QR code').props.onPress();
      await flush();
    });
    expect(has(tree, 'retry-camera')).toBe(false);

    act(() => mockMountError?.());
    expect(has(tree, 'retry-camera')).toBe(true);
  });

  it('always offers the pasted-JSON fallback while scanning', async () => {
    const tree = await renderSheet();
    act(() => pressableWithText(tree, 'Scan QR code').props.onPress());
    expect(has(tree, 'use-pasted-json')).toBe(true);
  });

  it('shows reported stage text while connecting from a scan', async () => {
    mockPermission = { granted: true, canAskAgain: true };
    const completion = Promise.withResolvers<void>();
    const onConnect = jest.fn().mockImplementation(async (_payload, _name, onStage) => {
      onStage('Resolving endpoint...');
      await completion.promise;
    });
    const tree = await renderSheet(onConnect);

    await act(async () => {
      pressableWithText(tree, 'Scan QR code').props.onPress();
      await flush();
    });
    await act(async () => {
      mockScanned?.({ data: validPayload });
      await flush();
    });

    expect(onConnect).toHaveBeenCalledWith(expect.any(Object), 'phone', expect.any(Function));
    expect(byLabel(tree, 'camera-connecting').props.children).toBe('Resolving endpoint...');

    expect(byLabel(tree, 'cancel-pairing').props.disabled).toBe(true);
    expect(byLabel(tree, 'use-pasted-json').props.disabled).toBe(true);
    act(() => byLabel(tree, 'use-pasted-json').props.onPress());
    expect(has(tree, 'camera-connecting')).toBe(true);

    await act(async () => {
      completion.resolve();
      await flush();
    });
  });

  it('shows reported stage text while connecting pasted JSON', async () => {
    const completion = Promise.withResolvers<void>();
    const onConnect = jest.fn().mockImplementation(async (_payload, _name, onStage) => {
      onStage('Executing Auth-v2 Challenge...');
      await completion.promise;
    });
    const tree = await renderSheet(onConnect);
    act(() => payloadInput(tree).props.onChangeText(validPayload));

    await act(async () => {
      pressableWithText(tree, 'Connect').props.onPress();
      await flush();
    });

    expect(onConnect).toHaveBeenCalledWith(expect.any(Object), 'phone', expect.any(Function));
    expect(byLabel(tree, 'paste-connecting').props.children).toBe('Executing Auth-v2 Challenge...');

    expect(byLabel(tree, 'cancel-pairing').props.disabled).toBe(true);
    expect(payloadInput(tree).props.editable).toBe(false);
    expect(pressableWithText(tree, 'Scan QR code').props.disabled).toBe(true);

    await act(async () => {
      completion.resolve();
      await flush();
    });
  });
});

describe('PairingSheet connect failures', () => {
  it('shows an alert and keeps the sheet open when onConnect rejects', async () => {
    const onConnect = jest.fn().mockRejectedValue(new Error('bad token'));
    const onDismiss = jest.fn();
    const tree = await renderSheet(onConnect, onDismiss);

    act(() => payloadInput(tree).props.onChangeText(validPayload));

    await act(async () => {
      pressableWithText(tree, 'Connect').props.onPress();
      await flush();
    });

    expect(onConnect).toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith('Pairing failed', 'bad token');
  });

  it('dismisses on a successful connect', async () => {
    const onConnect = jest.fn().mockResolvedValue(undefined);
    const onDismiss = jest.fn();
    const tree = await renderSheet(onConnect, onDismiss);

    act(() => payloadInput(tree).props.onChangeText(validPayload));

    await act(async () => {
      pressableWithText(tree, 'Connect').props.onPress();
      await flush();
    });

    expect(onDismiss).toHaveBeenCalled();
  });
});
