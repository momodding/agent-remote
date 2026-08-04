import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Terminal } from '../../src/components/Terminal';
import { MultiTerminal } from '../../src/components/MultiTerminal';
import { AddSessionFAB } from '../../src/components/AddSessionFAB';
import { ShortcutKeyboard } from '../../src/components/ShortcutKeyboard';
import { AgenticRemoteAPI, APIError } from '../../src/lib/api';
import { getConnection, loadConnections, type Connection } from '../../src/lib/connection';
import { SessionSocket } from '../../src/lib/session-socket';
import { addSession, closeSession, getPlatformMax, toggleMinimize, updateOutput, type MultiSessionState } from '../../src/lib/multi-session';

export default function TerminalScreen() {
  const insets = useSafeAreaInsets();
  const Wrapper = Platform.OS === 'ios' ? KeyboardAvoidingView : View;
  const wrapperProps = Platform.OS === 'ios'
    ? { behavior: 'padding' as const, style: [styles.screen, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }] }
    : { style: [styles.screen, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }] };
  const { id, name, connectionEndpoint, mode } = useLocalSearchParams<{ id: string; name: string; connectionEndpoint: string; mode?: string }>();
  const [output, setOutput] = useState('');
  const [multiSessions, setMultiSessions] = useState<Record<string, MultiSessionState>>({});
  const [isBroadcasting, setIsBroadcasting] = useState(false);
  const [connection, setConnection] = useState<Connection | null>(null);
  const socket = useRef<SessionSocket | undefined>(undefined);
  const isMultiModeCheck = mode === "multi";
  const multiSocketsRef = useRef<Record<string, SessionSocket>>({});
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
      if (!isMultiModeCheck) connect(resolved);
    });
    return () => socket.current?.close();
  }, [connect, connectionEndpoint]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active' && connection) connect(connection);
      if (state === 'active' && connection) {
        if (!isMultiModeCheck) connect(connection);
        Object.values(multiSocketsRef.current).forEach((s) => s.connect());
      } else if (state === 'background') {
        socket.current?.close();
        Object.values(multiSocketsRef.current).forEach((s) => s.close());
      }
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

  const handleCloseAll = useCallback(async () => {
    socket.current?.close();
    if (connection) {
      const restApi = new AgenticRemoteAPI(connection);
      for (const sessionId of Object.keys(multiSocketsRef.current)) {
        const s = multiSocketsRef.current[sessionId];
        if (s) s.close();
        try {
          await restApi.closeSession(sessionId);
        } catch (error) {
          if (!(error instanceof APIError && error.status === 404)) console.warn(error);
        }
      }
    }
    Object.values(multiSocketsRef.current).forEach((s) => s.close());
    multiSocketsRef.current = {};
    setMultiSessions({});
    router.replace('/');
  }, [connection]);


  const platformMax = getPlatformMax();

  // Multi-window handlers
  const handleAddSession = useCallback((sessionId: string, sessionName: string) => {
    if (!connection || multiSocketsRef.current[sessionId]) return;
    const newSession: MultiSessionState = {
      sessionId,
      name: sessionName,
      connectionEndpoint: connection.endpoint,
      output: '',
      minimized: false,
    };
    const newSocket = new SessionSocket(
      connection,
      sessionId,
      (data) => setMultiSessions((prev) => updateOutput(prev, sessionId, prev[sessionId]?.output + data)),
      (state) => {
        if (state === 'exited') {
          multiSocketsRef.current[sessionId]?.close();
          delete multiSocketsRef.current[sessionId];
          setMultiSessions((prev) => closeSession(prev, sessionId));
        }
      },
      (message) => Alert.alert('Terminal', message),
    );
    newSocket.connect();
    newSession.socket = newSocket;
    multiSocketsRef.current[sessionId] = newSocket;
    setMultiSessions((prev) => addSession(prev, newSession));
  }, [connection]);

  const handleCloseSession = useCallback(async (sessionId: string) => {
    const s = multiSocketsRef.current[sessionId];
    if (!s || !connection) return;
    s.close();
    delete multiSocketsRef.current[sessionId];
    setMultiSessions((prev) => closeSession(prev, sessionId));
    try {
      await new AgenticRemoteAPI(connection).closeSession(sessionId);
    } catch (error) {
      if (!(error instanceof APIError && error.status === 404)) {
        Alert.alert('Could not close session', error instanceof Error ? error.message : 'Unknown error');
      }
    }
  }, [connection]);

  const handleMinimize = useCallback((sessionId: string) => {
    setMultiSessions((prev) => toggleMinimize(prev, sessionId));
  }, []);

  const handleInput = useCallback((sessionId: string, data: string) => {
    if (isBroadcasting) {
      Object.values(multiSocketsRef.current).forEach((s) => s.input(data));
    } else {
      multiSocketsRef.current[sessionId]?.input(data);
    }
  }, [isBroadcasting]);

  const handleResize = useCallback((sessionId: string, cols: number, rows: number) => {
    multiSocketsRef.current[sessionId]?.resize(cols, rows);
  }, []);

  // Initialize first session in multi-mode
  useEffect(() => {
    if (isMultiModeCheck && connection && id && Object.keys(multiSessions).length === 0) {
      handleAddSession(id, name || 'Shell');
    }
  }, [isMultiModeCheck, connection, id, name, multiSessions, handleAddSession]);

  if (isMultiModeCheck) {
    return <Wrapper {...wrapperProps}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable accessibilityLabel="Detach" onPress={detach}>
          <Text style={styles.back}>‹ Sessions</Text>
        </Pressable>
        <Text style={styles.title}>Multi-Terminal</Text>
        <View style={styles.actions}>
          <Pressable accessibilityLabel="Close all" onPress={handleCloseAll}>
            <Text style={styles.close}>Close All</Text>
          </Pressable>
        </View>
      </View>
      {connection ? (
        <>
          <MultiTerminal
            sessions={multiSessions}
            onInput={handleInput}
            onResize={handleResize}
            onMinimize={handleMinimize}
            onClose={handleCloseSession}
            isBroadcasting={isBroadcasting}
            onBroadcastToggle={() => setIsBroadcasting((prev) => !prev)}
            platformMax={platformMax}
            bottomInset={insets.bottom}
          />
          <AddSessionFAB
            api={new AgenticRemoteAPI(connection)}
            onAdd={handleAddSession}
            disabled={Object.keys(multiSessions).length >= platformMax}
          />
        </>
      ) : (
        <Text style={styles.connecting}>Connecting…</Text>
      )}
    </Wrapper>;
  }

  return <Wrapper {...wrapperProps}>
    <Stack.Screen options={{ headerShown: false }} />
    <View style={styles.header}><Pressable accessibilityLabel="Detach" onPress={detach}><Text style={styles.back}>‹ Sessions</Text></Pressable><Text style={styles.title} numberOfLines={1}>{name || 'Terminal'}</Text><View style={styles.actions}><Pressable onPress={() => setOutput('')}><Text style={styles.clear}>Clear</Text></Pressable><Pressable accessibilityLabel="Close session" onPress={close}><Text style={styles.close}>Close</Text></Pressable></View></View>
    <View style={styles.terminal}>{connection ? <Terminal output={output} onInput={(data) => socket.current?.input(data)} onResize={(cols, rows) => socket.current?.resize(cols, rows)} /> : <Text style={styles.connecting}>Connecting…</Text>}</View>
    <ShortcutKeyboard onInput={(data) => socket.current?.input(data)} bottomInset={insets.bottom} />
  </Wrapper>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0A0A0A' }, header: { minHeight: 56, paddingHorizontal: 14, alignItems: 'center', flexDirection: 'row', gap: 14, borderBottomWidth: 1, borderColor: '#262626' }, back: { color: '#46B8C4', fontWeight: '700' }, title: { flex: 1, color: '#F0F0F0', fontSize: 16, fontWeight: '700' }, actions: { flexDirection: 'row', gap: 14 }, clear: { color: '#B8B8B8' }, close: { color: '#EF6666' }, terminal: { flex: 1 }, connecting: { color: '#B8B8B8', padding: 20 },
});
