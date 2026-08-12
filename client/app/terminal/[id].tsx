import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, KeyboardAvoidingView, Keyboard, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';


import { Terminal, type TerminalHandle } from '../../src/components/Terminal';
import { MultiTerminal } from '../../src/components/MultiTerminal';
import { AddSessionFAB } from '../../src/components/AddSessionFAB';
import { ShortcutKeyboard, type ShortcutKeyboardHandle } from '../../src/components/ShortcutKeyboard';
import { AgenticRemoteAPI, APIError } from '../../src/lib/api';
import { getConnection, loadConnections, type Connection } from '../../src/lib/connection';
import { SessionSocket } from '../../src/lib/session-socket';
import { MAX_MULTI_SESSIONS, addSession, closeSession, updateOutput, type MultiSessionState } from '../../src/lib/multi-session';

export default function TerminalScreen() {
  const insets = useSafeAreaInsets();
  const Wrapper = SafeAreaView;
  const { id, name, connectionEndpoint, mode } = useLocalSearchParams<{ id: string; name: string; connectionEndpoint: string; mode?: string }>();
  const [output, setOutput] = useState('');
  const [multiSessions, setMultiSessions] = useState<Record<string, MultiSessionState>>({});
  const [isBroadcasting, setIsBroadcasting] = useState(false);

  const wrapperProps = { style: styles.screen, edges: ['top', 'left', 'right'] as const };

  const [connection, setConnection] = useState<Connection | null>(null);
  const terminalRef = useRef<TerminalHandle>(null);
  const shortcutKeyboardRef = useRef<ShortcutKeyboardHandle>(null);
  const socket = useRef<SessionSocket | undefined>(undefined);
  const isMultiModeCheck = mode === "multi";
  const multiSocketsRef = useRef<Record<string, SessionSocket>>({});
  const multiInitializedRef = useRef(false); // ponytail: guards the one-shot initial-session effect so a closed/not-found session never retriggers it
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
      (message, code) => {
        if (code === 'session_not_found') { void finish(current); return; }
        Alert.alert('Terminal', message);
      },
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

  const closeAll = useCallback(async () => {
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

  const handleCloseAll = useCallback(() => {
    Alert.alert('Close all sessions?', 'This will terminate every running session.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Close all', style: 'destructive', onPress: () => void closeAll() },
    ]);
  }, [closeAll]);


  // Multi-window handlers
  const handleAddSession = useCallback((sessionId: string, sessionName: string) => {
    if (!connection || multiSocketsRef.current[sessionId]) return;
    const newSession: MultiSessionState = {
      sessionId,
      name: sessionName,
      connectionEndpoint: connection.endpoint,
      output: '',
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
      (message, code) => {
        if (code === 'session_not_found') {
          multiSocketsRef.current[sessionId]?.close();
          delete multiSocketsRef.current[sessionId];
          setMultiSessions((prev) => closeSession(prev, sessionId));
          return;
        }
        Alert.alert('Terminal', message);
      },
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

  // Initialize first session in multi-mode; runs once per screen mount, not on every empty-state dip.
  useEffect(() => {
    if (isMultiModeCheck && connection && id && !multiInitializedRef.current) {
      multiInitializedRef.current = true;
      handleAddSession(id, name || 'Shell');
    }
  }, [isMultiModeCheck, connection, id, name, handleAddSession]);

  if (isMultiModeCheck) {
    return <Wrapper {...wrapperProps}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <Pressable accessibilityLabel="Detach" onPress={detach} style={styles.headerIcon}>
          <Feather name="arrow-left" size={20} color="#46B8C4" />
        </Pressable>
        <Text style={styles.title}>Multi-Terminal</Text>
        <View style={styles.actions}>
          <Pressable
            accessibilityLabel={isBroadcasting ? 'Disable broadcast' : 'Enable broadcast'}
            onPress={() => setIsBroadcasting((previous) => !previous)}
            style={({ pressed }) => [styles.headerIcon, isBroadcasting && styles.broadcastActive, pressed && styles.pressed]}
          >
            <Feather name="zap" size={18} color={isBroadcasting ? '#0A0A0A' : '#46B8C4'} />
          </Pressable>
          <Pressable accessibilityLabel="Close all" onPress={handleCloseAll} style={({ pressed }) => [styles.headerIcon, pressed && styles.pressed]}>
            <Feather name="x-circle" size={20} color="#EF6666" />
          </Pressable>
        </View>
      </View>
      {connection ? (
        <>
          <MultiTerminal
            sessions={multiSessions}
            onInput={handleInput}
            onResize={handleResize}
            onClose={handleCloseSession}
            bottomInset={insets.bottom}
          />
          <AddSessionFAB
            api={new AgenticRemoteAPI(connection)}
            onAdd={handleAddSession}
            disabled={Object.keys(multiSessions).length >= MAX_MULTI_SESSIONS}
            bottomInset={insets.bottom}
          />
        </>
      ) : (
        <Text style={styles.connecting}>Connecting…</Text>
      )}
      </KeyboardAvoidingView>
    </Wrapper>;
  }

  return <Wrapper {...wrapperProps}>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <Stack.Screen options={{ headerShown: false }} />
    <View style={styles.header}>
      <Pressable accessibilityLabel="Detach" onPress={detach} style={styles.headerIcon}><Feather name="arrow-left" size={20} color="#46B8C4" /></Pressable>
      <Text style={styles.title} numberOfLines={1}>{name || 'Terminal'}</Text>
      <View style={styles.actions}>
        <Pressable accessibilityLabel="Clear" onPress={() => setOutput('')} android_ripple={{ color: 'rgba(255,255,255,0.15)' }} style={({ pressed }) => [styles.headerIcon, pressed && styles.pressed]}><Feather name="trash-2" size={18} color="#B8B8B8" /></Pressable>
        <Pressable accessibilityLabel="Close session" onPress={close} android_ripple={{ color: 'rgba(255,255,255,0.15)' }} style={({ pressed }) => [styles.headerIcon, pressed && styles.pressed]}><Feather name="x" size={20} color="#EF6666" /></Pressable>
      </View>
    </View>
    <View style={styles.terminal}>
      {connection ? <Terminal ref={terminalRef} output={output} onInput={(data) => shortcutKeyboardRef.current?.input(data)} onResize={(cols, rows) => socket.current?.resize(cols, rows)} /> : <Text style={styles.connecting}>Connecting…</Text>}
    </View>
    <ShortcutKeyboard ref={shortcutKeyboardRef} onInput={(data) => socket.current?.input(data)} bottomInset={insets.bottom} onCopy={() => terminalRef.current?.copy()} onPaste={() => terminalRef.current?.paste()} onSelectAll={() => terminalRef.current?.selectAll()} onExpand={() => { Keyboard.dismiss(); terminalRef.current?.blur(); }} onCollapse={() => terminalRef.current?.focus()} />
    </KeyboardAvoidingView>
  </Wrapper>;
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.6 },
  screen: { flex: 1, backgroundColor: '#0A0A0A' },
  header: { minHeight: 56, paddingHorizontal: 14, alignItems: 'center', flexDirection: 'row', gap: 8, borderBottomWidth: 1, borderColor: '#262626' },
  headerIcon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 6 },
  broadcastActive: { backgroundColor: '#46B8C4' },
  title: { flex: 1, color: '#F0F0F0', fontSize: 16, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 4 },
  terminal: { flex: 1 },
  connecting: { color: '#B8B8B8', padding: 20 },
});
