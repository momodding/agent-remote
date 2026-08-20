import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import { getConnection, loadConnections, type Connection } from '../src/lib/connection';
import { base64, decodeBase64 } from '../src/lib/bytes';
import noVNCScript from '../src/generated/novnc_script';


// ponytail: one shared VNC control menu (Ctrl+Alt+Del/Esc/Tab) rendered identically by both HTML builders.
const VNC_CONTROLS_STYLE = '#vnc-controls{position:fixed;top:10px;right:10px;display:flex;gap:6px;z-index:20}#vnc-controls button{background:rgba(20,20,20,.85);color:#d9faff;border:1px solid #333;border-radius:6px;padding:6px 10px;font-size:12px}';
const VNC_CONTROLS_HTML = '<div id="vnc-controls"><button id="vnc-esc">Esc</button><button id="vnc-tab">Tab</button><button id="vnc-cad">Ctrl+Alt+Del</button></div>';
const VNC_CONTROLS_SCRIPT = `
    document.getElementById('vnc-esc').addEventListener('click', () => rfb.sendKey(0xff1b, 'Escape'));
    document.getElementById('vnc-tab').addEventListener('click', () => rfb.sendKey(0xff09, 'Tab'));
    document.getElementById('vnc-cad').addEventListener('click', () => rfb.sendCtrlAltDel());`;



/** HTML for native WebView — noVNC gets a fake channel bridged through postMessage. */
function buildBridgedDesktopHTML(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body,#screen{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;color:#d9faff;font-family:system-ui,sans-serif}
#status{position:fixed;inset:0;display:grid;place-items:center;padding:24px;text-align:center;background:#000}
#screen.connected+#status{display:none}
${VNC_CONTROLS_STYLE}
</style>
</head><body><div id="screen"></div><div id="status">Connecting to desktop…</div>
${VNC_CONTROLS_HTML}
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

// Fake WebSocket-like channel for noVNC; real transport and its lifecycle live on the React Native side.
const channel = {
  binaryType: 'arraybuffer',
  protocol: '',
  readyState: 1, // WebSocket.OPEN — React Native owns connect/close, so the channel is always "open" to noVNC
  onopen: null,
  _onmessage: null,
  onerror: null,
  onclose: null,
  _queue: [],
  send(data) {
    // data is Uint8Array from noVNC flush(); encode to base64 for postMessage
    let bin = '';
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'vnc', data: btoa(bin) }));
  },
  // no-op: React Native owns and closes the real WebSocket on route teardown; no second socket lifecycle here.
  close() {},
};

// Getter/setter for onmessage that enables frame flushing when receiver is ready
Object.defineProperty(channel, 'onmessage', {
  get() { return this._onmessage; },
  set(fn) {
    this._onmessage = fn;
    flush();
  }
});

function flush() {
  if (!channel._onmessage) return;
  setImmediate(() => {
    while (channel._queue.length) {
      channel._onmessage({ data: channel._queue.shift() });
    }
  });
}

// Receive binary frames and lifecycle notices from React Native
window.addEventListener('message', (event) => {
  try {
    const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    if (msg.type === 'vnc' && msg.data) {
      const raw = atob(msg.data);
      const buf = new ArrayBuffer(raw.length);
      const view = new Uint8Array(buf);
      for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
      if (channel._onmessage) {
        channel._queue.push(buf);
        flush();
      } else {
        channel._queue.push(buf);
      }
    } else if (msg.type === 'vnc-close') {
      if (channel.onclose) channel.onclose({ code: 1000, reason: '' });
    } else if (msg.type === 'vnc-error') {
      if (channel.onerror) channel.onerror(new Event('error'));
    }
  } catch {}
});

try {
  const rfb = new window.RFB(screen, channel);
  rfb.scaleViewport = true;
  rfb.resizeSession = true;
  rfb.addEventListener('connect', () => { screen.classList.add('connected'); report('Desktop connected'); });
  rfb.addEventListener('disconnect', (event) => report(event.detail?.clean ? 'Desktop disconnected' : 'Desktop disconnected unexpectedly'));
  rfb.addEventListener('securityfailure', () => report('Desktop security negotiation failed'));${VNC_CONTROLS_SCRIPT}
} catch (error) {
  report(error?.message || 'Could not load noVNC client');
}
</script></body></html>`;
}
export default function DesktopScreen() {
  const { connectionEndpoint } = useLocalSearchParams<{ connectionEndpoint: string }>();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [status, setStatus] = useState('Connecting to desktop…');
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
    const wsBase = connection.endpoint.replace(/^http/, 'ws').replace(/\/$/, '');
    const ws = new WebSocket(`${wsBase}/v1/ws/vnc?token=${encodeURIComponent(connection.token)}`);
    ws.binaryType = 'arraybuffer';
    socketRef.current = ws;
    ws.onmessage = (event) => {
      const data = base64(new Uint8Array(event.data as ArrayBuffer));
      webRef.current?.injectJavaScript(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify({ type: 'vnc', data }))}}));true;`);
    };
    ws.onclose = () => webRef.current?.injectJavaScript(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify({ type: 'vnc-close' }))}}));true;`);
    ws.onerror = () => webRef.current?.injectJavaScript(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify({ type: 'vnc-error' }))}}));true;`);
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
      {status !== 'Desktop connected' && <Text style={styles.status}>{status}</Text>}
    </SafeAreaView>
  );
}
export { VNC_CONTROLS_STYLE, VNC_CONTROLS_HTML, VNC_CONTROLS_SCRIPT };

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0A0A0A' },
  topbar: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12, borderBottomWidth: 1, borderColor: '#262626' },
  back: { padding: 6 },
  title: { color: '#F0F0F0', fontSize: 17, fontWeight: '700' },
  text: { color: '#888', textAlign: 'center', marginTop: 40 },
  webview: { flex: 1, backgroundColor: '#000' },
  status: { position: 'absolute', left: 16, right: 16, bottom: 18, color: '#D9FAFF', textAlign: 'center' },
});