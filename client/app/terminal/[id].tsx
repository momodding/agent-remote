import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Keyboard, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';

import { Terminal, type TerminalHandle } from '../../src/components/Terminal';
import { MultiTerminal } from '../../src/components/MultiTerminal';
import { AddSessionFAB } from '../../src/components/AddSessionFAB';
import { ShortcutKeyboard, type ShortcutKeyboardHandle } from '../../src/components/ShortcutKeyboard';
import { AgenticRemoteAPI, APIError } from '../../src/lib/api';
import { getConnection, loadConnections, type Connection } from '../../src/lib/connection';
import { createDaemonChannel, type DaemonChannel } from '../../src/lib/daemon-channel';
import { base64, decodeBase64, utf8 } from '../../src/lib/bytes';
import { MAX_MULTI_SESSIONS, addSession, closeSession, updateOutput, type MultiSessionState } from '../../src/lib/multi-session';
import { useTabStore } from '../../src/lib/tabs/tab-store';
import type { TerminalWorkspaceTab } from '../../src/lib/tabs/types';

// Displayed/REST session id -> multiplex channel id + this screen's listener teardown.
type MultiChannelEntry = { channelId: string; unsubscribe: () => void };

export default function TerminalScreen() {
  const insets = useSafeAreaInsets();
  const Wrapper = SafeAreaView;
  const { id, mode } = useLocalSearchParams<{ id: string; mode?: string }>();
  const { state, closeTab } = useTabStore();
  const tab = state.tabs.find((t): t is TerminalWorkspaceTab => t.tabId === id && t.kind === 'terminal') ?? null;
  const [output, setOutput] = useState('');
  const [multiSessions, setMultiSessions] = useState<Record<string, MultiSessionState>>({});
  const [isBroadcasting, setIsBroadcasting] = useState(false);

  const { height: windowHeight } = useWindowDimensions();
  const [keyboardInset, setKeyboardInset] = useState(0);
  const wrapperProps = { style: styles.screen, edges: ['top', 'left', 'right'] as const };

  const [connection, setConnection] = useState<Connection | null>(null);
  const terminalRef = useRef<TerminalHandle>(null);
  const shortcutKeyboardRef = useRef<ShortcutKeyboardHandle>(null);
  const channelRef = useRef<DaemonChannel | null>(null);
  const primaryUnsubscribeRef = useRef<(() => void) | null>(null);
  const isMultiModeCheck = mode === 'multi';
  const multiChannelsRef = useRef<Record<string, MultiChannelEntry>>({});
  const multiInitializedRef = useRef(false); // ponytail: guards the one-shot initial-session effect so a closed/not-found session never retriggers it
  // Guards natural-exit and manual-Close from racing each other into a double
  // REST close / double navigation (closing triggers the daemon's own `exited` frame).
  const finishingRef = useRef(false);
  const api = useMemo(() => connection && new AgenticRemoteAPI(connection), [connection]);

  const finish = useCallback(async () => {
    if (finishingRef.current || !tab) return;
    finishingRef.current = true;
    primaryUnsubscribeRef.current?.();
    setOutput('');
    if (connection) {
      try {
        await new AgenticRemoteAPI(connection).closeSession(tab.remoteSessionId);
      } catch (error) {
        if (!(error instanceof APIError && error.status === 404)) {
          Alert.alert('Could not close session', error instanceof Error ? error.message : 'Unknown error');
        }
      }
      channelRef.current?.closeChannel(tab.remoteSessionId);
    }
    closeTab(tab.tabId);
    router.replace('/');
  }, [tab, connection, closeTab]);

  // Subscribes this screen to the tab's primary multiplex channel. Reconnect
  // (e.g. re-entering the tab) replays complete scrollback since `output` is
  // screen-local state, not persisted on the tab itself.
  const connect = useCallback(() => {
    const channel = channelRef.current;
    if (!tab || !channel) return;
    setOutput('');
    const decoder = new TextDecoder();
    primaryUnsubscribeRef.current = channel.subscribe(tab.remoteSessionId, (msg) => {
      if (msg.type === 'pty.output') {
        const chunk = decoder.decode(decodeBase64(msg.data), { stream: true });
        if (chunk) setOutput((existing) => existing + chunk);
      } else if (msg.type === 'session.state') {
        if (msg.state === 'exited') void finish();
      } else if (msg.type === 'error') {
        if (msg.code === 'session_not_found') { void finish(); return; }
        Alert.alert('Terminal', msg.message);
      }
    });
  }, [tab, finish]);

  useEffect(() => {
    if (!tab) {
      Alert.alert('Could not load daemon connection');
      router.replace('/');
      return;
    }
    void loadConnections().then((store) => {
      const resolved = getConnection(store, tab.daemonId);
      if (!resolved) {
        Alert.alert('Could not load daemon connection');
        router.replace('/');
        return;
      }
      channelRef.current = createDaemonChannel(resolved);
      setConnection(resolved);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.tabId]);

  // Runs `connect()` fresh each time `connection` resolves so the
  // subscriber closure (and `finish`'s REST-close path) sees the current
  // `connection`, not the null captured when the mount effect above fired.
  useEffect(() => {
    if (!connection || isMultiModeCheck) return;
    connect();
    // Unsubscribe this screen's listener only — the channel and its backend
    // are daemon-scoped and outlive navigation; only explicit close/detach
    // actions tear those down.
    return () => primaryUnsubscribeRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const show = (event: { endCoordinates: { screenY: number } }) => setKeyboardInset(Math.max(0, windowHeight - event.endCoordinates.screenY - insets.bottom));
    const hide = () => setKeyboardInset(0);
    const shown = Keyboard.addListener('keyboardDidShow', show);
    const changed = Keyboard.addListener('keyboardDidChangeFrame', show);
    const hidden = Keyboard.addListener('keyboardDidHide', hide);
    return () => {
      shown.remove();
      changed.remove();
      hidden.remove();
    };
  }, [insets.bottom, windowHeight]);

  const close = useCallback(() => {
    if (!api || !tab || finishingRef.current) return;
    Alert.alert('Close session?', 'This will terminate the running session.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Close', style: 'destructive', onPress: async () => {
        finishingRef.current = true;
        try {
          await api.closeSession(tab.remoteSessionId);
          primaryUnsubscribeRef.current?.();
          channelRef.current?.closeChannel(tab.remoteSessionId);
          setOutput('');
          closeTab(tab.tabId);
          router.replace('/');
        } catch (error) {
          finishingRef.current = false;
          Alert.alert('Could not close session', error instanceof Error ? error.message : 'Unknown error');
        }
      } },
    ]);
  }, [api, tab, closeTab]);

  // Detach: leave the process and the tab running, just stop listening here.
  const detach = useCallback(() => {
    primaryUnsubscribeRef.current?.();
    setOutput('');
    router.replace('/');
  }, []);

  const closeAll = useCallback(async () => {
    const channel = channelRef.current;
    const restApi = connection && new AgenticRemoteAPI(connection);
    for (const [sessionId, entry] of Object.entries(multiChannelsRef.current)) {
      entry.unsubscribe();
      channel?.closeChannel(entry.channelId);
      if (restApi) {
        try {
          await restApi.closeSession(sessionId);
        } catch (error) {
          if (!(error instanceof APIError && error.status === 404)) console.warn(error);
        }
      }
    }
    multiChannelsRef.current = {};
    setMultiSessions({});
    if (tab) closeTab(tab.tabId);
    router.replace('/');
  }, [connection, tab, closeTab]);

  const handleCloseAll = useCallback(() => {
    Alert.alert('Close all sessions?', 'This will terminate every running session.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Close all', style: 'destructive', onPress: () => void closeAll() },
    ]);
  }, [closeAll]);

  // Local-only cleanup for a multi-pane session the daemon already ended
  // (exited state or session_not_found) — no redundant REST close call.
  const dropMultiSession = useCallback((sessionId: string) => {
    const entry = multiChannelsRef.current[sessionId];
    if (entry) {
      entry.unsubscribe();
      channelRef.current?.closeChannel(entry.channelId);
      delete multiChannelsRef.current[sessionId];
    }
    setMultiSessions((prev) => closeSession(prev, sessionId));
  }, []);

  // Multi-window handlers
  const handleAddSession = useCallback((sessionId: string, sessionName: string) => {
    const channel = channelRef.current;
    if (!tab || !channel || multiChannelsRef.current[sessionId]) return;
    void (async () => {
      const channelId = await channel.openChannel('terminal', { sessionId });
      const decoder = new TextDecoder();
      const unsubscribe = channel.subscribe(channelId, (msg) => {
        if (msg.type === 'pty.output') {
          const chunk = decoder.decode(decodeBase64(msg.data), { stream: true });
          if (chunk) setMultiSessions((prev) => updateOutput(prev, sessionId, (prev[sessionId]?.output ?? '') + chunk));
        } else if (msg.type === 'session.state') {
          if (msg.state === 'exited') dropMultiSession(sessionId);
        } else if (msg.type === 'error') {
          if (msg.code === 'session_not_found') { dropMultiSession(sessionId); return; }
          Alert.alert('Terminal', msg.message);
        }
      });
      multiChannelsRef.current[sessionId] = { channelId, unsubscribe };
      setMultiSessions((prev) => addSession(prev, { sessionId, name: sessionName, hostId: tab.daemonId, output: '' }));
    })();
  }, [tab, dropMultiSession]);

  const handleCloseSession = useCallback(async (sessionId: string) => {
    if (!multiChannelsRef.current[sessionId] || !connection) return;
    dropMultiSession(sessionId);
    try {
      await new AgenticRemoteAPI(connection).closeSession(sessionId);
    } catch (error) {
      if (!(error instanceof APIError && error.status === 404)) {
        Alert.alert('Could not close session', error instanceof Error ? error.message : 'Unknown error');
      }
    }
  }, [connection, dropMultiSession]);

  const handleInput = useCallback((sessionId: string, data: string) => {
    const channel = channelRef.current;
    if (!channel) return;
    const send = (targetSessionId: string) => {
      const entry = multiChannelsRef.current[targetSessionId];
      if (entry) channel.send({ channelId: entry.channelId, kind: 'terminal', type: 'pty.input', data: base64(utf8(data)) });
    };
    if (isBroadcasting) {
      Object.keys(multiChannelsRef.current).forEach(send);
    } else {
      send(sessionId);
    }
  }, [isBroadcasting]);

  const handleResize = useCallback((sessionId: string, cols: number, rows: number) => {
    const channel = channelRef.current;
    const entry = multiChannelsRef.current[sessionId];
    if (channel && entry) channel.send({ channelId: entry.channelId, kind: 'terminal', type: 'pty.resize', cols, rows });
  }, []);

  // Initialize first session in multi-mode; runs once per screen mount, not on every empty-state dip.
  useEffect(() => {
    if (isMultiModeCheck && tab && connection && !multiInitializedRef.current) {
      multiInitializedRef.current = true;
      handleAddSession(tab.remoteSessionId, tab.title || 'Shell');
    }
  }, [isMultiModeCheck, tab, connection, handleAddSession]);

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
            keyboardInset={keyboardInset}
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
      <Text style={styles.title} numberOfLines={1}>{tab?.title || 'Terminal'}</Text>
      <View style={styles.actions}>
        <Pressable accessibilityLabel="Clear" onPress={() => setOutput('')} android_ripple={{ color: 'rgba(255,255,255,0.15)' }} style={({ pressed }) => [styles.headerIcon, pressed && styles.pressed]}><Feather name="trash-2" size={18} color="#B8B8B8" /></Pressable>
        <Pressable accessibilityLabel="Close session" onPress={close} android_ripple={{ color: 'rgba(255,255,255,0.15)' }} style={({ pressed }) => [styles.headerIcon, pressed && styles.pressed]}><Feather name="x" size={20} color="#EF6666" /></Pressable>
      </View>
    </View>
    <View style={styles.terminal}>
      {connection && tab ? <Terminal ref={terminalRef} output={output} onInput={(data) => shortcutKeyboardRef.current?.input(data)} onResize={(cols, rows) => channelRef.current?.send({ channelId: tab.remoteSessionId, kind: 'terminal', type: 'pty.resize', cols, rows })} /> : <Text style={styles.connecting}>Connecting…</Text>}
    </View>
    <ShortcutKeyboard ref={shortcutKeyboardRef} onInput={(data) => tab && channelRef.current?.send({ channelId: tab.remoteSessionId, kind: 'terminal', type: 'pty.input', data: base64(utf8(data)) })} bottomInset={insets.bottom} keyboardInset={keyboardInset} onCopy={() => terminalRef.current?.copy()} onPaste={() => terminalRef.current?.paste()} onSelectAll={() => terminalRef.current?.selectAll()} onExpand={() => { Keyboard.dismiss(); terminalRef.current?.blur(); }} onCollapse={() => terminalRef.current?.focus()} />
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
