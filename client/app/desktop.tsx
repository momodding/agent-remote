import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import { getConnection, loadConnections, type Connection } from '../src/lib/connection';
import { base64, decodeBase64 } from '../src/lib/bytes';
import noVNCScript from '../src/generated/novnc_script';





/** HTML for native WebView — noVNC gets a WebSocket-like channel bridged through postMessage. */
function buildBridgedDesktopHTML(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body,#screen{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;color:#d9faff;font-family:system-ui,sans-serif}
#status{position:fixed;inset:0;display:grid;place-items:center;padding:24px;text-align:center;background:#000}
#screen.connected+#status{display:none}
</style>
</head><body><div id="screen"></div><div id="status">Loading noVNC…</div>
<script>${noVNCScript}</script>
<script>
const screen = document.getElementById('screen');
const status = document.getElementById('status');
const report = (message) => {
  status.textContent = message;
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'status', message }));
};
window.addEventListener('error', (event) => report(event.message || 'Desktop view failed'));
window.addEventListener('unhandledrejection', (event) => report(event.reason?.message || String(event.reason || 'Desktop view failed')));

const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const scheduleMicrotask = typeof queueMicrotask === 'function'
  ? queueMicrotask
  : (callback) => Promise.resolve().then(callback);
let flushScheduled = false;
let queuedBytes = 0;

// WebSocket-compatible raw channel required by @novnc/novnc/lib/websock.js.
const channel = {
  binaryType: 'arraybuffer',
  protocol: '',
  readyState: 0,
  onopen: null,
  _onmessage: null,
  onerror: null,
  onclose: null,
  _queue: [],
  send(data) {
    if (this.readyState !== 1) throw new Error('VNC transport is not open');
    let raw = '';
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'vnc', data: btoa(raw) }));
  },
  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'vnc-close' }));
  },
};

Object.defineProperty(channel, 'onmessage', {
  enumerable: true,
  get() { return this._onmessage; },
  set(fn) {
    this._onmessage = fn;
    flush();
  }
});

function flush() {
  if (!channel._onmessage || !channel._queue.length || flushScheduled) return;
  flushScheduled = true;
  scheduleMicrotask(() => {
    flushScheduled = false;
    const onmessage = channel._onmessage;
    while (onmessage && channel._queue.length) {
      const data = channel._queue.shift();
      queuedBytes -= data.byteLength;
      onmessage({ data });
    }
    flush();
  });
}

window.addEventListener('message', (event) => {
  try {
    const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    if (msg.type === 'vnc-open') {
      if (channel.readyState !== 0) return;
      channel.readyState = 1;
      channel.onopen?.();
    } else if (msg.type === 'vnc' && msg.data) {
      const raw = atob(msg.data);
      const buf = new ArrayBuffer(raw.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
      if (queuedBytes + buf.byteLength > MAX_QUEUED_BYTES) throw new Error('VNC receive queue exceeded 16 MiB');
      channel._queue.push(buf);
      queuedBytes += buf.byteLength;
      flush();
    } else if (msg.type === 'vnc-close') {
      channel.readyState = 3;
      channel.onclose?.({ code: msg.code || 1000, reason: '' });
    } else if (msg.type === 'vnc-error') {
      report('WebSocket connection failed');
      channel.onerror?.(new Event('error'));
    }
  } catch (error) {
    report(error?.message || 'VNC transport failed');
    channel.onerror?.(new Event('error'));
  }
});

try {
  report('Creating RFB…');
  const rfb = window.rfb = new window.RFB(screen, channel);
  rfb.scaleViewport = true;
  rfb.resizeSession = true;
  rfb.addEventListener('connect', () => { screen.classList.add('connected'); report('Desktop connected'); });
  rfb.addEventListener('disconnect', (event) => report(event.detail?.clean ? 'Desktop disconnected' : 'Desktop disconnected unexpectedly'));
  rfb.addEventListener('securityfailure', () => report('Desktop security negotiation failed'));
  report('Connecting WebSocket…');
} catch (error) {
  report(error?.message || 'Could not load noVNC client');
}
</script></body></html>`;
}
export default function DesktopScreen() {
  const { connectionEndpoint } = useLocalSearchParams<{ connectionEndpoint: string }>();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [status, setStatus] = useState('Loading noVNC…');
  const webRef = useRef<WebView>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    loadConnections().then((store) => setConnection(getConnection(store, connectionEndpoint) ?? null));
  }, [connectionEndpoint]);

  useEffect(() => () => {
    if (socketRef.current && socketRef.current.readyState <= WebSocket.OPEN) {
      socketRef.current.close(1000, 'desktop route closed');
    }
  }, []);

  const bridgedHTML = useMemo(() => connection ? buildBridgedDesktopHTML() : '', [connection]);

  const connectSocket = useCallback(() => {
    if (!connection) return;
    const current = socketRef.current;
    if (current && current.readyState <= WebSocket.OPEN) current.close(1000, 'desktop view reloaded');
    const wsBase = connection.endpoint.replace(/^http/, 'ws').replace(/\/$/, '');
    const ws = new WebSocket(`${wsBase}/v1/ws/vnc?token=${encodeURIComponent(connection.token)}`);
    ws.binaryType = 'arraybuffer';
    socketRef.current = ws;
    ws.onopen = () => {
      if (socketRef.current !== ws) return;
      webRef.current?.injectJavaScript(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify({ type: 'vnc-open' }))}}));true;`);
    };
    ws.onmessage = (event) => {
      if (socketRef.current !== ws) return;
      const data = base64(new Uint8Array(event.data as ArrayBuffer));
      webRef.current?.injectJavaScript(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify({ type: 'vnc', data }))}}));true;`);
    };
    ws.onclose = (event) => {
      if (socketRef.current !== ws) return;
      socketRef.current = null;
      webRef.current?.injectJavaScript(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify({ type: 'vnc-close', code: event.code }))}}));true;`);
    };
    ws.onerror = () => {
      if (socketRef.current !== ws) return;
      webRef.current?.injectJavaScript(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify({ type: 'vnc-error' }))}}));true;`);
    };
  }, [connection]);

  const onMessage = useCallback(({ nativeEvent }: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(nativeEvent.data) as { type?: string; message?: string; data?: string };
      if (message.type === 'status' && message.message) setStatus(message.message);
      else if (message.type === 'vnc' && message.data && socketRef.current && socketRef.current.readyState === WebSocket.OPEN) socketRef.current.send(decodeBase64(message.data));
      else if (message.type === 'vnc-close' && socketRef.current && socketRef.current.readyState <= WebSocket.OPEN) socketRef.current.close(1000, 'desktop route closed');
    } catch {
      setStatus(nativeEvent.data);
    }
  }, []);

  const sendKey = (keysym: number, name: string) => webRef.current?.injectJavaScript(`window.rfb?.sendKey(${keysym}, ${JSON.stringify(name)});true;`);

  if (!connection) return <SafeAreaView style={styles.screen}><Text style={styles.text}>Loading...</Text></SafeAreaView>;
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.topbar}>
        <Pressable accessibilityLabel="Back" style={styles.back} onPress={() => router.back()}>
          <Feather name="arrow-left" size={20} color="#F0F0F0" />
        </Pressable>
        <Text style={styles.title}>Remote Desktop</Text>
      </View>
      <WebView ref={webRef} source={{ html: bridgedHTML, baseUrl: connection.endpoint }} originWhitelist={['*']} style={styles.webview}
        javaScriptEnabled domStorageEnabled mixedContentMode="always" onMessage={onMessage} onLoadEnd={connectSocket}
        onError={(event) => setStatus(event.nativeEvent.description)} />
      <View testID="vnc-shortcut-dock" style={styles.dock}>
        <Pressable accessibilityLabel="Escape" style={styles.key} onPress={() => sendKey(0xff1b, 'Escape')}><Text style={styles.keyText}>Esc</Text></Pressable>
        <Pressable accessibilityLabel="Tab" style={styles.key} onPress={() => sendKey(0xff09, 'Tab')}><Text style={styles.keyText}>Tab</Text></Pressable>
        <Pressable accessibilityLabel="Ctrl Alt Delete" style={styles.key} onPress={() => webRef.current?.injectJavaScript('window.rfb?.sendCtrlAltDel();true;')}><Text style={styles.keyText}>Ctrl+Alt+Del</Text></Pressable>
      </View>
      {status !== 'Desktop connected' && <Text style={styles.status}>{status}</Text>}
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0A0A0A' },
  topbar: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12, borderBottomWidth: 1, borderColor: '#262626' },
  back: { padding: 6 },
  title: { color: '#F0F0F0', fontSize: 17, fontWeight: '700' },
  text: { color: '#888', textAlign: 'center', marginTop: 40 },
  webview: { flex: 1, backgroundColor: '#000' },
  status: { position: 'absolute', left: 16, right: 16, bottom: 18, color: '#D9FAFF', textAlign: 'center' },
  dock: { flexDirection: 'row', justifyContent: 'center', gap: 8, padding: 8, backgroundColor: '#181818', borderTopWidth: 1, borderColor: '#262626' },
  key: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 6, backgroundColor: '#333' },
  keyText: { color: '#F0F0F0', fontSize: 13, fontWeight: '600' },
});