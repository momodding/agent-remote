jest.mock("react-native-safe-area-context", () => ({ SafeAreaView: jest.requireActual("react-native").View }));
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, Modal, Pressable, Switch, type AlertButton, TextInput } from 'react-native';

import { ConnectionSheet } from './ConnectionSheet';
import type { Connection, ConnectionStore } from '../lib/connection';

function isType(node: { type: unknown }, Component: unknown): boolean {
  if (node.type === Component) return true;
  return typeof Component === 'object' && Component !== null && 'type' in Component && Component.type === node.type;
}

const first: Connection = {
  name: 'Primary daemon', endpoint: 'https://daemon.example:8765', fingerprint: 'sha256:first',
  skipFingerprintVerification: true, token: 'first-token', clientName: 'test-client',
};
const second: Connection = {
  name: 'Backup daemon', endpoint: 'https://127.0.0.1:8766', fingerprint: '',
  skipFingerprintVerification: false, token: 'second-token', clientName: 'test-client',
};
const store: ConnectionStore = { connections: [first, second], selectedEndpoint: first.endpoint };

function makeProps(overrides: Partial<Parameters<typeof ConnectionSheet>[0]> = {}) {
  return {
    visible: true,
    store,
    onDismiss: jest.fn(),
    onSelect: jest.fn(async () => undefined),
    onSave: jest.fn(async () => undefined),
    onDelete: jest.fn(async () => undefined),
    onAdd: jest.fn(),
    ...overrides,
  };
}

async function renderSheet(props: ReturnType<typeof makeProps>) {
  let tree: ReactTestRenderer;
  await act(async () => {
    tree = create(<ConnectionSheet {...props} />);
    await Promise.resolve();
  });
  return tree!;
}

function actionFor(tree: ReactTestRenderer, label: string) {
  return tree.root.findByProps({ accessibilityLabel: label }).props.onPress as () => void;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ConnectionSheet row actions', () => {
  it('invokes only the named callback for Select, Edit, and Add', async () => {
    const props = makeProps();
    const tree = await renderSheet(props);

    expect(tree.root.findAllByType(Modal).length).toBe(1);
    expect(isType(tree.root.findByProps({ accessibilityLabel: `Select ${second.endpoint}` }), Pressable)).toBe(true);
    expect(isType(tree.root.findByProps({ accessibilityLabel: `Edit ${second.endpoint}` }), Pressable)).toBe(true);
    expect(isType(tree.root.findByProps({ accessibilityLabel: `Delete ${second.endpoint}` }), Pressable)).toBe(true);
    expect(isType(tree.root.findByProps({ accessibilityLabel: 'Add daemon' }), Pressable)).toBe(true);
    expect(isType(tree.root.findByProps({ accessibilityLabel: 'Done' }), Pressable)).toBe(true);

    act(() => actionFor(tree, `Select ${second.endpoint}`)());
    expect(props.onSelect).toHaveBeenCalledWith(second.endpoint);
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onDelete).not.toHaveBeenCalled();

    act(() => actionFor(tree, 'Add daemon')());
    expect(props.onAdd).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('requires delete confirmation and does not delete on cancel', async () => {
    const props = makeProps();
    const tree = await renderSheet(props);

    act(() => actionFor(tree, `Delete ${second.endpoint}`)());
    expect(Alert.alert).toHaveBeenCalledWith('Delete daemon?', expect.any(String), expect.any(Array));
    const buttons = (jest.mocked(Alert.alert).mock.calls.at(-1)?.[2] ?? []) as AlertButton[];

    act(() => { buttons[0].onPress?.(); });
    expect(props.onDelete).not.toHaveBeenCalled();

    act(() => { buttons[1].onPress?.(); });
    expect(props.onDelete).toHaveBeenCalledWith(second.endpoint);
    act(() => tree.unmount());
  });
});

describe('ConnectionSheet editor', () => {
  it('prefills all six stored fields, masks the token, and Save emits the full replacement', async () => {
    const props = makeProps();
    const tree = await renderSheet(props);

    act(() => actionFor(tree, `Edit ${first.endpoint}`)());

    expect(isType(tree.root.findByProps({ accessibilityLabel: 'Cancel edit' }), Pressable)).toBe(true);
    expect(isType(tree.root.findByProps({ accessibilityLabel: 'Save' }), Pressable)).toBe(true);
    expect(isType(tree.root.findByProps({ value: first.skipFingerprintVerification }), Switch)).toBe(true);

    const inputs = tree.root.findAllByType(TextInput);
    const byPlaceholder = (placeholder: string) => inputs.find((input) => input.props.placeholder === placeholder)!;
    expect(byPlaceholder('Name').props.value).toBe(first.name);
    expect(byPlaceholder('Endpoint').props.value).toBe(first.endpoint);
    expect(byPlaceholder('Fingerprint').props.value).toBe(first.fingerprint);
    expect(byPlaceholder('Client name').props.value).toBe(first.clientName);
    const tokenInput = byPlaceholder('Session token');
    expect(tokenInput.props.value).toBe(first.token);
    expect(tokenInput.props.secureTextEntry).toBe(true);

    act(() => { byPlaceholder('Name').props.onChangeText('Renamed daemon'); });
    await act(async () => { actionFor(tree, 'Save')(); await Promise.resolve(); });

    expect(props.onSave).toHaveBeenCalledWith(first.endpoint, { ...first, name: 'Renamed daemon' });
    act(() => tree.unmount());
  });

  it('shows "Could not update daemon" on a rejected save and keeps the editor mounted', async () => {
    const props = makeProps({ onSave: jest.fn(async () => { throw new Error('endpoint already saved'); }) });
    const tree = await renderSheet(props);

    act(() => actionFor(tree, `Edit ${first.endpoint}`)());
    await act(async () => { actionFor(tree, 'Save')(); await Promise.resolve(); });

    expect(Alert.alert).toHaveBeenCalledWith('Could not update daemon', 'endpoint already saved');
    expect(tree.root.findAllByProps({ placeholder: 'Name' }).length).toBeGreaterThan(0);
    act(() => tree.unmount());
  });
});
