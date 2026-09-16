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
import { ModelThinkingSheet, type ModelThinkingSheetHandle } from '../../src/components/ModelThinkingSheet';
import { ShortcutKeyboard, type ShortcutKeyboardHandle } from '../../src/components/ShortcutKeyboard';
import { AgenticRemoteAPI, APIError } from '../../src/lib/api';
import { getConnection, loadConnections, type Connection } from '../../src/lib/connection';
import { createDaemonChannel, type DaemonChannel } from '../../src/lib/daemon-channel';
import { createRuntimeChannel, type RuntimeChannel } from '../../src/lib/runtime-channel';
import { base64, decodeBase64, utf8 } from '../../src/lib/bytes';
import { addTab, updateTab, useTabStore } from '../../src/lib/tabs/tab-store';
import type { AgentWorkspaceTab, FilesWorkspaceTab, TerminalWorkspaceTab } from '../../src/lib/tabs/types';
import type { AgentCapability, AgentEvent, AgentModelInfo, TmuxPane } from '../../src/protocol';

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

function toMessageItem(event: AgentEvent): MessageItem | null {
  const id = event.eventId || event.messageId;
  if (!id) return null;
  return {
    id,
    type: event.type,
    text: event.text,
    toolName: event.toolName,
    toolInput: event.toolInput,
    toolOutput: event.toolOutput,
    state: event.state,
    cursor: event.cursor,
  };
}

function eventsToMessageItems(events: AgentEvent[]): MessageItem[] {
  const seen = new Set<string>();
  const items: MessageItem[] = [];
  for (const event of events) {
    const item = toMessageItem(event);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

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
  const [capabilities, setCapabilities] = useState<AgentCapability[]>([]);
  const [terminalOutput, setTerminalOutput] = useState('');
  const [agentCwd, setAgentCwd] = useState<string>(tab?.cwd ?? '');
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [currentModel, setCurrentModel] = useState<AgentModelInfo | undefined>();
  const [currentThinking, setCurrentThinking] = useState<string | undefined>();
  const [availableModels, setAvailableModels] = useState<AgentModelInfo[]>([]);
  const [availableThinking, setAvailableThinking] = useState<string[]>([]);
  const [loadingModel, setLoadingModel] = useState(false);
  const [loadingThinking, setLoadingThinking] = useState(false);

  const { height: windowHeight } = useWindowDimensions();
  const terminalRef = useRef<TerminalHandle>(null);
  const shortcutKeyboardRef = useRef<ShortcutKeyboardHandle>(null);
  const modelThinkingSheetRef = useRef<ModelThinkingSheetHandle>(null);
  const daemonChannelRef = useRef<DaemonChannel | null>(null);
  const runtimeChannelRef = useRef<RuntimeChannel | null>(null);
  const ptyUnsubRef = useRef<(() => void) | null>(null);
  const currentAgentChannelIdRef = useRef<string | null>(null);
  const flatListRef = useRef<FlatList>(null);
  const [panes, setPanes] = useState<TmuxPane[]>([]);
  const paneSheetRef = useRef<TmuxPaneSheetHandle>(null);

  const api = useMemo(() => connection && new AgenticRemoteAPI(connection), [connection]);

  const openFiles = useCallback(() => {
    if (!tab) return;
    const tabId = Crypto.randomUUID();
    const targetCwd = agentCwd || tab.cwd || '';
    const filesTab: FilesWorkspaceTab = {
      tabId,
      daemonId: tab.daemonId,
      kind: 'files',
      title: 'Files',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      pinned: false,
      cwd: targetCwd,
    };
    dispatch((previous) => addTab(previous, filesTab));
    router.push({ pathname: '/files/[id]', params: { id: tabId } });
  }, [tab, agentCwd, dispatch]);
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
  // Subscribe to Agent Runtime Events and Bootstrap History
  useEffect(() => {
    const runtime = runtimeChannelRef.current;
    if (!tab?.agentSessionId || !runtime || !api) return;
    let active = true;
    let isSyncing = false;
    const eventBuffer: AgentEvent[] = [];
    void api.agent(tab.agentSessionId).then((agent) => {
      if (!active) return;
      setCapabilities(agent.capabilities);
      if (agent.model) setCurrentModel(agent.model);
      if (agent.thinking) setCurrentThinking(agent.thinking);
      if (agent.availableModels) setAvailableModels(agent.availableModels);
      if (agent.availableThinking) setAvailableThinking(agent.availableThinking);
      if (agent.cwd !== undefined) {
        setAgentCwd(agent.cwd);
      }
      dispatch((prev) => updateTab(prev, tab.tabId, { state: agent.state, cwd: agent.cwd }));
    }).catch(() => {});

    const loadAndReplaceHistory = async (): Promise<number> => {
      isSyncing = true;
      eventBuffer.length = 0;
      try {
        const history = await api.agentHistory(tab.agentSessionId);
        if (!active) return history.cursor ?? 0;

        for (let i = history.events.length - 1; i >= 0; i--) {
          if (history.events[i].state) {
            dispatch((prev) => updateTab(prev, tab.tabId, { state: history.events[i].state as AgentWorkspaceTab['state'] }));
            break;
          }
        }

        const baseItems = eventsToMessageItems(history.events);
        const seen = new Set<string>(baseItems.map((item) => item.id));

        const mergedItems = [...baseItems];
        for (const bufferedEvent of eventBuffer) {
          const item = toMessageItem(bufferedEvent);
          if (item && !seen.has(item.id)) {
            seen.add(item.id);
            mergedItems.push(item);
          }
        }

        setMessages(mergedItems);
        return history.cursor ?? 0;
      } finally {
        isSyncing = false;
        eventBuffer.length = 0;
      }
    };

    const handleEvent = (event: AgentEvent) => {
      if (!active) return;
      if (event.capabilities) {
        setCapabilities(event.capabilities);
      }
      if (event.model) setCurrentModel(event.model);
      if (event.thinking) setCurrentThinking(event.thinking);
      if (event.availableModels) setAvailableModels(event.availableModels);
      if (event.availableThinking) setAvailableThinking(event.availableThinking);
      if (event.state) {
        dispatch((prev) => updateTab(prev, tab.tabId, { state: event.state as AgentWorkspaceTab['state'] }));
      }
      if (isSyncing) {
        eventBuffer.push(event);
        return;
      }
      const item = toMessageItem(event);
      if (!item) return;
      setMessages((prev) => {
        if (prev.some((m) => m.id === item.id)) {
          return prev;
        }
        return [...prev, item];
      });
    };

    const handleCursorExpired = async (): Promise<number> => {
      // ponytail: bounded backoff retry for transient history recovery
      const maxAttempts = 3;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (!active) return 0;
        try {
          return await loadAndReplaceHistory();
        } catch (err) {
          if (attempt === maxAttempts - 1 || !active) throw err;
          await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 2000)));
        }
      }
      return 0;
    };

    void (async () => {
      let initialCursor = 0;
      try {
        initialCursor = await loadAndReplaceHistory();
      } catch (err) {
        console.error('Failed to bootstrap agent history:', err);
      }
      if (!active) return;
      try {
        const { channelId } = await runtime.openAgentChannel(
          tab.agentSessionId,
          initialCursor,
          handleEvent,
          handleCursorExpired,
        );
        if (!active) {
          runtime.closeChannel(channelId);
          return;
        }
        currentAgentChannelIdRef.current = channelId;
      } catch (err) {
        if (active) {
          console.error('Failed to open agent channel:', err);
        }
      }
    })();

    return () => {
      active = false;
      if (currentAgentChannelIdRef.current) {
        runtime.closeChannel(currentAgentChannelIdRef.current);
        currentAgentChannelIdRef.current = null;
      }
    };
  }, [tab?.agentSessionId, connection, api, dispatch, tab?.tabId]);

  // Subscribe to underlying Terminal PTY stream
  useEffect(() => {
    if (!tab || !connection || !daemonChannelRef.current) return;
    const daemon = daemonChannelRef.current;
    setTerminalOutput('');
    let decoder = new TextDecoder();
    let lastSeq = -1;
    ptyUnsubRef.current = daemon.subscribe(tab.terminalSessionId, (msg) => {
      if (msg.type === 'pty.baseline') {
        decoder = new TextDecoder();
        lastSeq = msg.seq;
        setTerminalOutput(decoder.decode(decodeBase64(msg.data), { stream: true }));
      } else if (msg.type === 'pty.output' && msg.seq > lastSeq) {
        lastSeq = msg.seq;
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
    if (!promptText.trim() || !api || !tab || sending || !capabilities.some((capability) => capability.name === 'prompt' && capability.enabled)) return;
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
  }, [promptText, api, tab, sending, capabilities]);
  const abortAgent = useCallback(async () => {
    if (!api || !tab || !capabilities.some((capability) => capability.name === 'abort' && capability.enabled)) return;
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
  }, [api, tab, capabilities]);

  const abortEnabled = capabilities.some((c) => c.name === 'abort' && c.enabled);
  const modelEnabled = capabilities.some((c) => c.name === 'model' && c.enabled);
  const thinkingEnabled = capabilities.some((c) => c.name === 'thinking' && c.enabled);

  const handleSelectModel = useCallback(
    async (modelId: string) => {
      if (!tab || !api) return;
      const prevModel = currentModel;
      const target =
        availableModels.find((m) => m.id === modelId) ||
        (prevModel && prevModel.id === modelId
          ? prevModel
          : { id: modelId, name: modelId, provider: '' });
      setCurrentModel(target);
      setLoadingModel(true);
      try {
        await api.setAgentModel(tab.agentSessionId, modelId);
      } catch (error) {
        setCurrentModel(prevModel);
        const msg = error instanceof Error ? error.message : String(error);
        Alert.alert('Model Change Failed', msg);
      } finally {
        setLoadingModel(false);
      }
    },
    [tab, api, currentModel, availableModels],
  );

  const handleSelectThinking = useCallback(
    async (level: string) => {
      if (!tab || !api) return;
      const prevThinking = currentThinking;
      setCurrentThinking(level);
      setLoadingThinking(true);
      try {
        await api.setAgentThinking(tab.agentSessionId, level);
      } catch (error) {
        setCurrentThinking(prevThinking);
        const msg = error instanceof Error ? error.message : String(error);
        Alert.alert('Thinking Level Change Failed', msg);
      } finally {
        setLoadingThinking(false);
      }
    },
    [tab, api, currentThinking],
  );

  const close = useCallback(() => {
    if (!tab) return;
    ptyUnsubRef.current?.();
    if (currentAgentChannelIdRef.current && runtimeChannelRef.current) {
      runtimeChannelRef.current.closeChannel(currentAgentChannelIdRef.current);
      currentAgentChannelIdRef.current = null;
    }
    closeTab(tab.tabId);
    if (daemonChannelRef.current) {
      daemonChannelRef.current.closeChannel(tab.terminalSessionId);
    }
    router.replace('/');
  }, [tab, closeTab]);

  const terminateAgent = useCallback(() => {
    if (!tab || !api) return;
    Alert.alert(
      'Terminate Agent?',
      'This will kill the agent process and underlying terminal. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Terminate',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.terminateAgent(tab.agentSessionId);
              ptyUnsubRef.current?.();
              if (currentAgentChannelIdRef.current && runtimeChannelRef.current) {
                runtimeChannelRef.current.closeChannel(currentAgentChannelIdRef.current);
                currentAgentChannelIdRef.current = null;
              }
              if (daemonChannelRef.current) {
                daemonChannelRef.current.closeChannel(tab.terminalSessionId);
              }
              closeTab(tab.tabId);
              router.replace('/');
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              Alert.alert(
                'Termination Failed',
                `Failed to terminate agent: ${msg}\n\nThe agent may still be running remotely. You can retry.`,
                [
                  { text: 'Retry', onPress: () => terminateAgent() },
                  { text: 'Dismiss', style: 'cancel' },
                ],
              );
            }
          },
        },
      ],
    );
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
  const promptEnabled = capabilities.some((capability) => capability.name === 'prompt' && capability.enabled);

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
        {abortEnabled && (
          <Pressable accessibilityLabel="Abort" style={styles.headerIcon} onPress={abortAgent}>
            <Feather name="slash" size={18} color="#EF4444" />
          </Pressable>
        )}
        {(modelEnabled || thinkingEnabled || Boolean(currentModel)) && (
          <Pressable
            accessibilityLabel="Model and Thinking"
            style={styles.headerIcon}
            onPress={() => modelThinkingSheetRef.current?.present()}
          >
            <Feather name="cpu" size={18} color="#818CF8" />
          </Pressable>
        )}
        <Pressable accessibilityLabel="Open Files" style={styles.headerIcon} onPress={openFiles}>
          <Feather name="folder" size={18} color="#46B8C4" />
        </Pressable>
        <Pressable accessibilityLabel="Terminate Agent" style={styles.headerIcon} onPress={terminateAgent}>
          <Feather name="power" size={18} color="#DC2626" />
        </Pressable>
        <Pressable accessibilityLabel="Close View" style={styles.headerIcon} onPress={close}>
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
          {tab?.state === 'needsYou' && (
            <View style={styles.needsYouBanner} accessibilityLabel="Needs Approval Banner">
              <View style={styles.needsYouContent}>
                <Feather name="alert-triangle" size={18} color="#F59E0B" />
                <View style={styles.needsYouTextCol}>
                  <Text style={styles.needsYouTitle}>Approval Required</Text>
                  <Text style={styles.needsYouSubtitle}>
                    Agent is waiting for terminal input or tool approval.
                  </Text>
                </View>
              </View>
              <Pressable
                accessibilityLabel="Open Terminal"
                style={styles.needsYouBtn}
                onPress={() => setViewMode('terminal')}
              >
                <Feather name="terminal" size={14} color="#0A0A0A" />
                <Text style={styles.needsYouBtnText}>Open Terminal</Text>
              </Pressable>
            </View>
          )}
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

          {promptEnabled ? (
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
          ) : (
            <Pressable accessibilityLabel="Open Terminal to interact" style={styles.terminalFallback} onPress={() => setViewMode('terminal')}>
              <Feather name="terminal" size={16} color="#D19A2C" />
              <Text style={styles.terminalFallbackText}>Open Terminal to interact</Text>
            </Pressable>
          )}
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
      <ModelThinkingSheet
        ref={modelThinkingSheetRef}
        currentModel={currentModel}
        currentThinking={currentThinking}
        availableModels={availableModels}
        availableThinking={availableThinking}
        modelEnabled={modelEnabled}
        thinkingEnabled={thinkingEnabled}
        onSelectModel={handleSelectModel}
        onSelectThinking={handleSelectThinking}
        loadingModel={loadingModel}
        loadingThinking={loadingThinking}
      />
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
  terminalFallback: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 14, backgroundColor: '#121212', borderTopWidth: 1, borderColor: '#262626' },
  terminalFallbackText: { color: '#D1D5DB', fontSize: 14, fontWeight: '600' },
  terminalContainer: { flex: 1 },
  connectingText: { flex: 1, textAlign: 'center', textAlignVertical: 'center', color: '#6B7280', fontSize: 14 },
  needsYouBanner: {
    backgroundColor: '#2A1F05',
    borderColor: '#F59E0B',
    borderWidth: 1,
    borderRadius: 8,
    margin: 12,
    marginBottom: 0,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  needsYouContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  needsYouTextCol: {
    flex: 1,
    gap: 2,
  },
  needsYouTitle: {
    color: '#F59E0B',
    fontSize: 13,
    fontWeight: '700',
  },
  needsYouSubtitle: {
    color: '#D1D5DB',
    fontSize: 11,
  },
  needsYouBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#F59E0B',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  needsYouBtnText: {
    color: '#0A0A0A',
    fontSize: 12,
    fontWeight: '700',
  },
});
