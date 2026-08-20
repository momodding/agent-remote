// ponytail: web path uses standard ESM import and a direct WebSocket.
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import { getConnection, loadConnections, type Connection } from '../src/lib/connection';


export default function DesktopScreenWeb() {
  const { connectionEndpoint } = useLocalSearchParams<{ connectionEndpoint: string }>();
  const [connection, setConnection] = useState<Connection | null>(null);

  useEffect(() => {
    loadConnections().then((store) => setConnection(getConnection(store, connectionEndpoint) ?? null));
  }, [connectionEndpoint]);

  if (!connection) {
    return (
      <SafeAreaView style={styles.screen}>
        <Text style={styles.text}>Loading...</Text>
      </SafeAreaView>
    );
  }

  const wsBase = connection.endpoint.replace(/^http/, 'ws').replace(/\/$/, '');
  const wsURL = `${wsBase}/v1/ws/vnc?token=${encodeURIComponent(connection.token)}`;
  const webHTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body,#screen{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;color:#d9faff;font-family:system-ui,sans-serif}
#status{position:fixed;inset:0;display:grid;place-items:center;padding:24px;text-align:center;background:#000}
</style>
<script type="module">
import RFB from 'https://cdn.jsdelivr.net/npm/@novnc/novnc@1.5.0/lib/rfb.min.js';
const screen = document.getElementById('screen');
const status = document.getElementById('status');
const wsURL = ${JSON.stringify(wsURL)};
const report = (message) => status.textContent = message;

window.addEventListener('error', (event) => report(event.message || 'Desktop view failed'));
window.addEventListener('unhandledrejection', (event) => report(event.reason?.message || String(event.reason || 'Desktop view failed')));
try {
  const rfb = new RFB(screen, wsURL);
  rfb.scaleViewport = true;
  rfb.resizeSession = true;
  rfb.addEventListener('connect', () => { screen.classList.add('connected'); report('Desktop connected'); });
  rfb.addEventListener('disconnect', (event) => report(event.detail?.clean ? 'Desktop disconnected' : 'Desktop disconnected unexpectedly'));
} catch (error) {
  report(error?.message || 'Could not load noVNC client');
}
</script></body></html>`;
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.topbar}>
        <Pressable accessibilityLabel="Back" style={styles.back} onPress={() => router.back()}>
          <Feather name="arrow-left" size={20} color="#F0F0F0" />
        </Pressable>
        <Text style={styles.title}>Remote Desktop</Text>
      </View>
      <iframe srcDoc={webHTML} style={{ flex: 1, border: 'none', width: '100%', height: '100%' }} />
    </SafeAreaView>
  );
}


const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0A0A0A' },
  topbar: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12, borderBottomWidth: 1, borderColor: '#262626' },
  back: { padding: 6 },
  title: { color: '#F0F0F0', fontSize: 17, fontWeight: '700' },
  text: { color: '#888', textAlign: 'center', marginTop: 40 },
});