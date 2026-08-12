jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children, ...props }: { children?: React.ReactNode }) => require('react').createElement('SafeAreaView', props, children) }));

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Pressable, Text } from 'react-native';
import { router } from 'expo-router';
import FilesScreen from '../app/files';
import type { Connection, ConnectionStore } from './lib/connection';
import type { FileEntry } from './protocol';

const mockConnection: Connection = {
  name: 'Test daemon',
  endpoint: 'https://daemon.test:8765',
  token: 'secret',
  fingerprint: '',
  skipFingerprintVerification: false,
  clientName: 'test',
};
const mockStore: ConnectionStore = { connections: [mockConnection], selectedEndpoint: mockConnection.endpoint };
const mockRootEntries: FileEntry[] = [{ path: 'docs', name: 'docs', isDir: true, size: 0, mode: 'drwxr-xr-x' }];
const mockDocsEntries: FileEntry[] = [{ path: 'docs/readme.txt', name: 'readme.txt', isDir: false, size: 12, mode: '-rw-r--r--' }];
const mockFiles = jest.fn(async (path: string) => path === 'docs' ? mockDocsEntries : mockRootEntries);
const mockGitStatus = jest.fn(async () => ({ available: true, entries: [] }));

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  router: { replace: jest.fn() },
  useLocalSearchParams: () => ({ connectionEndpoint: mockConnection.endpoint }),
}));
jest.mock('./lib/connection', () => ({
  loadConnections: jest.fn(async () => mockStore),
  getConnection: jest.fn(() => mockConnection),
}));
jest.mock('./lib/api', () => ({
  AgenticRemoteAPI: jest.fn(() => ({
    files: mockFiles,
    searchFiles: jest.fn(),
    gitStatus: mockGitStatus,
    readFile: jest.fn(),
    writeFile: jest.fn(),
  })),
}));
jest.mock('@expo/vector-icons/Feather', () => ({ __esModule: true, default: () => null }));

async function renderScreen() {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<FilesScreen />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return tree;
}

function press(tree: ReactTestRenderer, label: string) {
  act(() => tree.root.findByProps({ accessibilityLabel: label }).props.onPress());
}

it('shows daemon files and supports breadcrumb, parent, current refresh, and close', async () => {
  const tree = await renderScreen();

  expect(tree.root.findAllByType(Text).some((node) => node.props.children === 'daemon.test:8765')).toBe(true);
  expect(tree.root.findAllByType(Text).some((node) => node.props.children === 'docs')).toBe(true);

  await act(async () => { press(tree, 'Open folder docs'); await Promise.resolve(); });
  expect(mockFiles).toHaveBeenLastCalledWith('docs');
  expect(tree.root.findAllByType(Text).some((node) => node.props.children === 'readme.txt')).toBe(true);

  await act(async () => { press(tree, 'Navigate to docs'); await Promise.resolve(); });
  expect(mockFiles.mock.calls.filter(([path]) => path === 'docs')).toHaveLength(2);

  await act(async () => { press(tree, 'Parent directory'); await Promise.resolve(); });
  expect(mockFiles).toHaveBeenLastCalledWith('');

  act(() => tree.root.findByProps({ accessibilityLabel: 'Close file manager' }).props.onPress());
  expect(router.replace).toHaveBeenCalledWith('/');
});
