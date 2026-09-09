// ponytail: web path uses the same generated noVNC bundle as native.
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import { getConnection, loadConnections, type Connection } from '../src/lib/connection';
import { useTabStore } from '../src/lib/tabs/tab-store';
import { createDaemonChannel, type DaemonChannel } from '../src/lib/daemon-channel';
import type { DesktopWorkspaceTab } from '../src/lib/tabs/types';
import noVNCScript from '../src/generated/novnc_script';

function buildDesktopHTML(): string {
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
  else if (event.data?.type === 'vnc.data') {
    if (window.__rfb_ws && window.__rfb_ws.onmessage) {
      window.__rfb_ws.onmessage({ data: base64ToU8(event.data.data).buffer });
    }
  }
});

function base64ToU8(b64) {
  const binary_string = window.atob(b64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
      bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes;
}
function u8ToBase64(u8) {
  let binary = '';
  const len = u8.byteLength;
  for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(u8[i]);
  }
  return window.btoa(binary);
}

class BridgeWebSocket {
  constructor(url) {
    this.readyState = 0;
    this.binaryType = 'arraybuffer';
    this.protocol = '';
    setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    }, 0);
    window.__rfb_ws = this;
  }
  send(data) {
    const u8 = new Uint8Array(data);
    const b64 = u8ToBase64(u8);
    window.parent.postMessage({ type: 'vnc.data', data: b64 }, '*');
  }
  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose({});
  }
}
window.WebSocket = BridgeWebSocket;

try {
  report('Creating RFB…');
  const rfb = window.rfb = new window.RFB(screen, "ws://bridge");
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
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const channelRef = useRef<DaemonChannel | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const html = useMemo(() => buildDesktopHTML(), []);

  useEffect(() => {
    if (!tab) return;
    loadConnections().then((store) => {
      const conn = getConnection(store, tab.daemonId);
      if (conn) {
        setConnection(conn);
        channelRef.current = createDaemonChannel(conn);
        unsubscribeRef.current = channelRef.current.subscribe(tab.remoteSessionId, (msg) => {
          if (msg.type === 'vnc.data' && iframeRef.current?.contentWindow) {
            iframeRef.current.contentWindow.postMessage({ type: 'vnc.data', data: msg.data }, '*');
          } else if (msg.type === 'error') {
            send({ type: 'status-override', message: msg.message });
          }
        });
      }
    });
    return () => unsubscribeRef.current?.();
  }, [tab?.tabId]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (!tab || !channelRef.current || !event.data) return;
      if (event.data.type === 'vnc.data') {
        channelRef.current.send({ channelId: tab.remoteSessionId, kind: 'desktop', type: 'vnc.data', data: event.data.data });
      }
    };
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('message', handler);
      return () => window.removeEventListener('message', handler);
    }
  }, [tab?.tabId]);

  const send = (message: object) => iframeRef.current?.contentWindow?.postMessage(message, '*');

  if (!connection || !tab) {
    return (
      <SafeAreaView style={styles.screen}>
        <Text style={styles.text}>Loading...</Text>
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
  title: { color: '#F0F0F0', fontSize: 17, fontWeight: '700' },
  text: { color: '#888', textAlign: 'center', marginTop: 40 },
  dock: { flexDirection: 'row', justifyContent: 'center', gap: 8, padding: 8, backgroundColor: '#181818', borderTopWidth: 1, borderColor: '#262626' },
  key: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 6, backgroundColor: '#333' },
  keyText: { color: '#F0F0F0', fontSize: 13, fontWeight: '600' },
});
