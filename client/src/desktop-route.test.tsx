jest.mock('expo-crypto', () => ({
  randomUUID: () => 'generated-tab',
  digestStringAsync: jest.fn(),
  getRandomBytes: () => new Uint8Array(32),
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children, ...props }: { children?: React.ReactNode }) => require('react').createElement('SafeAreaView', props, children),
}));
jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  return { Platform: RN.Platform, Pressable: RN.Pressable, StyleSheet: RN.StyleSheet, Text: RN.Text, View: RN.View };
});

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform } from 'react-native';
import type { Connection, ConnectionStore } from './lib/connection';
import type { DesktopWorkspaceTab } from './lib/tabs/types';
import type { DesktopSessionResponse } from './protocol';
import { AgenticRemoteAPI } from './lib/api';

const mockConnection: Connection = {
  name: 'Test daemon',
  endpoint: 'https://daemon.test:8765',
  hostId: 'mock-host-id',
  token: 'secret',
  fingerprint: '',
  skipFingerprintVerification: true,
  clientName: 'test',
};
const mockStore: ConnectionStore = { connections: [mockConnection] };

const mockTab: DesktopWorkspaceTab = {
  tabId: 'desktop-tab',
  daemonId: mockConnection.hostId,
  kind: 'desktop',
  remoteSessionId: 'sess-123',
  title: 'Mock Desktop',
  createdAt: 0,
  lastActiveAt: 0,
  pinned: false,
  state: 'connecting',
};
const mockTabStore = {
  state: { tabs: [mockTab], activeId: mockTab.tabId, layout: {} },
  dispatch: jest.fn(),
  closeTab: jest.fn(),
};

const mockInjectJavaScript = jest.fn();
jest.mock('react-native-webview', () => {
  const React = require('react');
  const WebView = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({ injectJavaScript: mockInjectJavaScript }));
    return React.createElement('WebView', props);
  });
  return { __esModule: true, WebView };
});

jest.mock('expo-router', () => ({
  router: { back: jest.fn() },
  useLocalSearchParams: () => ({ tabId: mockTab.tabId }),
}));
jest.mock('./lib/connection', () => ({
  loadConnections: async () => mockStore,
  getConnection: (_store: unknown, hostId: string) => mockStore.connections.find((c) => c.hostId === hostId),
}));
jest.mock('./lib/tabs/tab-store', () => ({
  useTabStore: () => mockTabStore,
}));
jest.mock('./generated/novnc_script', () => ({ __esModule: true, default: '/* novnc */' }));
jest.mock('@expo/vector-icons/Feather', () => ({ __esModule: true, default: () => null }));

const mockIframePostMessage = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', { value: 'android' });
  jest.spyOn(AgenticRemoteAPI.prototype, 'createDesktopSession').mockResolvedValue({
    ticket: 'test-ticket-123',
    wsUrl: 'wss://daemon.test:8765/v1/ws/rfb?ticket=test-ticket-123',
    expiresAt: '2026-09-17T00:00:00Z',
  } satisfies DesktopSessionResponse);
});

async function renderScreen(): Promise<ReactTestRenderer> {
  const DesktopScreen = require(Platform.OS === 'web' ? '../app/desktop.web' : '../app/desktop').default;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<DesktopScreen />, {
      createNodeMock: (element) => (element.type === 'iframe' ? { contentWindow: { postMessage: mockIframePostMessage } } : null),
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  });
  return tree;
}

describe('native (WebView) desktop', () => {
  it('acquires a desktop session ticket and configures RFB with the ticket wsUrl', async () => {
    const tree = await renderScreen();
    const html = tree.root.findByType('WebView' as never).props.source.html as string;
    expect(html).toContain('new window.RFB(screen, "wss://daemon.test:8765/v1/ws/rfb?ticket=test-ticket-123")');
    expect(html).not.toContain('BridgeWebSocket');
    expect(html).not.toContain('ws://bridge');
    expect(html).toContain('/* novnc */');
  });

  it('reports transport stages in order', async () => {
    const tree = await renderScreen();
    const html = tree.root.findByType('WebView' as never).props.source.html as string;
    expect(html.indexOf('Loading noVNC…')).toBeLessThan(html.indexOf('Creating RFB…'));
  });

  it('shows the initial loading status, updates from parsed status messages, and hides once connected', async () => {
    const tree = await renderScreen();
    expect(tree.root.findByProps({ children: 'Loading noVNC…' })).toBeTruthy();
    const webview = tree.root.findByType('WebView' as never);

    await act(async () => {
      webview.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'status', message: 'Connecting WebSocket…' }) } });
    });
    expect(tree.root.findByProps({ children: 'Connecting WebSocket…' })).toBeTruthy();

    await act(async () => {
      webview.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'status', message: 'Desktop connected' }) } });
    });
    expect(tree.root.findAllByProps({ children: 'Desktop connected' })).toHaveLength(0);
  });

  it('falls back to the raw posted body when the WebView message is not JSON', async () => {
    const tree = await renderScreen();
    const webview = tree.root.findByType('WebView' as never);
    await act(async () => {
      webview.props.onMessage({ nativeEvent: { data: 'not json' } });
    });
    expect(tree.root.findByProps({ children: 'not json' })).toBeTruthy();
  });

  it('renders the shortcut dock and forwards key/Ctrl+Alt+Del presses via injectJavaScript', async () => {
    const tree = await renderScreen();
    expect(tree.root.findByProps({ testID: 'vnc-shortcut-dock' })).toBeTruthy();

    act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Escape' }).props.onPress();
    });
    expect(mockInjectJavaScript).toHaveBeenCalledWith('window.rfb?.sendKey(65307, "Escape");true;');

    act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Tab' }).props.onPress();
    });
    expect(mockInjectJavaScript).toHaveBeenCalledWith('window.rfb?.sendKey(65289, "Tab");true;');

    act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Ctrl Alt Delete' }).props.onPress();
    });
    expect(mockInjectJavaScript).toHaveBeenCalledWith('window.rfb?.sendCtrlAltDel();true;');
  });

  it('displays error status when createDesktopSession fails', async () => {
    jest.spyOn(AgenticRemoteAPI.prototype, 'createDesktopSession').mockRejectedValue(new Error('VNC unavailable'));
    const tree = await renderScreen();
    expect(tree.root.findByProps({ children: 'VNC unavailable' })).toBeTruthy();
  });
});

describe('web (iframe) desktop', () => {
  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { value: 'web' });
  });

  it('renders the local generated noVNC bundle with the ticket wsUrl in iframe', async () => {
    const tree = await renderScreen();
    const html = tree.root.findByType('iframe' as never).props.srcDoc as string;
    expect(html).toContain('/* novnc */');
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(html).not.toContain('BridgeWebSocket');
    expect(html).toContain('new window.RFB(screen, "wss://daemon.test:8765/v1/ws/rfb?ticket=test-ticket-123")');
    expect(html).toContain('Creating RFB…');
  });

  it('renders shortcut dock parity and posts key messages into the iframe window', async () => {
    const tree = await renderScreen();
    expect(tree.root.findByProps({ testID: 'vnc-shortcut-dock' })).toBeTruthy();

    act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Escape' }).props.onPress();
    });
    expect(mockIframePostMessage).toHaveBeenCalledWith({ type: 'key', keysym: 0xff1b, name: 'Escape' }, '*');

    act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Tab' }).props.onPress();
    });
    expect(mockIframePostMessage).toHaveBeenCalledWith({ type: 'key', keysym: 0xff09, name: 'Tab' }, '*');

    act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Ctrl Alt Delete' }).props.onPress();
    });
    expect(mockIframePostMessage).toHaveBeenCalledWith({ type: 'ctrl-alt-delete' }, '*');
  });

  it('displays error status when createDesktopSession fails on web', async () => {
    jest.spyOn(AgenticRemoteAPI.prototype, 'createDesktopSession').mockRejectedValue(new Error('VNC unavailable'));
    const tree = await renderScreen();
    expect(tree.root.findByProps({ children: 'VNC unavailable' })).toBeTruthy();
  });
});
