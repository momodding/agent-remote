import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import { getConnection, loadConnections, type Connection } from '../src/lib/connection';
import noVNCScript from '../src/generated/novnc_script';

function buildDesktopHTML(wsURL: string): string {
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
window.addEventListener('error', () => report('Desktop view failed'));
window.addEventListener('unhandledrejection', () => report('Desktop view failed'));
const wsURL = ${JSON.stringify(wsURL)};
try {
  report('Creating RFB…');
  const rfb = window.rfb = new window.RFB(screen, wsURL);
  rfb.scaleViewport = true;
  rfb.resizeSession = true;
  rfb.addEventListener('connect', () => { screen.classList.add('connected'); report('Desktop connected'); });
  rfb.addEventListener('disconnect', (event) => report(event.detail?.clean ? 'Desktop disconnected' : 'Desktop disconnected unexpectedly'));
  rfb.addEventListener('securityfailure', () => report('Desktop security negotiation failed'));
  report('Connecting WebSocket…');
} catch {
  report('Could not load noVNC client');
}
</script></body></html>`;
}

export default function DesktopScreen() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [status, setStatus] = useState('Loading noVNC…');
  const webRef = useRef<WebView>(null);

  useEffect(() => {
    void loadConnections().then((store) => setConnection(getConnection(store, hostId) ?? null));
  }, [hostId]);

  const html = useMemo(() => {
    if (!connection) return '';
    const wsBase = connection.endpoint.replace(/^http/, 'ws').replace(/\/$/, '');
    return buildDesktopHTML(`${wsBase}/v1/ws/vnc?token=${encodeURIComponent(connection.token)}`);
  }, [connection]);

  const onMessage = useCallback(({ nativeEvent }: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(nativeEvent.data) as { type?: string; message?: string };
      if (message.type === 'status' && message.message) setStatus(message.message);
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
      <WebView ref={webRef} source={{ html, baseUrl: connection.endpoint }} originWhitelist={['*']} style={styles.webview}
        javaScriptEnabled domStorageEnabled mixedContentMode="always" onMessage={onMessage}
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
