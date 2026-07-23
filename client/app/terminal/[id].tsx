import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';

import { Terminal } from '../../src/components/Terminal';
import { ShortcutKeyboard } from '../../src/components/ShortcutKeyboard';
import { AgenticRemoteAPI, APIError } from '../../src/lib/api';
import { getConnection, loadConnections, type Connection } from '../../src/lib/connection';
import { SessionSocket } from '../../src/lib/session-socket';

export default function TerminalScreen() {
  const { id, name, connectionEndpoint } = useLocalSearchParams<{ id: string; name: string; connectionEndpoint: string }>();
  const [output, setOutput] = useState('');
  const [connection, setConnection] = useState<Connection | null>(null);
  const socket = useRef<SessionSocket | undefined>(undefined);
  // Guards natural-exit and manual-Close from racing each other into a double
  // REST close / double navigation (closing triggers the daemon's own `exited` frame).
  const finishingRef = useRef(false);
  const api = useMemo(() => connection && new AgenticRemoteAPI(connection), [connection]);

  const finish = useCallback(async (current: Connection) => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    socket.current?.close();
    setOutput('');
    try {
      await new AgenticRemoteAPI(current).closeSession(id);
    } catch (error) {
      if (!(error instanceof APIError && error.status === 404)) {
        Alert.alert('Could not close session', error instanceof Error ? error.message : 'Unknown error');
      }
    }
    router.replace('/');
  }, [id]);

  const connect = useCallback((current: Connection) => {
    if (!id) return;
    setOutput(''); // Subscription replays complete scrollback after each reconnect.
    socket.current = new SessionSocket(
      current,
      id,
      (data) => setOutput((existing) => existing + data),
      (state) => { if (state === 'exited') void finish(current); },
      (message) => Alert.alert('Terminal', message),
    );
    socket.current.connect();
  }, [id, finish]);

  useEffect(() => {
    void loadConnections().then((store) => {
      const resolved = getConnection(store, connectionEndpoint ?? null);
      if (!resolved) {
        Alert.alert('Could not load daemon connection');
        router.replace('/');
        return;
      }
      setConnection(resolved);
      connect(resolved);
    });
    return () => socket.current?.close();
  }, [connect, connectionEndpoint]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active' && connection) connect(connection);
      if (state !== 'active') socket.current?.close();
    });
    return () => listener.remove();
  }, [connection, connect]);

  const close = useCallback(() => {
    if (!api || !id || finishingRef.current) return;
    Alert.alert('Close session?', 'This will terminate the running session.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Close', style: 'destructive', onPress: async () => {
        finishingRef.current = true;
        try {
          await api.closeSession(id);
          socket.current?.close();
          setOutput('');
          router.replace('/');
        } catch (error) {
          finishingRef.current = false;
          Alert.alert('Could not close session', error instanceof Error ? error.message : 'Unknown error');
        }
      } },
    ]);
  }, [api, id]);

  // Detach: leave the process running and return to the list, no REST call.
  const detach = useCallback(() => {
    socket.current?.close();
    setOutput('');
    router.replace('/');
  }, []);

  return <SafeAreaView style={styles.screen}>
    <Stack.Screen options={{ headerShown: false }} />
    <View style={styles.header}><Pressable accessibilityLabel="Detach" onPress={detach}><Text style={styles.back}>‹ Sessions</Text></Pressable><Text style={styles.title} numberOfLines={1}>{name || 'Terminal'}</Text><View style={styles.actions}><Pressable onPress={() => setOutput('')}><Text style={styles.clear}>Clear</Text></Pressable><Pressable accessibilityLabel="Close session" onPress={close}><Text style={styles.close}>Close</Text></Pressable></View></View>
    <View style={styles.terminal}>{connection ? <Terminal output={output} onInput={(data) => socket.current?.input(data)} onResize={(cols, rows) => socket.current?.resize(cols, rows)} /> : <Text style={styles.connecting}>Connecting…</Text>}</View>
    <ShortcutKeyboard onInput={(data) => socket.current?.input(data)} />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0A0A0A' }, header: { minHeight: 56, paddingHorizontal: 14, alignItems: 'center', flexDirection: 'row', gap: 14, borderBottomWidth: 1, borderColor: '#262626' }, back: { color: '#46B8C4', fontWeight: '700' }, title: { flex: 1, color: '#F0F0F0', fontSize: 16, fontWeight: '700' }, actions: { flexDirection: 'row', gap: 14 }, clear: { color: '#B8B8B8' }, close: { color: '#EF6666' }, terminal: { flex: 1 }, connecting: { color: '#B8B8B8', padding: 20 },
});
