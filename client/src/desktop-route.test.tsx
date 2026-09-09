jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children, ...props }: { children?: React.ReactNode }) => require('react').createElement('SafeAreaView', props, children) }));
jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  return { Platform: RN.Platform, Pressable: RN.Pressable, StyleSheet: RN.StyleSheet, Text: RN.Text, View: RN.View };
});

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform } from 'react-native';
import type { Connection, ConnectionStore } from './lib/connection';

import type { DesktopWorkspaceTab } from './lib/tabs/types';
import type { ChannelEnvelope, DaemonChannel } from './lib/daemon-channel';

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
  createdAt: 0, lastActiveAt: 0,
  pinned: false,
  state: 'connecting',
};
const mockTabStore = {
  state: { tabs: [mockTab], activeId: mockTab.tabId, layout: {} },
  dispatch: jest.fn(),
  closeTab: jest.fn(),
};

const mockChannel: DaemonChannel = {
  daemonId: mockConnection.hostId,
  status: 'open',
  send: jest.fn(),
  subscribe: jest.fn((_channelId: string, fn: (msg: ChannelEnvelope) => void) => {
    mockSubscribers.push(fn);
    return jest.fn();
  }),
  openChannel: jest.fn(async () => 'mock-channel-id'),
  closeChannel: jest.fn(),
};
let mockSubscribers: Array<(msg: ChannelEnvelope) => void> = [];
const mockEmit = (msg: ChannelEnvelope) => {
  act(() => { mockSubscribers.forEach((fn) => fn(msg)); });
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
jest.mock('./lib/daemon-channel', () => ({
  createDaemonChannel: () => mockChannel,
  channelRegistry: new Map(),
}));
jest.mock('./generated/novnc_script', () => ({ __esModule: true, default: '/* novnc */' }));
jest.mock('@expo/vector-icons/Feather', () => ({ __esModule: true, default: () => null }));

const mockIframePostMessage = jest.fn();

let mockMessageListener: ((event: any) => void) | null = null;

beforeEach(() => {
  mockSubscribers = [];
  mockMessageListener = null;
  jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', { value: 'android' });
  const _addEventListener = jest.fn((type: string, handler: any) => {
    if (type === 'message') mockMessageListener = handler;
  });
  Object.defineProperty(globalThis, 'window', { value: { addEventListener: _addEventListener, removeEventListener: jest.fn(), dispatchEvent: jest.fn() }, writable: true });
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
  it('embeds the mock BridgeWebSocket and configures RFB against it', async () => {
    const tree = await renderScreen();
    const html = tree.root.findByType('WebView' as never).props.source.html as string;
    expect(html).toContain('class BridgeWebSocket');
    expect(html).toContain('new window.RFB(screen, "ws://bridge")');
    expect(html).toContain("this.protocol = '';");
    expect(html).toContain('window.ReactNativeWebView?.postMessage');
  });

  it('injects incoming channel vnc.data into the WebView', async () => {
    await renderScreen();
    await act(async () => {
      mockEmit({ channelId: mockTab.remoteSessionId, kind: 'desktop', type: 'vnc.data', data: 'abcd' });
    });
    expect(mockInjectJavaScript).toHaveBeenCalledWith(expect.stringContaining("window.__rfb_ws.onmessage({ data: base64ToU8('abcd').buffer })"));
  });

  it('forwards vnc.data emitted by WebView back to the channel', async () => {
    const sendSpy = jest.spyOn(mockChannel, 'send');
    const tree = await renderScreen();
    const webview = tree.root.findByType('WebView' as never);

    await act(async () => {
      webview.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'vnc.data', data: 'hello_b64' }) } });
    });

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'vnc.data', data: 'hello_b64', channelId: mockTab.remoteSessionId
    }));
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
    await act(async () => { webview.props.onMessage({ nativeEvent: { data: 'not json' } }); });
    expect(tree.root.findByProps({ children: 'not json' })).toBeTruthy();
  });

  it('renders the shortcut dock and forwards key/Ctrl+Alt+Del presses via injectJavaScript', async () => {
    const tree = await renderScreen();
    expect(tree.root.findByProps({ testID: 'vnc-shortcut-dock' })).toBeTruthy();

    act(() => { tree.root.findByProps({ accessibilityLabel: 'Escape' }).props.onPress(); });
    expect(mockInjectJavaScript).toHaveBeenCalledWith('window.rfb?.sendKey(65307, "Escape");true;');

    act(() => { tree.root.findByProps({ accessibilityLabel: 'Tab' }).props.onPress(); });
    expect(mockInjectJavaScript).toHaveBeenCalledWith('window.rfb?.sendKey(65289, "Tab");true;');

    act(() => { tree.root.findByProps({ accessibilityLabel: 'Ctrl Alt Delete' }).props.onPress(); });
    expect(mockInjectJavaScript).toHaveBeenCalledWith('window.rfb?.sendCtrlAltDel();true;');
  });
});

describe('web (iframe) desktop', () => {
  beforeEach(() => { Object.defineProperty(Platform, 'OS', { value: 'web' }); });

  it('renders the local generated noVNC bundle with the embedded BridgeWebSocket', async () => {
    const tree = await renderScreen();
    const html = tree.root.findByType('iframe' as never).props.srcDoc as string;
    expect(html).toContain('/* novnc */');
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(html).toContain('class BridgeWebSocket');
    expect(html).toContain("this.protocol = '';");
    expect(html).toContain('Creating RFB…');
  });

  it('renders shortcut dock parity and posts key messages into the iframe window', async () => {
    const tree = await renderScreen();
    expect(tree.root.findByProps({ testID: 'vnc-shortcut-dock' })).toBeTruthy();

    act(() => { tree.root.findByProps({ accessibilityLabel: 'Escape' }).props.onPress(); });
    expect(mockIframePostMessage).toHaveBeenCalledWith({ type: 'key', keysym: 0xff1b, name: 'Escape' }, '*');

    act(() => { tree.root.findByProps({ accessibilityLabel: 'Ctrl Alt Delete' }).props.onPress(); });
    expect(mockIframePostMessage).toHaveBeenCalledWith({ type: 'ctrl-alt-delete' }, '*');
  });

  it('injects incoming channel vnc.data into the iframe postMessage', async () => {
    await renderScreen();
    await act(async () => {
      mockEmit({ channelId: mockTab.remoteSessionId, kind: 'desktop', type: 'vnc.data', data: 'xyz=' });
    });
    expect(mockIframePostMessage).toHaveBeenCalledWith({ type: 'vnc.data', data: 'xyz=' }, '*');
  });

  it('forwards vnc.data emitted by iframe back to the channel', async () => {
    const sendSpy = jest.spyOn(mockChannel, 'send');
    await renderScreen();
    
    await act(async () => {
      if (mockMessageListener) {
        mockMessageListener({ data: { type: 'vnc.data', data: 'hello_b64_web' } });
      }
    });

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'vnc.data', data: 'hello_b64_web', channelId: mockTab.remoteSessionId
    }));
  });
});
