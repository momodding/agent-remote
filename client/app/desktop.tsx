import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { WebView } from 'react-native-webview';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import { getConnection, loadConnections, type Connection } from '../src/lib/connection';

function buildDesktopHTML(wsURL: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body,#screen{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000}</style>
</head><body><div id="screen"></div>
<script type="module">
import RFB from 'https://unpkg.com/@novnc/novnc@1.5.0/core/rfb.js';
const rfb = new RFB(document.getElementById('screen'), '${wsURL}');
rfb.scaleViewport = true;
rfb.resizeSession = true;
</script></body></html>`;
}

export default function DesktopScreen() {
  const { connectionEndpoint } = useLocalSearchParams<{ connectionEndpoint: string }>();
  const [connection, setConnection] = useState<Connection | null>(null);

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
        <WebView source={{ html }} originWhitelist={['*']} style={styles.webview}
          javaScriptEnabled mixedContentMode="always" />
      )}
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
});