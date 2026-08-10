import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';

import { AgenticRemoteAPI, APIError, authenticatePairing } from '../src/lib/api';
import { deleteConnection, getConnection, loadConnections, saveConnection, selectConnection, updateConnection, type Connection, type ConnectionStore } from '../src/lib/connection';
import type { PairingPayload, SessionSummary } from '../src/protocol';
import { PairingSheet } from '../src/components/PairingSheet';
import { ConnectionSheet } from '../src/components/ConnectionSheet';

const diagnosticsInitial = ['Resolving endpoint...', 'Initiating TLS Handshake...', 'Validating Certificate Fingerprint...', 'Executing Auth-v2 Challenge...', 'Session Established'];

export default function Dashboard() {
  const [store, setStore] = useState<ConnectionStore>({ connections: [], selectedEndpoint: null });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [query, setQuery] = useState('');
  const [pairingOpen, setPairingOpen] = useState(false);
  const [daemonsOpen, setDaemonsOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const { width } = useWindowDimensions();
  const columns = width < 640 ? 1 : Math.max(1, Math.min(4, Math.floor(width / 280)));
  const connection = useMemo(() => getConnection(store), [store]);
  const api = useMemo(() => (connection ? new AgenticRemoteAPI(connection) : null), [connection?.endpoint, connection?.token]);

  const requestRef = useRef(0);

  // Guards against stale responses: switching/editing/deleting daemons faster than
  // a pending fetch resolves must never let an older request overwrite newer state.
  const loadSessions = useCallback(async (target: Connection) => {
    const id = ++requestRef.current;
    try {
      const result = await new AgenticRemoteAPI(target).sessions();
      if (id === requestRef.current) setSessions(result);
    } catch (error) {
      if (id !== requestRef.current) return;
      if (error instanceof APIError && error.status === 401) {
        setSessions([]);
        Alert.alert('Authentication expired. Pair this daemon again or edit its saved credentials.');
      } else {
        Alert.alert('Could not load sessions', error instanceof Error ? error.message : 'Unknown error');
      }
    }
  }, []);
  const clearSessions = useCallback(() => { requestRef.current += 1; setSessions([]); }, []);
  const refresh = useCallback(async () => { if (connection) await loadSessions(connection); }, [connection, loadSessions]);

  useEffect(() => {
    void loadConnections()
      .then(async (loaded) => {
        setStore(loaded);
        const selected = getConnection(loaded);
        if (selected) await loadSessions(selected);
      })
      .catch(() => Alert.alert('Could not load daemon connections'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active') void refresh(); });
    return () => listener.remove();
  }, [refresh]);

  const connect = async (payload: PairingPayload, clientName: string, onStage?: (message: string) => void) => {
    setDiagnostics([]);
    try {
      const paired = await authenticatePairing(payload, clientName, (message) => {
        console.log('[pairing]', message);
        setDiagnostics((items) => [...items, message]);
        onStage?.(message);
      });
      const name = getConnection(store, paired.endpoint)?.name ?? new URL(paired.endpoint).host;
      const nextStore = await saveConnection({ ...paired, name });
      setStore(nextStore);
      const reconnected = getConnection(nextStore, paired.endpoint);
      if (reconnected) await loadSessions(reconnected);
      setTimeout(() => setDiagnostics([]), 1500);
    } catch (error) {
      setDiagnostics([]);
      throw error;
    }
  };

  const selectDaemon = async (endpoint: string) => {
    try {
      const nextStore = await selectConnection(endpoint);
      setStore(nextStore);
      clearSessions();
      setDaemonsOpen(false);
      const selected = getConnection(nextStore, endpoint);
      if (selected) await loadSessions(selected);
    } catch (error) {
      Alert.alert('Could not switch daemon', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  const saveEdit = async (originalEndpoint: string, replacement: Connection) => {
    const wasSelected = originalEndpoint === store.selectedEndpoint;
    const nextStore = await updateConnection(originalEndpoint, replacement);
    setStore(nextStore);
    if (wasSelected) {
      const selected = getConnection(nextStore);
      if (selected) await loadSessions(selected);
    }
  };

  const removeDaemon = async (endpoint: string) => {
    try {
      const wasSelected = endpoint === store.selectedEndpoint;
      const nextStore = await deleteConnection(endpoint);
      setStore(nextStore);
      if (wasSelected) {
        const selected = getConnection(nextStore);
        if (selected) await loadSessions(selected); else clearSessions();
      }
    } catch (error) {
      Alert.alert('Could not delete daemon', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  const addDaemon = () => { setDaemonsOpen(false); setPairingOpen(true); };

  const create = async () => {
    if (!api || !connection) return;
    try {
      const session = await api.createSession({ name: 'Shell', command: 'bash', args: [], cwd: '', cols: 80, rows: 24 });
      setSessions((items) => [session, ...items]);
      router.push({ pathname: '/terminal/[id]', params: { id: session.id, name: session.name, connectionEndpoint: connection.endpoint } });
    } catch (error) { Alert.alert('Could not create session', error instanceof Error ? error.message : 'Unknown error'); }
  };

  const createMulti = async () => {
    if (!api || !connection) return;
    try {
      const session = await api.createSession({ name: 'Shell', command: 'bash', args: [], cwd: '', cols: 80, rows: 24 });
      setSessions((items) => [session, ...items]);
      router.push({ pathname: '/terminal/[id]', params: { id: session.id, name: session.name, connectionEndpoint: connection.endpoint, mode: 'multi' } });
    } catch (error) { Alert.alert('Could not create session', error instanceof Error ? error.message : 'Unknown error'); }
  };

  const visibleSessions = sessions
    .filter((session) => session.state !== 'exited')
    .filter((session) => `${session.name} ${session.command}`.toLowerCase().includes(query.trim().toLowerCase()));
  if (loading) return <SafeAreaView style={styles.loading}><ActivityIndicator color="#D19A2C" /></SafeAreaView>;
  if (!connection) return <><SafeAreaView style={styles.empty}><Text style={styles.wordmark}>agenticRemote</Text><Text style={styles.emptyTitle}>Your terminal, at reach.</Text><Text style={styles.emptyText}>Pair this device with a running daemon to browse sessions and work from anywhere.</Text><Pressable accessibilityLabel="Connect daemon" style={styles.primary} onPress={() => setPairingOpen(true)}><Feather name="link" size={20} color="#0A0A0A" /><Text style={styles.primaryText}>Connect daemon</Text></Pressable></SafeAreaView><PairingSheet visible={pairingOpen} onDismiss={() => setPairingOpen(false)} onConnect={connect} /></>;

  return <SafeAreaView style={styles.screen}>
  <View style={styles.topbar}><View><Text style={styles.wordmark}>agenticRemote</Text><Text style={styles.endpoint}>{new URL(connection.endpoint).host}</Text></View><View style={styles.actions}><Pressable accessibilityLabel="Refresh" style={styles.action} onPress={() => void refresh()}><Feather name="refresh-cw" size={18} color="#46B8C4" /></Pressable><Pressable accessibilityLabel="Files" style={styles.action} onPress={() => router.push({ pathname: '/files', params: { connectionEndpoint: connection.endpoint } })}><Feather name="folder" size={18} color="#46B8C4" /></Pressable><Pressable accessibilityLabel="Daemons" style={styles.action} onPress={() => setDaemonsOpen(true)}><Feather name="server" size={18} color="#46B8C4" /></Pressable></View></View>
  <View style={styles.controls}><TextInput style={styles.search} value={query} onChangeText={setQuery} placeholder="Search sessions" placeholderTextColor="#888" /><View style={styles.createButtons}><Pressable accessibilityLabel="New shell" style={styles.primary} onPress={() => void create()}><Feather name="plus" size={18} color="#0A0A0A" /></Pressable><Pressable accessibilityLabel="New multi-session window" style={styles.secondary} onPress={() => void createMulti()}><Feather name="columns" size={18} color="#46B8C4" /></Pressable></View></View>
    <FlatList data={visibleSessions} key={`${columns}`} keyExtractor={(session) => session.id} numColumns={columns} contentContainerStyle={styles.list} columnWrapperStyle={columns > 1 ? styles.columns : undefined} ListEmptyComponent={<View style={styles.noSessions}><Text style={styles.emptyTitle}>No matching sessions</Text><Text style={styles.emptyText}>Start a shell to see it here.</Text></View>} renderItem={({ item }) => api ? <SessionCard session={item} api={api} connectionEndpoint={connection.endpoint} onClose={() => void refresh()} /> : null} />
    {diagnostics.length > 0 && <View style={styles.diagnostics}>{diagnosticsInitial.map((step) => <Text key={step} style={[styles.diagnostic, diagnostics.includes(step) && styles.diagnosticDone]}>{diagnostics.includes(step) ? '✓ ' : '· '}{step}</Text>)}</View>}
    <PairingSheet visible={pairingOpen} onDismiss={() => setPairingOpen(false)} onConnect={connect} />
    <ConnectionSheet visible={daemonsOpen} store={store} onDismiss={() => setDaemonsOpen(false)} onSelect={selectDaemon} onSave={saveEdit} onDelete={removeDaemon} onAdd={addDaemon} />
  </SafeAreaView>;
}

function SessionCard({ session, api, connectionEndpoint, onClose }: { session: SessionSummary; api: AgenticRemoteAPI; connectionEndpoint: string; onClose: () => void }) {
  const open = () => router.push({ pathname: '/terminal/[id]', params: { id: session.id, name: session.name, connectionEndpoint } });
  return <Pressable accessibilityLabel={`Open ${session.name}`} style={styles.card} onPress={open}>
    <View style={styles.cardHead}><Text style={styles.cardTitle} numberOfLines={1}>{session.name}</Text><Text style={styles.status}>{session.state}</Text></View>
    <Text style={styles.command} numberOfLines={1}>{session.command}</Text>
    <Text style={styles.preview} numberOfLines={5}>{session.preview.join('\n') || 'No output yet'}</Text>
    {session.waitState && <Text style={styles.wait}>{session.waitState.label}</Text>}
    <View style={styles.cardActions}><Pressable accessibilityLabel={`Open ${session.name}`} style={styles.open} onPress={open}><Feather name="external-link" size={18} color="#F0F0F0" /></Pressable><Pressable accessibilityLabel={`Close ${session.name}`} style={styles.close} onPress={() => { void api.closeSession(session.id).then(onClose); }}><Feather name="x" size={18} color="#F19999" /></Pressable></View>
  </Pressable>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0A0A0A' }, loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0A0A0A' }, empty: { flex: 1, backgroundColor: '#0A0A0A', justifyContent: 'center', padding: 28, gap: 16 }, wordmark: { color: '#F0F0F0', fontWeight: '800', fontSize: 21 }, endpoint: { color: '#B8B8B8', marginTop: 3 }, emptyTitle: { color: '#F0F0F0', fontSize: 24, fontWeight: '700' }, emptyText: { color: '#B8B8B8', fontSize: 16, lineHeight: 23, maxWidth: 520 }, primary: { minHeight: 48, borderRadius: 8, backgroundColor: '#D19A2C', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 16, flexDirection: 'row', gap: 8 }, primaryText: { color: '#0A0A0A', fontWeight: '800' }, secondary: { minHeight: 48, borderRadius: 8, backgroundColor: '#264E54', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 16, flexDirection: 'row', gap: 8 }, secondaryText: { color: '#46B8C4', fontWeight: '800' }, topbar: { padding: 18, flexDirection: 'row', justifyContent: 'space-between', gap: 16, borderBottomWidth: 1, borderColor: '#262626' }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }, action: { minHeight: 44, minWidth: 44, paddingHorizontal: 10, justifyContent: 'center', alignItems: 'center', borderRadius: 7, backgroundColor: '#181818' }, actionText: { color: '#46B8C4', fontWeight: '600' }, controls: { padding: 18, gap: 10, flexDirection: 'row' }, search: { flex: 1, minHeight: 48, paddingHorizontal: 12, color: '#F0F0F0', borderWidth: 1, borderColor: '#3A3A3A', borderRadius: 8 }, createButtons: { flexDirection: 'row', gap: 8 }, list: { padding: 18, gap: 14 }, columns: { gap: 14 }, noSessions: { paddingTop: 70, alignItems: 'center', gap: 8, flex: 1 }, card: { flex: 1, minWidth: 0, borderWidth: 1, borderColor: '#262626', backgroundColor: '#181818', borderRadius: 10, padding: 14, gap: 10, marginBottom: 14 }, cardHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 }, cardTitle: { color: '#F0F0F0', fontSize: 17, fontWeight: '700', flex: 1 }, status: { color: '#46B8C4', fontSize: 12, fontWeight: '700' }, command: { color: '#D19A2C', fontFamily: 'monospace' }, preview: { minHeight: 86, color: '#B8B8B8', fontFamily: 'monospace', lineHeight: 18 }, wait: { color: '#D19A2C' }, cardActions: { flexDirection: 'row', gap: 8 }, open: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: '#264E54' }, openText: { color: '#F0F0F0', fontWeight: '700' }, close: { minWidth: 50, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 7, borderWidth: 1, borderColor: '#5A3939' }, closeText: { color: '#F19999', fontWeight: '700' }, diagnostics: { position: 'absolute', left: 18, right: 18, bottom: 18, padding: 14, gap: 5, borderRadius: 9, borderWidth: 1, borderColor: '#3A3A3A', backgroundColor: '#181818' }, diagnostic: { color: '#777' }, diagnosticDone: { color: '#46B8C4' },
});
