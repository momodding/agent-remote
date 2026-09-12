import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Crypto from 'expo-crypto';
import Feather from '@expo/vector-icons/Feather';

import { AgenticRemoteAPI, authenticatePairing } from '../src/lib/api';
import { deleteConnection, getConnection, loadConnections, saveConnection, updateConnection, type Connection, type ConnectionStore } from '../src/lib/connection';
import { disposeRuntimeChannel } from '../src/lib/runtime-channel';
import { reconcileDaemon, type DaemonRuntime } from '../src/lib/runtime-reconcile';
import type { PairingPayload } from '../src/protocol';
import { buildSessionSurfaces, type SessionSurface } from '../src/lib/session-surface';
import { PairingSheet } from '../src/components/PairingSheet';
import { ConnectionSheet } from '../src/components/ConnectionSheet';
import { useTabStore } from '../src/lib/tabs/tab-store';
import { createDaemonChannel, disposeDaemonChannel } from '../src/lib/daemon-channel';
import type { DaemonId, TabKind, WorkspaceTab } from '../src/lib/tabs/types';

const diagnosticsInitial = ['Resolving endpoint...', 'Initiating TLS Handshake...', 'Validating Certificate Fingerprint...', 'Executing Auth-v2 Challenge...', 'Session Established'];


export default function TabDeckScreen() {
  const { state, dispatch, closeTab, activateTab } = useTabStore();
	const [store, setStore] = useState<ConnectionStore>({ connections: [] });
	const [runtimes, setRuntimes] = useState<Record<string, DaemonRuntime>>({});
	// Manage UI connection selection merely for opening daemons view to correct item
	const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [pairingOpen, setPairingOpen] = useState(false);
	const [daemonsOpen, setDaemonsOpen] = useState(false);
	const [diagnostics, setDiagnostics] = useState<string[]>([]);
	const { width } = useWindowDimensions();
	const columns = width < 640 ? 1 : Math.max(1, Math.min(4, Math.floor(width / 280)));

  useEffect(() => {
    void loadConnections()
      .then(async (loaded) => {
        setStore(loaded);
        setSelectedHostId(loaded.connections[0]?.hostId ?? null);
      })
      .catch(() => Alert.alert('Could not load daemon connections'))
      .finally(() => setLoading(false));
  }, []);

	useEffect(() => {
		let active = true;
		const cleanups: Array<() => void> = [];
		for (const connection of store.connections) {
			void reconcileDaemon(connection, (runtime) => {
				if (active) setRuntimes((current) => ({ ...current, [connection.hostId]: runtime }));
			}).then((cleanup) => {
				if (active) cleanups.push(cleanup);
				else cleanup();
			}).catch((error) => {
				if (active) setRuntimes((current) => ({ ...current, [connection.hostId]: { status: 'error', error: error instanceof Error ? error.message : 'Could not reconcile daemon' } }));
			});
		}
		return () => {
			active = false;
			for (const cleanup of cleanups) cleanup();
		};
	}, [store.connections]);

  const connect = async (payload: PairingPayload, clientName: string, onStage?: (message: string) => void) => {
    setDiagnostics([]);
    try {
      const paired = await authenticatePairing(payload, clientName, (message) => {
        console.log('[pairing]', message);
        setDiagnostics((items) => [...items, message]);
        onStage?.(message);
      });
      const name = getConnection(store, paired.hostId)?.name ?? new URL(paired.endpoint).host;
      disposeDaemonChannel(paired.hostId);
      disposeRuntimeChannel(paired.hostId);
      const nextStore = await saveConnection({ ...paired, name });
      setStore(nextStore);
      setSelectedHostId(paired.hostId);
      setTimeout(() => setDiagnostics([]), 1500);
    } catch (error) {
      setDiagnostics([]);
      throw error;
    }
  };

  const removeDaemon = async (hostId: string) => {
    try {
      const wasSelected = hostId === selectedHostId;
      const nextStore = await deleteConnection(hostId);
      disposeDaemonChannel(hostId);
      disposeRuntimeChannel(hostId);
      setStore(nextStore);
      if (wasSelected) setSelectedHostId(nextStore.connections[0]?.hostId ?? null);
      
      // Close all tabs belonging to this daemon
      const daemonTabs = state.tabs.filter(t => t.daemonId === hostId);
      for (const t of daemonTabs) closeTab(t.tabId);
    } catch (error) {
      Alert.alert('Could not delete daemon', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  const saveEdit = async (originalHostId: string, replacement: Connection) => {
    const nextStore = await updateConnection(originalHostId, replacement);
    disposeDaemonChannel(originalHostId);
    disposeRuntimeChannel(originalHostId);
    if (replacement.hostId !== originalHostId) {
      disposeDaemonChannel(replacement.hostId);
      disposeRuntimeChannel(replacement.hostId);
    }
    setStore(nextStore);
    if (originalHostId === selectedHostId) setSelectedHostId(replacement.hostId);
  };

  
  const spawnTab = async (hostId: string, kind: TabKind) => {
    const connection = getConnection(store, hostId);
    if (!connection) {
      Alert.alert('Cannot open tab', 'Daemon connection not found in store.');
      return;
    }
    const channel = createDaemonChannel(connection);
    const tabId = Crypto.randomUUID();

    try {
      // ponyfill opening logic (some tabs need synchronous API call before opening async channel, defer specific setup logic to when the route actually mounts vs. doing it here)
      if (kind === 'terminal') {
        const remoteSessionId = await channel.openChannel('terminal', {});
        dispatch(prev => {
          const tabs = [...prev.tabs];
          tabs.push({
            tabId, daemonId: hostId, kind: 'terminal', title: 'Shell',
            createdAt: Date.now(), lastActiveAt: Date.now(), pinned: false,
            remoteSessionId, state: 'connecting'
          });
          return { ...prev, tabs, activeId: tabId };
        });
        router.push({ pathname: '/terminal/[id]', params: { id: tabId } });
      } else if (kind === 'files') {
        // Files is REST only, no openChannel call
        dispatch(prev => {
          const tabs = [...prev.tabs];
          tabs.push({
            tabId, daemonId: hostId, kind: 'files', title: 'Files',
            createdAt: Date.now(), lastActiveAt: Date.now(), pinned: false, cwd: ''
          });
          return { ...prev, tabs, activeId: tabId };
        });
        router.push({ pathname: '/files/[id]', params: { id: tabId } });
      } else if (kind === 'desktop') {
        const remoteSessionId = await channel.openChannel('desktop', {});
        dispatch(prev => {
          const tabs = [...prev.tabs];
          tabs.push({
            tabId, daemonId: hostId, kind: 'desktop', title: 'Desktop',
            createdAt: Date.now(), lastActiveAt: Date.now(), pinned: false,
            remoteSessionId, state: 'connecting'
          });
          return { ...prev, tabs, activeId: tabId };
        });
        // ponytail: router format change per native/web divergence isn't strictly necessary for deck state
        router.push({ pathname: '/desktop', params: { tabId } });
      } else if (kind === 'agent') {
        const api = new AgenticRemoteAPI(connection);
        const agentSession = await api.createAgent({ name: 'OMP Agent', args: [], cwd: '' });
        dispatch(prev => {
          const tabs = [...prev.tabs];
          tabs.push({
            tabId, daemonId: hostId, kind: 'agent', title: agentSession.adapter || 'OMP Agent',
            createdAt: Date.now(), lastActiveAt: Date.now(), pinned: false,
            agentSessionId: agentSession.id, terminalSessionId: agentSession.terminalSessionId,
            state: agentSession.state, view: 'chat'
          });
          return { ...prev, tabs, activeId: tabId };
        });
        router.push({ pathname: '/agent/[id]', params: { id: tabId } });
      }
	} catch (error) {
		Alert.alert('Could not open tab', error instanceof Error ? error.message : 'Daemon rejected the session request.');
	}
  };

	const openSurface = (daemonId: string, surface: SessionSurface) => {
		if (surface.tab) return openTab(surface.tab);
		const tabId = Crypto.randomUUID();
		if (surface.agent) {
			const agent = surface.agent;
			dispatch((prev) => ({ ...prev, tabs: [...prev.tabs, {
				tabId, daemonId, kind: 'agent', title: agent.adapter || 'OMP Agent',
				createdAt: Date.now(), lastActiveAt: Date.now(), pinned: false,
				agentSessionId: agent.id, terminalSessionId: agent.terminalSessionId, state: agent.state, view: 'chat',
			}], activeId: tabId }));
			router.push({ pathname: '/agent/[id]', params: { id: tabId } });
		} else if (surface.terminal) {
			const terminal = surface.terminal;
			dispatch((prev) => ({ ...prev, tabs: [...prev.tabs, {
				tabId, daemonId, kind: 'terminal', title: terminal.name || 'Shell',
				createdAt: Date.now(), lastActiveAt: Date.now(), pinned: false,
				remoteSessionId: terminal.id, state: terminal.exited ? 'exited' : 'running',
			}], activeId: tabId }));
			router.push({ pathname: '/terminal/[id]', params: { id: tabId } });
		}
	};
  
  const openTab = (tab: WorkspaceTab) => {
    activateTab(tab.tabId);
    if (tab.kind === 'terminal') router.push({ pathname: '/terminal/[id]', params: { id: tab.tabId } });
    else if (tab.kind === 'files') router.push({ pathname: '/files/[id]', params: { id: tab.tabId } });
    else if (tab.kind === 'desktop') router.push({ pathname: '/desktop', params: { tabId: tab.tabId } });
    else if (tab.kind === 'agent') router.push({ pathname: '/agent/[id]', params: { id: tab.tabId } });
  };

  if (loading) return <SafeAreaView style={styles.loading}><ActivityIndicator color="#D19A2C" /></SafeAreaView>;
  // ponytail: render the normal shell, put the empty state in the content area instead of replacing the whole screen

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.topbar}>
        <View style={styles.brand}>
          <Text style={styles.wordmark}>agenticRemote</Text>
        </View>
        <View style={styles.actions}>
          <Pressable accessibilityLabel="Daemons" style={styles.action} onPress={() => setDaemonsOpen(true)}>
            <Feather name="server" size={18} color="#46B8C4" />
          </Pressable>
        </View>
      </View>
      
      <FlatList 
        data={store.connections} 
        keyExtractor={(p) => p.hostId} 
        contentContainerStyle={store.connections.length === 0 ? [styles.deck, { flex: 1 }] : styles.deck}
        ListEmptyComponent={<View style={styles.emptyShell}><Text style={styles.emptyTitle}>Your terminal, at reach.</Text><Text style={styles.emptyText}>Pair this device with a running daemon to browse sessions and work from anywhere.</Text><Pressable accessibilityLabel="Connect daemon" style={styles.primary} onPress={() => setPairingOpen(true)}><Feather name="link" size={20} color="#0A0A0A" /><Text style={styles.primaryText}>Connect daemon</Text></Pressable></View>}
        renderItem={({ item: connection }) => {
		  const surfaces = buildSessionSurfaces(connection.hostId, runtimes[connection.hostId]?.snapshot, state.tabs);
		  const runtime = runtimes[connection.hostId];
          return (
            <View style={styles.daemonSection}>
              <View style={styles.daemonSectionHeader}>
                <Text style={styles.daemonSectionTitle}>{connection.name}</Text>
                <Text style={styles.daemonSectionSub}>{new URL(connection.endpoint).host}</Text>
                
                <View style={styles.daemonToolbar}>
                  <Pressable accessibilityLabel={`New Terminal ${connection.endpoint}`} style={styles.tabCreateBtn} onPress={() => spawnTab(connection.hostId, 'terminal')}>
                    <Feather name="terminal" size={16} color="#F0F0F0" />
                  </Pressable>
                  <Pressable accessibilityLabel={`New Agent ${connection.endpoint}`} style={styles.tabCreateBtn} onPress={() => spawnTab(connection.hostId, 'agent')}>
                    <Feather name="cpu" size={16} color="#F0F0F0" />
                  </Pressable>
                  <Pressable accessibilityLabel={`New Files ${connection.endpoint}`} style={styles.tabCreateBtn} onPress={() => spawnTab(connection.hostId, 'files')}>
                    <Feather name="folder" size={16} color="#F0F0F0" />
                  </Pressable>
                  <Pressable accessibilityLabel={`New Desktop ${connection.endpoint}`} style={styles.tabCreateBtn} onPress={() => spawnTab(connection.hostId, 'desktop')}>
                    <Feather name="monitor" size={16} color="#F0F0F0" />
                  </Pressable>
                </View>
              </View>

			  {runtime?.status === 'error' && <View style={styles.runtimeError}><Text style={styles.runtimeErrorText}>Reconnect required: {runtime.error}</Text></View>}

              {surfaces.length === 0 ? (
                <View style={styles.noTabs}><Text style={styles.noTabsText}>No open sessions for this daemon</Text></View>
              ) : (
                <View style={styles.tabGrid}>
                  {surfaces.map((surface) => (
                    <Pressable key={surface.key} accessibilityLabel={`Open ${surface.kind} ${surface.title}`} style={styles.tabCard} onPress={() => openSurface(connection.hostId, surface)}>
                      <View style={styles.tabIcon}>
                        {surface.kind === 'terminal' && <Feather name="terminal" size={20} color="#D19A2C" />}
                        {surface.kind === 'agent' && <Feather name="cpu" size={20} color="#A78BFA" />}
                        {surface.kind === 'files' && <Feather name="folder" size={20} color="#F19999" />}
                        {surface.kind === 'desktop' && <Feather name="monitor" size={20} color="#46B86B" />}
                      </View>
                      <View style={styles.tabContent}>
                        <Text style={styles.tabTitle} numberOfLines={1}>{surface.title}</Text>
                        <Text style={styles.tabStatus} numberOfLines={1}>{surface.status}</Text>
                      </View>
                      {surface.tab && (
                        <Pressable accessibilityLabel={`Close tab ${surface.tab.tabId}`} style={styles.tabClose} onPress={(e) => { e.stopPropagation(); closeTab(surface.tab!.tabId); }}>
                          <Feather name="x" size={16} color="#888" />
                        </Pressable>
                      )}
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
          );
        }} 
      />

      {diagnostics.length > 0 && <View style={styles.diagnostics}>{diagnosticsInitial.map((step) => <Text key={step} style={[styles.diagnostic, diagnostics.includes(step) && styles.diagnosticDone]}>{diagnostics.includes(step) ? '✓ ' : '· '}{step}</Text>)}</View>}
      <PairingSheet visible={pairingOpen} onDismiss={() => setPairingOpen(false)} onConnect={connect} />
      <ConnectionSheet visible={daemonsOpen} store={store} selectedHostId={selectedHostId} onDismiss={() => setDaemonsOpen(false)} onSelect={async (id) => { setSelectedHostId(id); setDaemonsOpen(false); }} onSave={saveEdit} onDelete={removeDaemon} onAdd={() => { setDaemonsOpen(false); setPairingOpen(true); }} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0A0A0A' }, 
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0A0A0A' }, 
  emptyShell: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28, gap: 16 }, 
  wordmark: { color: '#F0F0F0', fontWeight: '800', fontSize: 21 }, 
  emptyTitle: { color: '#F0F0F0', fontSize: 24, fontWeight: '700' }, 
  emptyText: { color: '#B8B8B8', fontSize: 16, lineHeight: 23, maxWidth: 520 }, 
  primary: { minHeight: 48, borderRadius: 8, backgroundColor: '#D19A2C', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 16, flexDirection: 'row', gap: 8 }, 
  primaryText: { color: '#0A0A0A', fontWeight: '800' }, 
  topbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderColor: '#262626' },
  brand: { gap: 2 },
  actions: { flexDirection: 'row', gap: 12 },
  action: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#181818', alignItems: 'center', justifyContent: 'center' },
  deck: { padding: 16, gap: 24 },
  daemonSection: { backgroundColor: '#111', borderRadius: 12, borderWidth: 1, borderColor: '#262626', overflow: 'hidden' },
  daemonSectionHeader: { padding: 16, borderBottomWidth: 1, borderColor: '#262626', backgroundColor: '#181818' },
  daemonSectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#F0F0F0' },
  daemonSectionSub: { fontSize: 13, color: '#888', marginTop: 2, marginBottom: 12 },
  daemonToolbar: { flexDirection: 'row', gap: 8 },
  tabCreateBtn: { width: 44, height: 40, borderRadius: 8, backgroundColor: '#333', alignItems: 'center', justifyContent: 'center' },
  noTabs: { padding: 32, alignItems: 'center' },
  noTabsText: { color: '#555', fontStyle: 'italic' },
  tabGrid: { padding: 12, gap: 8 },
  tabCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1A1A1A', borderRadius: 8, padding: 12, borderWidth: 1, borderColor: '#333' },
  tabIcon: { width: 36, height: 36, borderRadius: 8, backgroundColor: '#262626', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  tabContent: { flex: 1, justifyContent: 'center' },
  tabTitle: { fontSize: 15, fontWeight: '600', color: '#E0E0E0' },
  tabStatus: { fontSize: 13, color: '#888', marginTop: 2 },
  tabClose: { padding: 8 },
  diagnostics: { position: 'absolute', bottom: 32, alignSelf: 'center', backgroundColor: '#1A1A1A', padding: 16, borderRadius: 8, borderColor: '#3A3A3A', borderWidth: 1, elevation: 8, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 12 }, 
	 runtimeList: { borderTopWidth: 1, borderColor: '#262626' },
	 runtimeRow: { minHeight: 54, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderColor: '#202020' },
	 runtimeError: { padding: 12, backgroundColor: '#2A1C1C' },
	 runtimeErrorText: { color: '#F19999', fontSize: 13 },
  diagnostic: { color: '#888', fontSize: 13, marginVertical: 2 }, 
  diagnosticDone: { color: '#46B86B' }
});