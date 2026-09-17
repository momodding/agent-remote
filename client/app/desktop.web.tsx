// ponytail: web path uses the same generated noVNC bundle as native.
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import { getConnection, loadConnections, type Connection } from '../src/lib/connection';
import { useTabStore } from '../src/lib/tabs/tab-store';
import { AgenticRemoteAPI } from '../src/lib/api';
import type { DesktopWorkspaceTab } from '../src/lib/tabs/types';
import noVNCScript from '../src/generated/novnc_script';

function buildDesktopHTML(wsUrl: string): string {
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
  window.parent.postMessage({ type: 'status', message }, '*');
};
window.addEventListener('error', () => report('Desktop view failed'));
window.addEventListener('unhandledrejection', () => report('Desktop view failed'));

window.addEventListener('message', (event) => {
  if (event.data?.type === 'key') window.rfb?.sendKey(event.data.keysym, event.data.name);
  else if (event.data?.type === 'ctrl-alt-delete') window.rfb?.sendCtrlAltDel();
  else if (event.data?.type === 'status-override') report(event.data.message);
});

try {
  report('Creating RFB…');
  const rfb = window.rfb = new window.RFB(screen, ${JSON.stringify(wsUrl)});
  rfb.scaleViewport = true;
  rfb.resizeSession = true;
  rfb.addEventListener('connect', () => { screen.classList.add('connected'); report('Desktop connected'); });
  rfb.addEventListener('disconnect', (event) => report(event.detail?.clean ? 'Desktop disconnected' : 'Desktop disconnected unexpectedly'));
  rfb.addEventListener('securityfailure', () => report('Desktop security negotiation failed'));
  window.parent.postMessage({ type: 'status', message: 'RFB initialized' }, '*');
} catch (err) {
  report('Could not load noVNC client');
}
</script></body></html>`;
}

export default function DesktopScreenWeb() {
  const { tabId } = useLocalSearchParams<{ tabId: string }>();
  const { state } = useTabStore();
  const tab = state.tabs.find((t): t is DesktopWorkspaceTab => t.tabId === tabId && t.kind === 'desktop') ?? null;
  const [connection, setConnection] = useState<Connection | null>(null);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading noVNC…');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!tab) return;
    let active = true;
    loadConnections().then(async (store) => {
      const conn = getConnection(store, tab.daemonId);
      if (!conn || !active) return;
      setConnection(conn);
      try {
        const api = new AgenticRemoteAPI(conn);
        const session = await api.createDesktopSession();
        if (active) {
          setWsUrl(session.wsUrl);
        }
      } catch (err) {
        if (active) {
          setStatus(err instanceof Error ? err.message : 'Failed to create desktop session');
        }
      }
    });
    return () => {
      active = false;
    };
  }, [tab?.tabId]);

  const html = useMemo(() => (wsUrl ? buildDesktopHTML(wsUrl) : ''), [wsUrl]);

  const send = (message: object) => iframeRef.current?.contentWindow?.postMessage(message, '*');

  if (!connection || !tab || !wsUrl) {
    return (
      <SafeAreaView style={styles.screen}>
        <Text style={styles.text}>{status}</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.topbar}>
        <Pressable accessibilityLabel="Back" style={styles.back} onPress={() => router.back()}>
          <Feather name="arrow-left" size={20} color="#F0F0F0" />
        </Pressable>
        <Text style={styles.title}>{tab.title || 'Remote Desktop'}</Text>
      </View>
      <iframe ref={iframeRef} title="Remote Desktop" srcDoc={html} style={{ flex: 1, border: 'none', width: '100%', height: '100%' }} />
      <View testID="vnc-shortcut-dock" style={styles.dock}>
        <Pressable accessibilityLabel="Escape" style={styles.key} onPress={() => send({ type: 'key', keysym: 0xff1b, name: 'Escape' })}><Text style={styles.keyText}>Esc</Text></Pressable>
        <Pressable accessibilityLabel="Tab" style={styles.key} onPress={() => send({ type: 'key', keysym: 0xff09, name: 'Tab' })}><Text style={styles.keyText}>Tab</Text></Pressable>
        <Pressable accessibilityLabel="Ctrl Alt Delete" style={styles.key} onPress={() => send({ type: 'ctrl-alt-delete' })}><Text style={styles.keyText}>Ctrl+Alt+Del</Text></Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0A0A0A' },
  topbar: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12, borderBottomWidth: 1, borderColor: '#262626' },
  back: { padding: 6 },
  title: { color: '#F0F0F0', fontSize: 16, fontWeight: '600', flex: 1 },
  dock: { flexDirection: 'row', justifyContent: 'center', gap: 10, padding: 8, backgroundColor: '#141414', borderTopWidth: 1, borderColor: '#262626' },
  key: { paddingVertical: 8, paddingHorizontal: 14, backgroundColor: '#222', borderRadius: 6 },
  keyText: { color: '#E0E0E0', fontSize: 13, fontWeight: '600' },
  text: { color: '#888', textAlign: 'center', marginTop: 40 },
});
