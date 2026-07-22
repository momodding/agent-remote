import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';

import { Terminal } from '../../src/components/Terminal';
import { ShortcutKeyboard } from '../../src/components/ShortcutKeyboard';
import { AgenticRemoteAPI } from '../../src/lib/api';
import { loadConnection, type Connection } from '../../src/lib/connection';
import { SessionSocket } from '../../src/lib/session-socket';

export default function TerminalScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name: string }>();
  const [output, setOutput] = useState('');
  const [connection, setConnection] = useState<Connection | null>(null);
  const socket = useRef<SessionSocket | undefined>(undefined);
  const api = useMemo(() => connection && new AgenticRemoteAPI(connection), [connection]);

  const connect = useCallback((current: Connection) => {
    if (!id) return;
    setOutput(''); // Subscription replays complete scrollback after each reconnect.
    socket.current = new SessionSocket(current, id, (data) => setOutput((existing) => existing + data), () => undefined, (message) => Alert.alert('Terminal', message));
    socket.current.connect();
  }, [id]);

  useEffect(() => { void loadConnection().then((saved) => { setConnection(saved); if (saved) connect(saved); }); return () => socket.current?.close(); }, [connect]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active' && connection) connect(connection);
      if (state !== 'active') socket.current?.close();
    });
    return () => listener.remove();
  }, [connection, connect]);

  const close = useCallback(() => {
    if (!api || !id) return;
    Alert.alert('Close session?', 'This will terminate the running session.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Close', style: 'destructive', onPress: async () => {
        try {
          await api.closeSession(id);
          socket.current?.close();
          router.back();
        } catch (error) {
          Alert.alert('Could not close session', error instanceof Error ? error.message : 'Unknown error');
        }
      } },
    ]);
  }, [api, id]);

  return <SafeAreaView style={styles.screen}>
    <Stack.Screen options={{ headerShown: false }} />
    <View style={styles.header}><Pressable onPress={() => router.back()}><Text style={styles.back}>‹ Sessions</Text></Pressable><Text style={styles.title} numberOfLines={1}>{name || 'Terminal'}</Text><View style={styles.actions}><Pressable onPress={() => setOutput('')}><Text style={styles.clear}>Clear</Text></Pressable><Pressable accessibilityLabel="Close session" onPress={close}><Text style={styles.close}>Close</Text></Pressable></View></View>
    <View style={styles.terminal}>{connection ? <Terminal output={output} onInput={(data) => socket.current?.input(data)} onResize={(cols, rows) => socket.current?.resize(cols, rows)} /> : <Text style={styles.connecting}>Connecting…</Text>}</View>
    <ShortcutKeyboard onInput={(data) => socket.current?.input(data)} />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0A0A0A' }, header: { minHeight: 56, paddingHorizontal: 14, alignItems: 'center', flexDirection: 'row', gap: 14, borderBottomWidth: 1, borderColor: '#262626' }, back: { color: '#46B8C4', fontWeight: '700' }, title: { flex: 1, color: '#F0F0F0', fontSize: 16, fontWeight: '700' }, actions: { flexDirection: 'row', gap: 14 }, clear: { color: '#B8B8B8' }, close: { color: '#EF6666' }, terminal: { flex: 1 }, connecting: { color: '#B8B8B8', padding: 20 },
});
