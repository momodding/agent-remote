jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children, ...props }: { children?: React.ReactNode }) => require('react').createElement('SafeAreaView', props, children) }));
jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  return { Platform: RN.Platform, Pressable: RN.Pressable, StyleSheet: RN.StyleSheet, Text: RN.Text, View: RN.View };
});

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform } from 'react-native';
import type { Connection, ConnectionStore } from './lib/connection';

const mockConnection: Connection = {
  name: 'Test daemon',
  endpoint: 'https://daemon.test:8765',
  token: 'secret',
  fingerprint: '',
  skipFingerprintVerification: true,
  clientName: 'test',
};
const mockStore: ConnectionStore = { connections: [mockConnection], selectedEndpoint: mockConnection.endpoint };

// Mock WebSocket
const mockSend = jest.fn();
const mockClose = jest.fn();
let mockWsInstance: {
  binaryType: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send: jest.Mock;
  close: jest.Mock;
};
const MockWebSocket = jest.fn().mockImplementation(() => {
  mockWsInstance = {
    binaryType: 'blob',
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: mockSend,
    close: mockClose,
  };
  return mockWsInstance;
});
Object.assign(MockWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
(globalThis as unknown as Record<string, unknown>).WebSocket = MockWebSocket;

const mockInjectJavaScript = jest.fn();
jest.mock('react-native-webview', () => {
  const React = require('react');
  const WebView = React.forwardRef((_props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({ injectJavaScript: mockInjectJavaScript }));
    // Auto-fire onLoadEnd to trigger socket connection
    React.useEffect(() => { if (_props.onLoadEnd) (_props.onLoadEnd as () => void)(); }, []);
    return React.createElement('WebView', _props);
  });
  return { __esModule: true, WebView };
});

jest.mock('expo-router', () => ({
  router: { back: jest.fn() },
  useLocalSearchParams: () => ({ connectionEndpoint: mockConnection.endpoint }),
}));
jest.mock('./lib/connection', () => ({
  loadConnections: async () => mockStore,
  getConnection: (_store: unknown, endpoint: string) => mockStore.connections.find((c) => c.endpoint === endpoint),
}));
jest.mock('./generated/novnc_script', () => ({ __esModule: true, default: '/* novnc */' }));
jest.mock('@expo/vector-icons/Feather', () => ({ __esModule: true, default: () => null }));

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', { value: 'android' });
});

async function renderScreen(): Promise<ReactTestRenderer> {
  const DesktopScreen = require(Platform.OS === 'web' ? '../app/desktop.web' : '../app/desktop').default;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<DesktopScreen />); await Promise.resolve(); });
  return tree;
}

it('opens RN WebSocket with VNC URL on native platforms', async () => {
  await renderScreen();
  expect(MockWebSocket).toHaveBeenCalledWith('wss://daemon.test:8765/v1/ws/vnc?token=secret');
});

it('forwards binary from RN WebSocket to WebView as base64', async () => {
  await renderScreen();
  // Simulate binary frame from server
  const data = new Uint8Array([0x01, 0x02, 0x03]).buffer;
  await act(async () => { mockWsInstance.onmessage?.({ data }); });
  expect(mockInjectJavaScript).toHaveBeenCalledWith(
    expect.stringContaining('vnc')
  );
  // Verify base64 payload is present (btoa of \x01\x02\x03 = AQID)
  expect(mockInjectJavaScript).toHaveBeenCalledWith(
    expect.stringContaining('AQID')
  );
});

it('forwards outbound WebView binary to RN WebSocket', async () => {
  const tree = await renderScreen();
  const webview = tree.root.findByType('WebView' as never);
  // Simulate noVNC sending base64-encoded data via postMessage
  // btoa of \x04\x05 = BAU=
  const message = JSON.stringify({ type: 'vnc', data: 'BAU=' });
  await act(async () => { webview.props.onMessage({ nativeEvent: { data: message } }); });
  expect(mockSend).toHaveBeenCalledTimes(1);
  const sent = mockSend.mock.calls[0][0] as Uint8Array;
  expect(Array.from(sent)).toEqual([0x04, 0x05]);
});

it('closes RN WebSocket on unmount', async () => {
  const tree = await renderScreen();
  await act(async () => { tree.unmount(); });
  expect(mockClose).toHaveBeenCalled();
});

it('renders bridged HTML without wsURL on native', async () => {
  const tree = await renderScreen();
  const webview = tree.root.findByType('WebView' as never);
  const html = webview.props.source.html as string;
  // Bridged HTML should NOT contain the wsURL directly; RFB gets a channel object
  expect(html).toContain('const channel');
  expect(html).not.toContain('wss://daemon.test');
});

it('opens the noVNC raw channel only after the RN WebSocket connects', async () => {
  const tree = await renderScreen();
  const html = tree.root.findByType('WebView' as never).props.source.html as string;
  expect(html).toContain('readyState: 0');
  expect(html).toContain('channel.readyState = 1');
  expect(html).not.toContain("readyState: 'open'");
});

it('forwards the RN WebSocket open event to noVNC', async () => {
  await renderScreen();
  await act(async () => { mockWsInstance.onopen?.(); });
  expect(mockInjectJavaScript).toHaveBeenCalledWith(expect.stringContaining('vnc-open'));
});

it('uses WebView-safe microtask scheduling without setImmediate', async () => {
  const tree = await renderScreen();
  const html = tree.root.findByType('WebView' as never).props.source.html as string;
  expect(html).toContain("typeof queueMicrotask === 'function'");
  expect(html).toContain('Promise.resolve().then(callback)');
  expect(html).not.toContain('setImmediate');
  expect(html).toContain('flushScheduled');
});

it('keeps ordered transport stages and reports socket failures without secrets', async () => {
  const tree = await renderScreen();
  const html = tree.root.findByType('WebView' as never).props.source.html as string;
  expect(html.indexOf('Loading noVNC…')).toBeLessThan(html.indexOf('Creating RFB…'));
  expect(html.indexOf('Creating RFB…')).toBeLessThan(html.indexOf('Connecting WebSocket…'));
  expect(html).toContain('WebSocket connection failed');
  expect(html).not.toContain(mockConnection.token);
});

it('closes the previous socket before reconnecting the WebView', async () => {
  const tree = await renderScreen();
  const webview = tree.root.findByType('WebView' as never);
  await act(async () => { webview.props.onLoadEnd(); });
  expect(mockClose).toHaveBeenCalledWith(1000, 'desktop view reloaded');
  expect(MockWebSocket).toHaveBeenCalledTimes(2);
});

it('exposes noVNC raw channel message receiver as an own enumerable property', async () => {
  const tree = await renderScreen();
  const html = tree.root.findByType('WebView' as never).props.source.html as string;
  expect(html).toContain("Object.defineProperty(channel, 'onmessage', {");
  expect(html).toContain('enumerable: true');
});

it('renders the native VNC shortcut dock and retains controls in the web document', async () => {
  let tree = await renderScreen();
  expect(tree.root.findByProps({ testID: 'vnc-shortcut-dock' })).toBeTruthy();
  expect(tree.root.findByProps({ accessibilityLabel: 'Ctrl Alt Delete' })).toBeTruthy();
});

it('renders web Remote Desktop from the local noVNC bundle with native shortcut parity', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'web' });
  const tree = await renderScreen();
  const frame = tree.root.findByType('iframe' as never);
  expect(frame.props.srcDoc).toContain('/* novnc */');
  expect(frame.props.srcDoc).not.toContain('cdn.jsdelivr.net');
  expect(frame.props.srcDoc).toContain('Creating RFB…');
  expect(frame.props.srcDoc).toContain('Connecting WebSocket…');
  expect(tree.root.findByProps({ testID: 'vnc-shortcut-dock' })).toBeTruthy();
  expect(tree.root.findByProps({ accessibilityLabel: 'Ctrl Alt Delete' })).toBeTruthy();
});
