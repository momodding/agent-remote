import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
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
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'status', message, attemptID: ${JSON.stringify(attemptID)}, stage }));
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'diagnostic', attemptID: ${JSON.stringify(attemptID)}, stage }));
};
window.addEventListener('error', () => report('Desktop view failed', 'window_error'));
window.addEventListener('unhandledrejection', () => report('Desktop view failed', 'unhandled_rejection'));

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
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'diagnostic', attemptID: ${JSON.stringify(attemptID)}, stage: 'rfb_initialized' }));
} catch {
  report('Could not load noVNC client', 'rfb_load_failed');
}
</script></body></html>`;
}

export default function DesktopScreen() {
  const { tabId } = useLocalSearchParams<{ tabId: string }>();
  const { state } = useTabStore();
  const tab = state.tabs.find((t): t is DesktopWorkspaceTab => t.tabId === tabId && t.kind === 'desktop') ?? null;
  const [connection, setConnection] = useState<Connection | null>(null);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [status, setStatus] = useState('Loading noVNC…');
	const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const attemptIDRef = useRef(Crypto.randomUUID());
  const webRef = useRef<WebView>(null);

  useEffect(() => {
    if (!tab) return;
    let active = true;
    attemptIDRef.current = Crypto.randomUUID();
    const attemptID = attemptIDRef.current;
    setWsUrl(null);
	    setStatusDetail(null);
    loadConnections().then(async (store) => {
      const conn = getConnection(store, tab.daemonId);
      if (!conn || !active) {
        if (active) setStatus('Desktop connection unavailable');
        return;
      }
      setConnection(conn);
      try {
        const api = new AgenticRemoteAPI(conn);
        const session = await api.createDesktopSession(attemptID);
        if (active) setWsUrl(session.wsUrl);
	      } catch {
	        if (active) {
	          setStatus('Could not create desktop session');
	          setStatusDetail(null);
	        }
	      }
    });
    return () => {
      active = false;
    };
  }, [tab?.tabId, retryNonce]);

  const html = useMemo(() => (wsUrl ? buildDesktopHTML(wsUrl, attemptIDRef.current) : ''), [wsUrl]);

  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'status' && typeof data.message === 'string' && data.attemptID === attemptIDRef.current) {
        const detail = desktopStageDetail(data.stage);
        if (detail !== undefined) {
          setStatus(data.message);
          setStatusDetail(detail);
        }
      }
    } catch {
      setStatus('Desktop view failed');
      setStatusDetail('The remote-desktop view could not process a status update. Retry the connection.');
    }
  };
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);
  const needsRecovery = !wsUrl || status === 'Desktop disconnected' || status === 'Desktop disconnected unexpectedly' || status === 'Desktop security negotiation failed' || status === 'Desktop view failed' || status === 'Could not load noVNC client' || Object.values(desktopCloseMessages).includes(status);

  const sendKey = (keysym: number, name: string) => webRef.current?.injectJavaScript(`window.rfb?.sendKey(${keysym}, "${name}");true;`);

  if (!connection || !tab || !wsUrl) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.recovery}>
          <Text style={styles.text}>{status}</Text>
          <View style={styles.recoveryActions}>
            <Pressable accessibilityLabel="Back" style={styles.back} onPress={() => router.back()}><Feather name="arrow-left" size={20} color="#F0F0F0" /></Pressable>
            <Pressable accessibilityLabel="Retry Desktop" style={styles.retry} onPress={retry}><Text style={styles.retryText}>Retry</Text></Pressable>
          </View>
        </View>
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
      <WebView ref={webRef} source={{ html, baseUrl: connection.endpoint }} originWhitelist={['*']} style={styles.webview}
        javaScriptEnabled domStorageEnabled mixedContentMode="always" onMessage={onMessage}
	        onError={() => {
	          setStatus('Desktop view failed');
	          setStatusDetail('The remote-desktop view could not load. Retry the connection.');
	        }} />
      <View testID="vnc-shortcut-dock" style={styles.dock}>
        <Pressable accessibilityLabel="Escape" style={styles.key} onPress={() => sendKey(0xff1b, 'Escape')}><Text style={styles.keyText}>Esc</Text></Pressable>
        <Pressable accessibilityLabel="Tab" style={styles.key} onPress={() => sendKey(0xff09, 'Tab')}><Text style={styles.keyText}>Tab</Text></Pressable>
        <Pressable accessibilityLabel="Ctrl Alt Delete" style={styles.key} onPress={() => webRef.current?.injectJavaScript('window.rfb?.sendCtrlAltDel();true;')}><Text style={styles.keyText}>Ctrl+Alt+Del</Text></Pressable>
      </View>
	      {needsRecovery ? <View style={styles.statusRecovery}><Text style={styles.status}>{status}</Text>{statusDetail ? <Text style={styles.detail}>{statusDetail}</Text> : null}<Pressable accessibilityLabel="Retry Desktop" style={styles.retry} onPress={retry}><Text style={styles.retryText}>Retry</Text></Pressable></View> : status !== 'Desktop connected' && <View style={styles.statusRecovery}><Text style={styles.status}>{status}</Text>{statusDetail ? <Text style={styles.detail}>{statusDetail}</Text> : null}</View>}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0A0A0A' },
  topbar: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12, borderBottomWidth: 1, borderColor: '#262626' },
  back: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  title: { color: '#F0F0F0', fontSize: 16, fontWeight: '600', flex: 1 },
  webview: { flex: 1, backgroundColor: '#000000' },
  dock: { flexDirection: 'row', justifyContent: 'center', gap: 10, padding: 8, backgroundColor: '#141414', borderTopWidth: 1, borderColor: '#262626' },
  key: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, backgroundColor: '#222', borderRadius: 6 },
  keyText: { color: '#E0E0E0', fontSize: 13, fontWeight: '600' },
  status: { backgroundColor: 'rgba(0,0,0,0.8)', color: '#00D9A3', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, fontSize: 12 },
  detail: { color: '#D0D0D0', fontSize: 12, textAlign: 'center', maxWidth: 300 },
  statusRecovery: { position: 'absolute', bottom: 60, alignSelf: 'center', alignItems: 'center', gap: 8 },
  recovery: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 },
  recoveryActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  retry: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, backgroundColor: '#D19A2C', borderRadius: 6 },
  retryText: { color: '#0A0A0A', fontWeight: '700' },
  text: { color: '#888', textAlign: 'center' },
});
