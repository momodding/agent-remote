// ponytail: web path uses the same generated noVNC bundle as native.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { StyleSheet, Text, View, Pressable } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import { getConnection, loadConnections, type Connection } from '../src/lib/connection';
import { useTabStore } from '../src/lib/tabs/tab-store';
import { AgenticRemoteAPI } from '../src/lib/api';
import type { DesktopWorkspaceTab } from '../src/lib/tabs/types';
import noVNCScript from '../src/generated/novnc_script';
import { desktopCloseMessages, desktopStageDetail } from '../src/desktop-diagnostics';

function buildDesktopHTML(wsUrl: string, attemptID: string): string {
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
const report = (message, stage) => {
  status.textContent = message;
  window.parent.postMessage({ type: 'status', message, attemptID: ${JSON.stringify(attemptID)}, stage }, '*');
  window.parent.postMessage({ type: 'diagnostic', attemptID: ${JSON.stringify(attemptID)}, stage }, '*');
};
window.addEventListener('error', () => report('Desktop view failed', 'window_error'));
window.addEventListener('unhandledrejection', () => report('Desktop view failed', 'unhandled_rejection'));

window.addEventListener('message', (event) => {
  if (event.data?.type === 'key') window.rfb?.sendKey(event.data.keysym, event.data.name);
  else if (event.data?.type === 'ctrl-alt-delete') window.rfb?.sendCtrlAltDel();
  else if (event.data?.type === 'status-override') report(event.data.message);
});

try {
  report('Creating RFB…', 'rfb_creating');
  let connected = false;
  let closeReason = '';
  let securityFailed = false;
  const rfb = window.rfb = new window.RFB(screen, ${JSON.stringify(wsUrl)});
  const rawWebSocket = rfb._sock?._websocket;
  if (rawWebSocket) {
    const onclose = rawWebSocket.onclose;
    rawWebSocket.onclose = (event) => { closeReason = event.reason; onclose.call(rawWebSocket, event); };
  }
  rfb.scaleViewport = true;
  rfb.resizeSession = true;
  rfb.addEventListener('connect', () => { connected = true; screen.classList.add('connected'); report('Desktop connected', 'rfb_connected'); });
  rfb.addEventListener('disconnect', (event) => {
    const clean = event.detail?.clean === true;
    const category = !clean && securityFailed ? 'security_negotiation_failed' : !clean && Object.prototype.hasOwnProperty.call(${JSON.stringify(desktopCloseMessages)}, closeReason) ? closeReason : !clean && !connected ? 'framebuffer_never_initialized' : '';
    report(clean ? 'Desktop disconnected' : category ? ${JSON.stringify(desktopCloseMessages)}[category] : 'Desktop disconnected unexpectedly', clean ? 'rfb_disconnected_clean' : category || 'rfb_disconnected_unexpected');
  });
  rfb.addEventListener('securityfailure', () => { securityFailed = true; report(${JSON.stringify(desktopCloseMessages.security_negotiation_failed)}, 'security_negotiation_failed'); });
  window.parent.postMessage({ type: 'diagnostic', attemptID: ${JSON.stringify(attemptID)}, stage: 'rfb_initialized' }, '*');
} catch {
  report('Could not load noVNC client', 'rfb_load_failed');
}
</script></body></html>`;
}

const terminalDesktopStages: Record<string, true> = {
  target_dial_failed: true,
  target_closed: true,
  websocket_closed: true,
  ticket_invalid: true,
  ticket_expired: true,
  protocol_failure: true,
  security_negotiation_failed: true,
  framebuffer_never_initialized: true,
  rfb_disconnected_clean: true,
  rfb_disconnected_unexpected: true,
  rfb_load_failed: true,
  client_closed: true,
};

export default function DesktopScreenWeb() {
  const { tabId } = useLocalSearchParams<{ tabId: string }>();
  const { state } = useTabStore();
  const tab = state.tabs.find((t): t is DesktopWorkspaceTab => t.tabId === tabId && t.kind === 'desktop') ?? null;
  const [connection, setConnection] = useState<Connection | null>(null);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading noVNC…');
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attemptID, setAttemptID] = useState(() => Crypto.randomUUID());
  const [retryNonce, setRetryNonce] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!tab) return;
    setFailed(false);
    setWsUrl(null);
    setStatus('Loading noVNC…');
    setStatusDetail(null);
    let active = true;
    loadConnections().then(async (store) => {
      const conn = getConnection(store, tab.daemonId);
      if (!conn || !active) return;
      setConnection(conn);
      try {
        const api = new AgenticRemoteAPI(conn);
        const session = await api.createDesktopSession(attemptID);
        if (active) {
          setWsUrl(session.wsUrl);
        }
      } catch {
        if (active) {
          setStatus('Could not create desktop session');
          setFailed(true);
        }
      }
    });
    return () => {
      active = false;
    };
  }, [attemptID, retryNonce, tab?.tabId]);
  useEffect(() => {
    if (typeof window.addEventListener !== 'function') return;
    const handler = (event: MessageEvent) => {
      const d = event.data;
      if (d?.type !== 'status' || typeof d.message !== 'string' || d.attemptID !== attemptID) return;
      setStatus(d.message);
      const detail = desktopStageDetail(d.stage);
      if (detail !== undefined) setStatusDetail(detail);
      if (terminalDesktopStages[d.stage]) setFailed(true);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [attemptID]);

  const html = useMemo(() => (wsUrl ? buildDesktopHTML(wsUrl, attemptID) : ''), [wsUrl, attemptID]);

  const send = (message: object) => iframeRef.current?.contentWindow?.postMessage(message, '*');


  if (!connection || !tab || !wsUrl || failed) {
    return (
      <SafeAreaView style={styles.screen}>
        <Text style={styles.text}>{status}</Text>
        {statusDetail ? <Text style={styles.detail}>{statusDetail}</Text> : null}
        {failed ? (
          <Pressable
            accessibilityLabel="Retry desktop connection"
            style={styles.retry}
            onPress={() => {
              setAttemptID(Crypto.randomUUID());
              setRetryNonce((nonce) => nonce + 1);
            }}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        ) : null}
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
  detail: { color: '#666', textAlign: 'center', marginTop: 8, fontSize: 13, paddingHorizontal: 24 },
  retry: { alignSelf: 'center', marginTop: 20, paddingVertical: 10, paddingHorizontal: 18, backgroundColor: '#2D6CDF', borderRadius: 6 },
  retryText: { color: '#FFF', fontSize: 14, fontWeight: '600' },
});
