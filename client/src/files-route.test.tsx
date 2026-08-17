jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children, ...props }: { children?: React.ReactNode }) => require('react').createElement('SafeAreaView', props, children) }));
jest.mock('react-native', () => {
  const React = require('react');
  const RN = jest.requireActual('react-native');
  return {
    ActivityIndicator: RN.ActivityIndicator,
    Alert: RN.Alert,
    KeyboardAvoidingView: RN.KeyboardAvoidingView,
    Modal: RN.Modal,
    Platform: RN.Platform,
    Pressable: RN.Pressable,
    StyleSheet: RN.StyleSheet,
    Text: RN.Text,
    TextInput: RN.TextInput,
    View: RN.View,
    FlatList: ({ data = [], renderItem, keyExtractor, ...props }: { data?: unknown[]; renderItem: (info: { item: unknown; index: number }) => React.ReactNode; keyExtractor?: (item: unknown, index: number) => string }) =>
      React.createElement(RN.View, props, data.map((item, index) => React.createElement(React.Fragment, { key: keyExtractor?.(item, index) ?? index }, renderItem({ item, index })))),
  };
});

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
const mockParentEntries: FileEntry[] = [{ path: '/tmp/workspace-sibling', name: 'workspace-sibling', isDir: true, size: 0, mode: 'drwxr-xr-x' }];
const mockOtherEntries: FileEntry[] = [];
const mockCopyFile = jest.fn(async () => undefined);
const mockRenameFile = jest.fn(async () => undefined);
const mockDownloadRequest = jest.fn(() => ({ url: 'https://daemon.test:8765/v1/fs/download?path=readme.txt', headers: { Authorization: 'Bearer secret' } }));
const mockDirectoryCreate = jest.fn();
const mockDownloadFileAsync = jest.fn(async (_url: string, _destination: unknown, _options: unknown) => ({ uri: 'file:///cache/readme.txt' }));
const mockSharingAvailable = jest.fn(async () => true);
const mockShareAsync = jest.fn(async (_url: string, _options: unknown) => undefined);
const mockGetContentUriAsync = jest.fn(async () => 'content://cache/readme.txt');
const mockRequestDirectoryPermissionsAsync = jest.fn(async () => ({ granted: true, directoryUri: 'content://downloads' }));
const mockCreateFileAsync = jest.fn(async (_directoryUri: string, _fileName: string, _mimeType: string) => 'content://downloads/readme.txt');
const mockCopyAsync = jest.fn(async (_options: unknown) => undefined);
const mockStartActivityAsync = jest.fn(async (_action: string, _params: unknown) => undefined);
const mockFiles = jest.fn(async (path: string) => {
  if (path === 'docs') return mockDocsEntries;
  if (path === '/') return mockHostEntries;
  if (path === '/tmp') return mockTmpEntries;
  if (path === '/tmp/other') return mockOtherEntries;
  if (path === '..') return mockParentEntries;
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
jest.mock('expo-file-system/legacy', () => ({
  __esModule: true,
  getContentUriAsync: () => mockGetContentUriAsync(),
  StorageAccessFramework: {
    requestDirectoryPermissionsAsync: () => mockRequestDirectoryPermissionsAsync(),
    createFileAsync: (directoryUri: string, fileName: string, mimeType: string) => mockCreateFileAsync(directoryUri, fileName, mimeType),
  },
  copyAsync: (options: unknown) => mockCopyAsync(options),
}));
jest.mock('expo-intent-launcher', () => ({
  __esModule: true,
  startActivityAsync: (action: string, params: unknown) => mockStartActivityAsync(action, params),
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

function longPress(tree: ReactTestRenderer, label: string) {
  tree.root.findByProps({ accessibilityLabel: label }).props.onLongPress();
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

it('navigates from workspace root to its parent', async () => {
  const tree = await renderScreen();
  await act(async () => { press(tree, 'Parent directory'); await Promise.resolve(); });
  expect(mockFiles).toHaveBeenLastCalledWith('..');
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

it('copies and cuts into the current directory from the long-press menu', async () => {
  const tree = await renderScreen();
  await act(async () => { press(tree, 'Open folder docs'); await Promise.resolve(); });

  act(() => longPress(tree, 'Open file readme.txt'));
  act(() => press(tree, 'More actions readme.txt'));
  act(() => press(tree, 'Copy readme.txt'));
  await act(async () => { press(tree, 'Paste into current directory'); await Promise.resolve(); });
  expect(mockCopyFile).toHaveBeenCalledWith('docs/readme.txt', 'docs/readme.txt');

  act(() => longPress(tree, 'Open file readme.txt'));
  act(() => press(tree, 'More actions readme.txt'));
  act(() => press(tree, 'Cut readme.txt'));
  await act(async () => { press(tree, 'Paste into current directory'); await Promise.resolve(); });
  expect(mockRenameFile).toHaveBeenCalledWith('docs/readme.txt', 'docs/readme.txt');
});

it('renames sibling files and rejects invalid names from the long-press menu', async () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const tree = await renderScreen();
  await act(async () => { press(tree, 'Open folder docs'); await Promise.resolve(); });

  act(() => longPress(tree, 'Open file readme.txt'));
  act(() => press(tree, 'More actions readme.txt'));
  act(() => press(tree, 'Rename readme.txt'));
  act(() => tree.root.findByProps({ accessibilityLabel: 'New name' }).props.onChangeText('new.txt'));
  await act(async () => { press(tree, 'Save rename'); await Promise.resolve(); });
  expect(mockRenameFile).toHaveBeenCalledWith('docs/readme.txt', 'docs/new.txt');

  act(() => longPress(tree, 'Open file readme.txt'));
  act(() => press(tree, 'More actions readme.txt'));
  act(() => press(tree, 'Rename readme.txt'));
  act(() => tree.root.findByProps({ accessibilityLabel: 'New name' }).props.onChangeText('bad/name'));
  act(() => press(tree, 'Save rename'));
  expect(alertSpy).toHaveBeenCalledWith('Invalid name');
  alertSpy.mockRestore();
});

it('downloads and opens files with native sharing from the long-press menu', async () => {
  const tree = await renderScreen();
  await act(async () => { press(tree, 'Open folder docs'); await Promise.resolve(); });

  act(() => longPress(tree, 'Open file readme.txt'));
  act(() => press(tree, 'More actions readme.txt'));
  await act(async () => { press(tree, 'Download readme.txt'); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(mockDownloadRequest).toHaveBeenCalledWith('docs/readme.txt');
  expect(mockDirectoryCreate).toHaveBeenCalledWith({ idempotent: true, intermediates: true });
  expect(mockDownloadFileAsync).toHaveBeenCalledWith('https://daemon.test:8765/v1/fs/download?path=readme.txt', expect.anything(), { headers: { Authorization: 'Bearer secret' }, idempotent: true });
  expect(mockShareAsync).toHaveBeenCalledWith('file:///cache/readme.txt', { dialogTitle: 'Download file', mimeType: 'application/octet-stream' });

  act(() => longPress(tree, 'Open file readme.txt'));
  act(() => press(tree, 'More actions readme.txt'));
  await act(async () => { press(tree, 'Open with readme.txt'); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(mockShareAsync).toHaveBeenLastCalledWith('file:///cache/readme.txt', { dialogTitle: 'Open with…', mimeType: 'application/octet-stream' });
});

it('downloads with Android SAF and opens with ACTION_VIEW', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'android' });
  const tree = await renderScreen();
  await act(async () => { press(tree, 'Open folder docs'); await Promise.resolve(); });

  act(() => longPress(tree, 'Open file readme.txt'));
  act(() => press(tree, 'More actions readme.txt'));
  await act(async () => { press(tree, 'Download readme.txt'); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(mockRequestDirectoryPermissionsAsync).toHaveBeenCalledTimes(1);
  expect(mockCreateFileAsync).toHaveBeenCalledWith('content://downloads', 'readme.txt', 'application/octet-stream');
  expect(mockCopyAsync).toHaveBeenCalledWith({ from: 'file:///cache/readme.txt', to: 'content://downloads/readme.txt' });
  expect(mockRequestDirectoryPermissionsAsync.mock.invocationCallOrder[0]).toBeLessThan(mockCreateFileAsync.mock.invocationCallOrder[0]);
  expect(mockCreateFileAsync.mock.invocationCallOrder[0]).toBeLessThan(mockCopyAsync.mock.invocationCallOrder[0]);
  expect(mockShareAsync).not.toHaveBeenCalled();

  act(() => longPress(tree, 'Open file readme.txt'));
  act(() => press(tree, 'More actions readme.txt'));
  await act(async () => { press(tree, 'Open with readme.txt'); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(mockGetContentUriAsync).toHaveBeenCalledTimes(1);
  expect(mockStartActivityAsync).toHaveBeenCalledWith('android.intent.action.VIEW', {
    data: 'content://cache/readme.txt',
    type: 'application/octet-stream',
    flags: 1,
  });
  expect(mockGetContentUriAsync.mock.invocationCallOrder[0]).toBeLessThan(mockStartActivityAsync.mock.invocationCallOrder[0]);
  expect(mockShareAsync).not.toHaveBeenCalled();
});
