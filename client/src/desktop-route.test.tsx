jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => '550e8400-e29b-41d4-a716-446655440001'),
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
import { desktopDisconnectStatus } from './desktop-diagnostics';

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

describe('desktop close category diagnostics', () => {
  it('maps bounded server categories and preserves the uncategorized fallback', () => {
    expect(desktopDisconnectStatus(false, true, 'target_dial_failed')).toEqual({ message: 'Could not reach the remote desktop server.', stage: 'target_dial_failed' });
    expect(desktopDisconnectStatus(false, true, 'ticket_expired')).toEqual({ message: 'Your desktop session authorization expired — reconnect.', stage: 'ticket_expired' });
    expect(desktopDisconnectStatus(false, false, '')).toEqual({ message: 'The remote desktop never finished starting.', stage: 'framebuffer_never_initialized' });
    expect(desktopDisconnectStatus(false, true, 'unrecognized')).toEqual({ message: 'Desktop disconnected unexpectedly', stage: 'rfb_disconnected_unexpected' });
  });
});

describe('native (WebView) desktop', () => {
  it('acquires a desktop session ticket and configures RFB with the ticket wsUrl', async () => {
    const tree = await renderScreen();
    const html = tree.root.findByType('WebView' as never).props.source.html as string;
    expect(html).toContain('new window.RFB(screen, "wss://daemon.test:8765/v1/ws/rfb?ticket=test-ticket-123")');
    expect(html).not.toContain('BridgeWebSocket');
    expect(html).not.toContain('ws://bridge');
    expect(html).toContain('/* novnc */');
  });

  it('propagates one opaque UUID through the session request and noVNC diagnostic messages without exposing the ticket', async () => {
    const tree = await renderScreen();
    expect(AgenticRemoteAPI.prototype.createDesktopSession).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440001');
    const html = tree.root.findByType('WebView' as never).props.source.html as string;
    expect(html).toContain('type: \'diagnostic\', attemptID: "550e8400-e29b-41d4-a716-446655440001", stage');
    expect(html).toContain("stage: 'rfb_initialized'");
    expect(html).not.toContain('test-ticket-123", stage');
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
      webview.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'status', message: 'Desktop disconnected unexpectedly', attemptID: '550e8400-e29b-41d4-a716-446655440001', stage: 'rfb_disconnected_unexpected' }) } });
    });
    expect(tree.root.findByProps({ children: 'Desktop disconnected unexpectedly' })).toBeTruthy();
    expect(tree.root.findByProps({ children: 'The remote-desktop connection ended unexpectedly. Retry to request a fresh connection.' })).toBeTruthy();

    await act(async () => {
      webview.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'status', message: 'Desktop connected', attemptID: '550e8400-e29b-41d4-a716-446655440001', stage: 'rfb_connected' }) } });
    });
    expect(tree.root.findAllByProps({ children: 'Desktop connected' })).toHaveLength(0);
  });

  it('rejects raw or diagnostic WebView messages instead of displaying untrusted transport data', async () => {
    const tree = await renderScreen();
    const webview = tree.root.findByType('WebView' as never);
    await act(async () => {
      webview.props.onMessage({ nativeEvent: { data: 'ticket=secret frame=abcdef' } });
    });
    expect(tree.root.findByProps({ children: 'Desktop view failed' })).toBeTruthy();
    await act(async () => {
      webview.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'diagnostic', attemptID: '550e8400-e29b-41d4-a716-446655440001', stage: 'rfb_connected' }) } });
    });
    expect(tree.root.findByProps({ children: 'Desktop view failed' })).toBeTruthy();
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

  it('offers a sanitized recovery path when createDesktopSession fails', async () => {
    jest.spyOn(AgenticRemoteAPI.prototype, 'createDesktopSession').mockRejectedValue(new Error('VNC unavailable'));
    const tree = await renderScreen();
    expect(tree.root.findByProps({ children: 'Could not create desktop session' })).toBeTruthy();
    expect(tree.root.findByProps({ accessibilityLabel: 'Back' })).toBeTruthy();
    await act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'Retry Desktop' }).props.onPress();
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    expect(AgenticRemoteAPI.prototype.createDesktopSession).toHaveBeenCalledTimes(2);
  });

  it('keeps Back and remote keys at the Android 48dp touch-target floor', async () => {
    const tree = await renderScreen();
    expect(tree.root.findByProps({ accessibilityLabel: 'Back' }).props.style).toMatchObject({ minWidth: 48, minHeight: 48 });
    for (const label of ['Escape', 'Tab', 'Ctrl Alt Delete']) {
      expect(tree.root.findByProps({ accessibilityLabel: label }).props.style).toMatchObject({ minWidth: 48, minHeight: 48 });
    }
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
    expect(AgenticRemoteAPI.prototype.createDesktopSession).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440001');
    expect(html).toContain('type: \'diagnostic\', attemptID: "550e8400-e29b-41d4-a716-446655440001", stage');
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

  it('displays a sanitized session failure on web', async () => {
    jest.spyOn(AgenticRemoteAPI.prototype, 'createDesktopSession').mockRejectedValue(new Error('VNC unavailable token=test-ticket-123'));
    const tree = await renderScreen();
    expect(tree.root.findByProps({ children: 'Could not create desktop session' })).toBeTruthy();
  });

  it('shows a safe outer failure and creates a fresh desktop session on retry', async () => {
    jest.spyOn(require('expo-crypto'), 'randomUUID')
      .mockReturnValueOnce('550e8400-e29b-41d4-a716-446655440001')
      .mockReturnValueOnce('550e8400-e29b-41d4-a716-446655440002');
    let onMessage: ((event: MessageEvent) => void) | undefined;
    Object.assign(window, {
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
        onMessage = listener;
      },
      removeEventListener: jest.fn(),
    });
    const tree = await renderScreen();

    await act(async () => {
      onMessage?.({
        data: {
          type: 'status',
          message: 'Could not reach the remote desktop server.',
          attemptID: '550e8400-e29b-41d4-a716-446655440001',
          stage: 'target_dial_failed',
        },
      } as MessageEvent);
    });

    expect(tree.root.findAllByProps({ children: 'Could not reach the remote desktop server.' })).not.toHaveLength(0);
    expect(tree.root.findByProps({ accessibilityLabel: 'Retry desktop connection' })).toBeTruthy();
    expect(tree.toJSON()).not.toContain('test-ticket-123');

    await act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'Retry desktop connection' }).props.onPress();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(AgenticRemoteAPI.prototype.createDesktopSession).toHaveBeenCalledTimes(2);
    expect(AgenticRemoteAPI.prototype.createDesktopSession).toHaveBeenLastCalledWith('550e8400-e29b-41d4-a716-446655440002');
  });
});
