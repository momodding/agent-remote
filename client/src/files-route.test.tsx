jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children, ...props }: { children?: React.ReactNode }) => require('react').createElement('SafeAreaView', props, children) }));

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, Platform, Pressable, Text } from 'react-native';
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
const mockHostEntries: FileEntry[] = [{ path: '/tmp', name: 'tmp', isDir: true, size: 0, mode: 'drwxr-xr-x' }];
const mockTmpEntries: FileEntry[] = [{ path: '/tmp/other', name: 'other', isDir: true, size: 0, mode: 'drwxr-xr-x' }];
const mockOtherEntries: FileEntry[] = [];
const mockCopyFile = jest.fn(async () => undefined);
const mockRenameFile = jest.fn(async () => undefined);
const mockDownloadRequest = jest.fn(() => ({ url: 'https://daemon.test:8765/v1/fs/download?path=readme.txt', headers: { Authorization: 'Bearer secret' } }));
const mockDirectoryCreate = jest.fn();
const mockDownloadFileAsync = jest.fn(async (_url: string, _destination: unknown, _options: unknown) => ({ uri: 'file:///cache/readme.txt' }));
const mockSharingAvailable = jest.fn(async () => true);
const mockShareAsync = jest.fn(async (_url: string, _options: unknown) => undefined);
const mockFiles = jest.fn(async (path: string) => {
  if (path === 'docs') return mockDocsEntries;
  if (path === '/') return mockHostEntries;
  if (path === '/tmp') return mockTmpEntries;
  if (path === '/tmp/other') return mockOtherEntries;
  return mockRootEntries;
});
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
    renameFile: mockRenameFile,
    copyFile: mockCopyFile,
    downloadRequest: mockDownloadRequest,
  })),
}));
jest.mock('expo-file-system', () => ({
  __esModule: true,
  Directory: jest.fn().mockImplementation(function () { return { create: mockDirectoryCreate }; }),
  File: { downloadFileAsync: (url: string, destination: unknown, options: unknown) => mockDownloadFileAsync(url, destination, options) },
  Paths: { cache: { uri: 'file:///cache' } },
}));
jest.mock('expo-sharing', () => ({
  __esModule: true,
  isAvailableAsync: () => mockSharingAvailable(),
  shareAsync: (url: string, options: unknown) => mockShareAsync(url, options),
}));
jest.mock('@expo/vector-icons/Feather', () => ({ __esModule: true, default: () => null }));

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', { value: 'ios' });
});
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
  tree.root.findByProps({ accessibilityLabel: label }).props.onPress();
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

it('opens typed absolute paths and host root', async () => {
  const tree = await renderScreen();
  act(() => tree.root.findByProps({ accessibilityLabel: 'Path' }).props.onChangeText('/tmp/other'));
  await act(async () => { press(tree, 'Go to path'); await Promise.resolve(); });
  expect(mockFiles).toHaveBeenLastCalledWith('/tmp/other');

  await act(async () => { press(tree, 'Host root'); await Promise.resolve(); });
  expect(mockFiles).toHaveBeenLastCalledWith('/');
});

it('navigates absolute breadcrumbs and parent paths', async () => {
  const tree = await renderScreen();
  await act(async () => { press(tree, 'Host root'); await Promise.resolve(); });
  await act(async () => { press(tree, 'Open folder tmp'); await Promise.resolve(); });
  expect(mockFiles).toHaveBeenLastCalledWith('/tmp');

  await act(async () => { press(tree, 'Navigate to /'); await Promise.resolve(); });
  expect(mockFiles).toHaveBeenLastCalledWith('/');

  await act(async () => { press(tree, 'Open folder tmp'); await Promise.resolve(); });
  await act(async () => { press(tree, 'Parent directory'); await Promise.resolve(); });
  expect(mockFiles).toHaveBeenLastCalledWith('/');
});

it('copies and cuts into the current directory', async () => {
  const tree = await renderScreen();
  await act(async () => { press(tree, 'Open folder docs'); await Promise.resolve(); });

  act(() => press(tree, 'Copy readme.txt'));
  await act(async () => { press(tree, 'Paste into current directory'); await Promise.resolve(); });
  expect(mockCopyFile).toHaveBeenCalledWith('docs/readme.txt', 'docs/readme.txt');

  act(() => press(tree, 'Cut readme.txt'));
  await act(async () => { press(tree, 'Paste into current directory'); await Promise.resolve(); });
  expect(mockRenameFile).toHaveBeenCalledWith('docs/readme.txt', 'docs/readme.txt');
});

it('renames sibling files and rejects invalid names', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const tree = await renderScreen();
  await act(async () => { press(tree, 'Open folder docs'); await Promise.resolve(); });

  act(() => press(tree, 'Rename readme.txt'));
  act(() => tree.root.findByProps({ accessibilityLabel: 'New name' }).props.onChangeText('new.txt'));
  await act(async () => { press(tree, 'Save rename'); await Promise.resolve(); });
  expect(mockRenameFile).toHaveBeenCalledWith('docs/readme.txt', 'docs/new.txt');

  act(() => press(tree, 'Rename readme.txt'));
  act(() => tree.root.findByProps({ accessibilityLabel: 'New name' }).props.onChangeText('bad/name'));
  act(() => press(tree, 'Save rename'));
  expect(alertSpy).toHaveBeenCalledWith('Invalid name');
  alertSpy.mockRestore();
});

it('downloads and opens files with native sharing', async () => {
  const tree = await renderScreen();
  await act(async () => { press(tree, 'Open folder docs'); await Promise.resolve(); });

  await act(async () => { press(tree, 'Download readme.txt'); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(mockDownloadRequest).toHaveBeenCalledWith('docs/readme.txt');
  expect(mockDirectoryCreate).toHaveBeenCalledWith({ idempotent: true, intermediates: true });
  expect(mockDownloadFileAsync).toHaveBeenCalledWith('https://daemon.test:8765/v1/fs/download?path=readme.txt', expect.anything(), { headers: { Authorization: 'Bearer secret' }, idempotent: true });
  expect(mockShareAsync).toHaveBeenCalledWith('file:///cache/readme.txt', { dialogTitle: 'Download file', mimeType: 'application/octet-stream' });

  await act(async () => { press(tree, 'Open with readme.txt'); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(mockShareAsync).toHaveBeenLastCalledWith('file:///cache/readme.txt', { dialogTitle: 'Open with…', mimeType: 'application/octet-stream' });
});
