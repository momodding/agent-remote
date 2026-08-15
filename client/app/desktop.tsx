import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
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
</head><body><div id="screen"></div><div id="status">Connecting to desktop…</div>
<script>${noVNCScript}</script>
<script>
const screen = document.getElementById('screen');
const status = document.getElementById('status');
const wsURL = ${JSON.stringify(wsURL)};
const report = (message) => {
  status.textContent = message;
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'status', message }));
};
window.addEventListener('error', (event) => report(event.message || 'Desktop view failed'));
window.addEventListener('unhandledrejection', (event) => report(event.reason?.message || String(event.reason || 'Desktop view failed')));
try {
    const rfb = new window.RFB(screen, wsURL);
    rfb.scaleViewport = true;
    rfb.resizeSession = true;
    rfb.addEventListener('connect', () => { screen.classList.add('connected'); report('Desktop connected'); });
    rfb.addEventListener('disconnect', (event) => report(event.detail?.clean ? 'Desktop disconnected' : 'Desktop disconnected unexpectedly'));
    rfb.addEventListener('securityfailure', () => report('Desktop security negotiation failed'));
} catch (error) {
  report(error?.message || 'Could not load noVNC client');
}
</script></body></html>`;
}

export default function DesktopScreen() {
  const { connectionEndpoint } = useLocalSearchParams<{ connectionEndpoint: string }>();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [status, setStatus] = useState('Connecting to desktop…');

  useEffect(() => {
    loadConnections().then((store) => {
      setConnection(getConnection(store, connectionEndpoint) ?? null);
    });
  }, [connectionEndpoint]);

  const html = useMemo(() => {
    if (!connection) return '';
    const wsBase = connection.endpoint.replace(/^http/, 'ws').replace(/\/$/, '');
    return buildDesktopHTML(`${wsBase}/v1/ws/vnc?token=${encodeURIComponent(connection.token)}`);
  }, [connection]);
  const onMessage = ({ nativeEvent }: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(nativeEvent.data) as { type?: string; message?: string };
      if (message.type === 'status' && message.message) setStatus(message.message);
    } catch {
      setStatus(nativeEvent.data);
    }
  };

  if (!connection) return <SafeAreaView style={styles.screen}><Text style={styles.text}>Loading...</Text></SafeAreaView>;

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.topbar}>
        <Pressable accessibilityLabel="Back" style={styles.back} onPress={() => router.back()}>
          <Feather name="arrow-left" size={20} color="#F0F0F0" />
        </Pressable>
        <Text style={styles.title}>Remote Desktop</Text>
      </View>
      {Platform.OS === 'web' ? (
        <iframe srcDoc={html} style={{ flex: 1, border: 'none', width: '100%', height: '100%' }} />
      ) : (
        <WebView source={{ html, baseUrl: connection.endpoint }} originWhitelist={['*']} style={styles.webview}
          javaScriptEnabled domStorageEnabled mixedContentMode="always" onMessage={onMessage} onError={(event) => setStatus(event.nativeEvent.description)} onLoadSubResourceError={(event) => setStatus(event.nativeEvent.description)} />
      )}
      {Platform.OS !== 'web' && status !== 'Desktop connected' && <Text style={styles.status}>{status}</Text>}
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
});