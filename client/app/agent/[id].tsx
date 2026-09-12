import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';

import { Terminal, type TerminalHandle } from '../../src/components/Terminal';
import { TmuxPaneSheet, type TmuxPaneSheetHandle } from '../../src/components/TmuxPaneSheet';
import { ShortcutKeyboard, type ShortcutKeyboardHandle } from '../../src/components/ShortcutKeyboard';
import { AgenticRemoteAPI, APIError } from '../../src/lib/api';
import { getConnection, loadConnections, type Connection } from '../../src/lib/connection';
import { createDaemonChannel, type DaemonChannel } from '../../src/lib/daemon-channel';
import { createRuntimeChannel, type RuntimeChannel } from '../../src/lib/runtime-channel';
import { base64, decodeBase64, utf8 } from '../../src/lib/bytes';
import { addTab, updateTab, useTabStore } from '../../src/lib/tabs/tab-store';
import type { AgentWorkspaceTab, TerminalWorkspaceTab } from '../../src/lib/tabs/types';
import type { AgentEvent, TmuxPane } from '../../src/protocol';

type MessageItem = {
  id: string;
  type: string;
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  state?: string;
  cursor?: number;
};

export default function AgentScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { state, dispatch, closeTab } = useTabStore();
  const tab = state.tabs.find((t): t is AgentWorkspaceTab => t.tabId === id && t.kind === 'agent') ?? null;

  const [connection, setConnection] = useState<Connection | null>(null);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [promptText, setPromptText] = useState('');
  const [sending, setSending] = useState(false);
  const [viewMode, setViewMode] = useState<'chat' | 'terminal'>(tab?.view ?? 'chat');
  const [terminalOutput, setTerminalOutput] = useState('');
  const [keyboardInset, setKeyboardInset] = useState(0);

  const { height: windowHeight } = useWindowDimensions();
  const terminalRef = useRef<TerminalHandle>(null);
  const shortcutKeyboardRef = useRef<ShortcutKeyboardHandle>(null);
  const daemonChannelRef = useRef<DaemonChannel | null>(null);
  const runtimeChannelRef = useRef<RuntimeChannel | null>(null);
  const ptyUnsubRef = useRef<(() => void) | null>(null);
  const agentUnsubRef = useRef<(() => void) | null>(null);
  const currentAgentChannelIdRef = useRef<string | null>(null);
  const flatListRef = useRef<FlatList>(null);
  const [panes, setPanes] = useState<TmuxPane[]>([]);
  const paneSheetRef = useRef<TmuxPaneSheetHandle>(null);

  const api = useMemo(() => connection && new AgenticRemoteAPI(connection), [connection]);

  // Load connection
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
      daemonChannelRef.current = createDaemonChannel(resolved);
      runtimeChannelRef.current = createRuntimeChannel(resolved);
      setConnection(resolved);
    });
  }, [tab?.tabId]);

  // Subscribe to Agent Runtime Events
  useEffect(() => {
    if (!tab || !connection || !runtimeChannelRef.current) return;
    const runtime = runtimeChannelRef.current;
    let active = true;

	void runtime.openAgentChannel(tab.agentSessionId, 0, (event: AgentEvent) => {
		if (!active) return;
		if (event.state) {
			dispatch((prev) => updateTab(prev, tab.tabId, { state: event.state as AgentWorkspaceTab['state'] }));
		}
		setMessages((prev) => {
			const id = event.eventId || event.messageId || `${event.type}-${event.cursor || Date.now()}-${prev.length}`;
			if (prev.some((item) => item.id === id)) return prev;
			const item: MessageItem = {
				id,
				type: event.type,
				text: event.text,
				toolName: event.toolName,
				toolInput: event.toolInput,
				toolOutput: event.toolOutput,
				state: event.state,
				cursor: event.cursor,
			};
			return [...prev, item];
		});
	}).then(({ channelId }) => {
		if (!active) return;
		currentAgentChannelIdRef.current = channelId;
	}).catch((err) => {
      if (active) {
        console.error('Failed to open agent channel:', err);
      }
    });

    return () => {
      active = false;
      agentUnsubRef.current?.();
      if (currentAgentChannelIdRef.current) {
        runtime.closeChannel(currentAgentChannelIdRef.current);
      }
    };
  }, [tab?.agentSessionId, connection]);

  // Subscribe to underlying Terminal PTY stream
  useEffect(() => {
    if (!tab || !connection || !daemonChannelRef.current) return;
    const daemon = daemonChannelRef.current;
    setTerminalOutput('');
    const decoder = new TextDecoder();
    ptyUnsubRef.current = daemon.subscribe(tab.terminalSessionId, (msg) => {
      if (msg.type === 'pty.output') {
        const chunk = decoder.decode(decodeBase64(msg.data), { stream: true });
        if (chunk) setTerminalOutput((prev) => prev + chunk);
      }
    });

    return () => {
      ptyUnsubRef.current?.();
    };
  }, [tab?.terminalSessionId, connection]);

  // Keyboard inset handling for mobile
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const show = (event: { endCoordinates: { screenY: number } }) =>
      setKeyboardInset(Math.max(0, windowHeight - event.endCoordinates.screenY - insets.bottom));
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

  const openPaneSwitcher = useCallback(async () => {
    if (!api) return;
    try {
      setPanes((await api.runtimeSnapshot()).topology);
      paneSheetRef.current?.present();
    } catch (error) {
      Alert.alert('Could not load panes', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [api]);

	const selectPane = useCallback((pane: TmuxPane) => {
		if (!tab || pane.terminalSessionId === tab.terminalSessionId) return;
		const terminalTab: TerminalWorkspaceTab = {
			tabId: Crypto.randomUUID(), daemonId: tab.daemonId, kind: 'terminal', title: pane.windowName || 'Shell',
			createdAt: Date.now(), lastActiveAt: Date.now(), pinned: false, remoteSessionId: pane.terminalSessionId,
			state: 'running', tmuxPaneId: pane.paneId,
		};
		dispatch((previous) => addTab(previous, terminalTab));
		router.push({ pathname: '/terminal/[id]', params: { id: terminalTab.tabId } });
	}, [dispatch, tab]);

  const sendPrompt = useCallback(async () => {
    if (!promptText.trim() || !api || !tab || sending) return;
    const text = promptText.trim();
    setSending(true);
    try {
      await api.submitAgentPrompt(tab.agentSessionId, text);
      setPromptText('');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('needs_terminal')) {
        Alert.alert(
          'Terminal Interaction Required',
          'OMP is currently running in TUI mode. Switched to terminal view so you can interact directly.',
          [{ text: 'OK', onPress: () => setViewMode('terminal') }],
        );
        setViewMode('terminal');
      } else {
        Alert.alert('Prompt Failed', msg);
      }
    } finally {
      setSending(false);
    }
  }, [promptText, api, tab, sending]);

  const abortAgent = useCallback(async () => {
    if (!api || !tab) return;
    try {
      await api.abortAgent(tab.agentSessionId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('needs_terminal')) {
        Alert.alert(
          'Terminal Interaction Required',
          'OMP is running in TUI mode. Switch to terminal view to send Ctrl+C directly.',
          [{ text: 'Switch to Terminal', onPress: () => setViewMode('terminal') }, { text: 'Cancel', style: 'cancel' }],
        );
      } else {
        Alert.alert('Abort Failed', msg);
      }
    }
  }, [api, tab]);

  const close = useCallback(() => {
    if (!tab) return;
    Alert.alert('Close Agent Session?', 'This will close the agent session and underlying terminal.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Close',
        style: 'destructive',
        onPress: async () => {
          agentUnsubRef.current?.();
          ptyUnsubRef.current?.();
          if (currentAgentChannelIdRef.current && runtimeChannelRef.current) {
            runtimeChannelRef.current.closeChannel(currentAgentChannelIdRef.current);
          }
          if (api) {
            try {
              await api.closeSession(tab.terminalSessionId);
            } catch {}
          }
          if (daemonChannelRef.current) {
            daemonChannelRef.current.closeChannel(tab.terminalSessionId);
          }
          closeTab(tab.tabId);
          router.replace('/');
        },
      },
    ]);
  }, [tab, api, closeTab]);

  const stateColor = useMemo(() => {
    switch (tab?.state) {
      case 'working':
        return '#D19A2C';
      case 'idle':
        return '#46B86B';
      case 'needsYou':
        return '#F59E0B';
      case 'exited':
        return '#6B7280';
      default:
        return '#9CA3AF';
    }
  }, [tab?.state]);

  const renderMessage = ({ item }: { item: MessageItem }) => {
    switch (item.type) {
      case 'message.user':
        return (
          <View style={styles.userBubble}>
            <Text style={styles.userLabel}>User</Text>
            <Text style={styles.userText}>{item.text}</Text>
          </View>
        );
      case 'message.assistant':
        return (
          <View style={styles.assistantBubble}>
            <Text style={styles.assistantLabel}>Agent</Text>
            <Text style={styles.assistantText}>{item.text}</Text>
          </View>
        );
      case 'tool.call':
        return (
          <View style={styles.toolBubble}>
            <View style={styles.toolHeader}>
              <Feather name="tool" size={14} color="#A78BFA" />
              <Text style={styles.toolName}>{item.toolName}</Text>
            </View>
            {item.toolInput != null && (
              <Text style={styles.toolPayload} numberOfLines={4}>
                {typeof item.toolInput === 'string' ? item.toolInput : JSON.stringify(item.toolInput, null, 2)}
              </Text>
            )}
          </View>
        );
      case 'tool.result':
        return (
          <View style={styles.toolResultBubble}>
            <View style={styles.toolHeader}>
              <Feather name="check-circle" size={14} color="#46B86B" />
              <Text style={styles.toolResultName}>{item.toolName || 'Tool Result'}</Text>
            </View>
            {item.text ? (
              <Text style={styles.toolResultPayload} numberOfLines={4}>
                {item.text}
              </Text>
            ) : null}
          </View>
        );
      case 'state.change':
        return (
          <View style={styles.systemBubble}>
            <Text style={styles.systemText}>Status changed to: {item.state}</Text>
          </View>
        );
      default:
        return item.text ? (
          <View style={styles.systemBubble}>
            <Text style={styles.systemText}>{item.text}</Text>
          </View>
        ) : null;
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={styles.header}>
        <Pressable accessibilityLabel="Back" style={styles.headerIcon} onPress={() => router.replace('/')}>
          <Feather name="arrow-left" size={20} color="#F0F0F0" />
        </Pressable>
        <View style={styles.headerTitleContainer}>
          <View style={styles.headerTitleRow}>
            <Text style={styles.title} numberOfLines={1}>{tab?.title || 'Agent'}</Text>
            <View style={[styles.statusDot, { backgroundColor: stateColor }]} />
            <Text style={[styles.statusText, { color: stateColor }]}>{tab?.state || 'idle'}</Text>
          </View>
        </View>

        {/* View switcher: Chat / Terminal */}
        <View style={styles.viewSwitcher}>
          <Pressable
            accessibilityLabel="Chat View"
            style={[styles.switcherButton, viewMode === 'chat' && styles.switcherButtonActive]}
            onPress={() => setViewMode('chat')}
          >
            <Feather name="message-square" size={16} color={viewMode === 'chat' ? '#0A0A0A' : '#A0A0A0'} />
          </Pressable>
          <Pressable
            accessibilityLabel="Terminal View"
            style={[styles.switcherButton, viewMode === 'terminal' && styles.switcherButtonActive]}
            onPress={() => setViewMode('terminal')}
          >
            <Feather name="terminal" size={16} color={viewMode === 'terminal' ? '#0A0A0A' : '#A0A0A0'} />
          </Pressable>
        </View>

        <Pressable accessibilityLabel="Switch pane" style={styles.headerIcon} onPress={() => void openPaneSwitcher()}>
          <Feather name="columns" size={18} color="#D19A2C" />
        </Pressable>

        <Pressable accessibilityLabel="Abort" style={styles.headerIcon} onPress={abortAgent}>
          <Feather name="slash" size={18} color="#EF4444" />
        </Pressable>
        <Pressable accessibilityLabel="Close" style={styles.headerIcon} onPress={close}>
          <Feather name="x" size={20} color="#888" />
        </Pressable>
      </View>

      {/* Content Area */}
      {viewMode === 'chat' ? (
        <KeyboardAvoidingView
          style={styles.chatContainer}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 56 : 0}
        >
          <FlatList
            ref={flatListRef}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={renderMessage}
            contentContainerStyle={styles.messageList}
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Feather name="cpu" size={36} color="#4B5563" />
                <Text style={styles.emptyTitle}>Agent Chat</Text>
                <Text style={styles.emptySubtitle}>Live transcript streaming from OMP session</Text>
              </View>
            }
          />

          {/* Prompt Bar */}
          <View style={styles.promptBar}>
            <TextInput
              style={styles.promptInput}
              placeholder="Send instruction to agent..."
              placeholderTextColor="#6B7280"
              value={promptText}
              onChangeText={setPromptText}
              multiline
              maxLength={4000}
            />
            <Pressable
              accessibilityLabel="Send Prompt"
              style={[styles.sendButton, (!promptText.trim() || sending) && styles.sendButtonDisabled]}
              onPress={sendPrompt}
              disabled={!promptText.trim() || sending}
            >
              {sending ? (
                <ActivityIndicator size="small" color="#0A0A0A" />
              ) : (
                <Feather name="send" size={18} color="#0A0A0A" />
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      ) : (
        <View style={styles.terminalContainer}>
          {connection && tab ? (
            <Terminal
              ref={terminalRef}
              output={terminalOutput}
              onInput={(data) => shortcutKeyboardRef.current?.input(data)}
              onResize={(cols, rows) =>
                tab && daemonChannelRef.current?.send({ channelId: tab.terminalSessionId, kind: 'terminal', type: 'pty.resize', cols, rows })
              }
            />
          ) : (
            <Text style={styles.connectingText}>Connecting…</Text>
          )}
          <ShortcutKeyboard
            ref={shortcutKeyboardRef}
            onInput={(data) =>
              tab && daemonChannelRef.current?.send({ channelId: tab.terminalSessionId, kind: 'terminal', type: 'pty.input', data: base64(utf8(data)) })
            }
            bottomInset={insets.bottom}
            keyboardInset={keyboardInset}
            onCopy={() => terminalRef.current?.copy()}
            onPaste={() => terminalRef.current?.paste()}
            onSelectAll={() => terminalRef.current?.selectAll()}
            onExpand={() => { Keyboard.dismiss(); terminalRef.current?.blur(); }}
            onCollapse={() => terminalRef.current?.focus()}
          />
        </View>
      )}
      <TmuxPaneSheet ref={paneSheetRef} panes={panes} currentPaneId={tab?.tmuxPaneId} onSelect={selectPane} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0A0A0A' },
  header: {
    minHeight: 56,
    paddingHorizontal: 12,
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    borderBottomWidth: 1,
    borderColor: '#262626',
    backgroundColor: '#121212',
  },
  headerIcon: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  },
  headerTitleContainer: { flex: 1, justifyContent: 'center' },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { color: '#F0F0F0', fontSize: 16, fontWeight: '700' },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
  viewSwitcher: {
    flexDirection: 'row',
    backgroundColor: '#1E1E1E',
    borderRadius: 6,
    padding: 2,
    borderWidth: 1,
    borderColor: '#333',
  },
  switcherButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
  },
  switcherButtonActive: {
    backgroundColor: '#D19A2C',
  },
  chatContainer: { flex: 1 },
  messageList: { padding: 14, gap: 12 },
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, gap: 10 },
  emptyTitle: { color: '#D1D5DB', fontSize: 18, fontWeight: '700' },
  emptySubtitle: { color: '#6B7280', fontSize: 14, textAlign: 'center' },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#1E3A5F',
    borderRadius: 12,
    padding: 12,
    maxWidth: '85%',
    borderWidth: 1,
    borderColor: '#2563EB',
  },
  userLabel: { color: '#93C5FD', fontSize: 11, fontWeight: '700', marginBottom: 4 },
  userText: { color: '#F0F0F0', fontSize: 14, lineHeight: 20 },
  assistantBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#1E1E1E',
    borderRadius: 12,
    padding: 12,
    maxWidth: '85%',
    borderWidth: 1,
    borderColor: '#333333',
  },
  assistantLabel: { color: '#A78BFA', fontSize: 11, fontWeight: '700', marginBottom: 4 },
  assistantText: { color: '#E5E7EB', fontSize: 14, lineHeight: 20 },
  toolBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#18181B',
    borderRadius: 8,
    padding: 10,
    maxWidth: '90%',
    borderLeftWidth: 3,
    borderLeftColor: '#A78BFA',
    borderWidth: 1,
    borderColor: '#27272A',
    gap: 4,
  },
  toolHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  toolName: { color: '#C4B5FD', fontSize: 13, fontWeight: '600' },
  toolPayload: { color: '#9CA3AF', fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  toolResultBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#141E18',
    borderRadius: 8,
    padding: 10,
    maxWidth: '90%',
    borderLeftWidth: 3,
    borderLeftColor: '#46B86B',
    borderWidth: 1,
    borderColor: '#1C2E22',
    gap: 4,
  },
  toolResultName: { color: '#86EFAC', fontSize: 13, fontWeight: '600' },
  toolResultPayload: { color: '#A7F3D0', fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  systemBubble: { alignSelf: 'center', paddingVertical: 4, paddingHorizontal: 10 },
  systemText: { color: '#6B7280', fontSize: 12, fontStyle: 'italic' },
  promptBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 10,
    backgroundColor: '#121212',
    borderTopWidth: 1,
    borderColor: '#262626',
    gap: 8,
  },
  promptInput: {
    flex: 1,
    backgroundColor: '#1E1E1E',
    color: '#F0F0F0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    maxHeight: 100,
    borderWidth: 1,
    borderColor: '#333333',
  },
  sendButton: {
    width: 40,
    height: 40,
    backgroundColor: '#D19A2C',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: { opacity: 0.4 },
  terminalContainer: { flex: 1 },
  connectingText: { flex: 1, textAlign: 'center', textAlignVertical: 'center', color: '#6B7280', fontSize: 14 },
});
