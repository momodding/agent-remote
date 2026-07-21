import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';

import { Terminal } from '../../src/components/Terminal';
import { ShortcutKeyboard } from '../../src/components/ShortcutKeyboard';
import { loadConnection, type Connection } from '../../src/lib/connection';
import { SessionSocket } from '../../src/lib/session-socket';

export default function TerminalScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name: string }>();
  const [output, setOutput] = useState('');
  const [connection, setConnection] = useState<Connection | null>(null);
  const socket = useRef<SessionSocket | undefined>(undefined);

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

  return <SafeAreaView style={styles.screen}>
    <Stack.Screen options={{ headerShown: false }} />
    <View style={styles.header}><Pressable onPress={() => router.back()}><Text style={styles.back}>‹ Sessions</Text></Pressable><Text style={styles.title} numberOfLines={1}>{name || 'Terminal'}</Text><Pressable onPress={() => setOutput('')}><Text style={styles.clear}>Clear</Text></Pressable></View>
    <View style={styles.terminal}>{connection ? <Terminal output={output} onInput={(data) => socket.current?.input(data)} onResize={(cols, rows) => socket.current?.resize(cols, rows)} /> : <Text style={styles.connecting}>Connecting…</Text>}</View>
    <ShortcutKeyboard onInput={(data) => socket.current?.input(data)} />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0A0A0A' }, header: { minHeight: 56, paddingHorizontal: 14, alignItems: 'center', flexDirection: 'row', gap: 14, borderBottomWidth: 1, borderColor: '#262626' }, back: { color: '#46B8C4', fontWeight: '700' }, title: { flex: 1, color: '#F0F0F0', fontSize: 16, fontWeight: '700' }, clear: { color: '#B8B8B8' }, terminal: { flex: 1 }, connecting: { color: '#B8B8B8', padding: 20 },
});
