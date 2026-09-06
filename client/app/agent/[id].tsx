import { useEffect, useRef, useState, useReducer } from 'react';
import { StyleSheet, Text, View, Pressable, ScrollView, TextInput } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import { getConnection, loadConnections, type Connection } from '../../src/lib/connection';
import { useTabStore, updateTab } from '../../src/lib/tabs/tab-store';
import { createDaemonChannel, type DaemonChannel } from '../../src/lib/daemon-channel';
import type { AgentWorkspaceTab, DaemonId } from '../../src/lib/tabs/types';
import type { RpcCommand, RpcExtensionUIResponse, AgentSessionEvent } from '../../src/lib/tabs/rpc-types';
import { initialOmpState, ompReducer } from '../../src/lib/agent/omp-adapter';
import { AgentMessageList } from '../../src/components/agent/AgentMessageList';
import { ApprovalOverlay } from '../../src/components/agent/ApprovalOverlay';

export default function AgentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { state: tabStoreState, dispatch: tabStoreDispatch } = useTabStore();
  const tab = tabStoreState.tabs.find((t): t is AgentWorkspaceTab => t.tabId === id && t.kind === 'agent') ?? null;
  const [connection, setConnection] = useState<Connection | null>(null);
  const channelRef = useRef<DaemonChannel | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  
  const [state, dispatch] = useReducer(ompReducer, initialOmpState);
  const [input, setInput] = useState('');

  useEffect(() => {
    if (!tab) return;
    loadConnections().then((store) => {
      const conn = getConnection(store, tab.daemonId);
      if (conn) {
        setConnection(conn);
        channelRef.current = createDaemonChannel(conn);
        unsubscribeRef.current = channelRef.current.subscribe(tab.remoteSessionId, (msg) => {
          if ('type' in msg && msg.kind === 'agent') { // narrow
            // RpcResponse could be mixed in, but we assume the mock daemon primarily pushes AgentSessionEvent.
            // In a real app we'd discriminate RpcResponse vs Event. The reducer safely avoids blowing up on RpcResponse.
            dispatch(msg as unknown as AgentSessionEvent);
            if (msg.type === 'extension_ui_request') {
              tabStoreDispatch(prev => updateTab(prev, tab.tabId, { pendingApproval: msg }));
            }
          }
        });
      }
    });
    return () => unsubscribeRef.current?.();
  }, [tab?.tabId]);

  const sendCommand = (cmd: RpcCommand) => {
    if (tab && channelRef.current) {
      channelRef.current.send({ channelId: tab.remoteSessionId, kind: 'agent', ...cmd });
    }
  };

  const handleSubmit = () => {
    if (!input.trim()) return;
    sendCommand({ type: 'prompt', message: input });
    setInput('');
  };

  const handleApprovalRespond = (response: RpcExtensionUIResponse) => {
    if (!tab) return;
    sendCommand(response);
    tabStoreDispatch(prev => updateTab(prev, tab.tabId, { pendingApproval: null }));
  };

  if (!connection || !tab) {
    return <SafeAreaView style={styles.screen}><Text style={styles.text}>Loading Agent Session...</Text></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.topbar}>
        <Pressable accessibilityLabel="Back" style={styles.back} onPress={() => router.back()}>
          <Feather name="arrow-left" size={20} color="#F0F0F0" />
        </Pressable>
        <Text style={styles.title}>{tab.title || 'omp'}</Text>
        <View style={styles.chip}>
          <Text style={styles.chipText}>{state.thinkingLevel || 'auto'}</Text>
        </View>
      </View>
      
      <ApprovalOverlay request={tab.pendingApproval} onRespond={handleApprovalRespond} />
      
      <ScrollView style={styles.content} contentContainerStyle={{ paddingBottom: 24 }}>
        <AgentMessageList turns={state.turns} />
      </ScrollView>

      <View style={styles.inputArea}>
        <TextInput
          style={styles.input}
          placeholder="Message OMP..."
          placeholderTextColor="#888"
          value={input}
          onChangeText={setInput}
          onSubmitEditing={handleSubmit}
          returnKeyType="send"
        />
        <Pressable style={styles.sendBtn} onPress={handleSubmit}>
          <Feather name="send" size={16} color="#0A0A0A" />
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0A0A0A' },
  topbar: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12, borderBottomWidth: 1, borderColor: '#262626' },
  back: { padding: 6 },
  title: { color: '#F0F0F0', fontSize: 17, fontWeight: '700', flex: 1 },
  chip: { backgroundColor: '#333', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 },
  chipText: { color: '#d1d1d1', fontSize: 11, fontWeight: '600' },
  text: { color: '#888', textAlign: 'center', marginTop: 40 },
  content: { flex: 1 },
  inputArea: { flexDirection: 'row', padding: 12, gap: 12, borderTopWidth: 1, borderColor: '#262626', backgroundColor: '#181818', alignItems: 'center' },
  input: { flex: 1, backgroundColor: '#262626', color: '#F0F0F0', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  sendBtn: { backgroundColor: '#D19A2C', width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center' }
});
