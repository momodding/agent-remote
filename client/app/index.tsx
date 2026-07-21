import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, Platform, Pressable, SafeAreaView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { router } from 'expo-router';

import { AgenticRemoteAPI, APIError, authenticatePairing } from '../src/lib/api';
import { clearConnection, loadConnection, saveConnection, type Connection } from '../src/lib/connection';
import type { PairingPayload, SessionSummary } from '../src/protocol';
import { PairingSheet } from '../src/components/PairingSheet';

const diagnosticsInitial = ['Resolving endpoint...', 'Initiating TLS Handshake...', 'Validating Certificate Fingerprint...', 'Executing Auth-v2 Challenge...', 'Session Established'];

export default function Dashboard() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [query, setQuery] = useState('');
  const [pairingOpen, setPairingOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const { width } = useWindowDimensions();
  const columns = width < 640 ? 1 : Math.max(1, Math.min(4, Math.floor(width / 280)));
  const api = useMemo(() => connection && new AgenticRemoteAPI(connection), [connection]);

  const refresh = useCallback(async () => {
    if (!api) return;
    try { setSessions(await api.sessions()); } catch (error) { if (error instanceof APIError && error.status === 401) await disconnect(); else Alert.alert('Could not load sessions', error instanceof Error ? error.message : 'Unknown error'); }
  }, [api]);

  const disconnect = useCallback(async () => { await clearConnection(); setConnection(null); setSessions([]); }, []);

  useEffect(() => { void loadConnection().then((saved) => { setConnection(saved); setLoading(false); }); }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active') void refresh(); });
    return () => listener.remove();
  }, [refresh]);

  const connect = async (payload: PairingPayload, clientName: string) => {
    setDiagnostics([]);
    try {
      const connected = await authenticatePairing(payload, clientName, (message) => setDiagnostics((items) => [...items, message]));
      await saveConnection(connected);
      setConnection(connected);
      await new AgenticRemoteAPI(connected).sessions().then(setSessions);
    } catch (error) {
      Alert.alert('Connection failed', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  const create = async () => {
    if (!api) return;
    try {
      const session = await api.createSession({ name: 'Shell', command: 'bash', args: [], cwd: '', cols: 80, rows: 24 });
      setSessions((items) => [session, ...items]);
      router.push({ pathname: '/terminal/[id]', params: { id: session.id, name: session.name } });
    } catch (error) { Alert.alert('Could not create session', error instanceof Error ? error.message : 'Unknown error'); }
  };

  const visibleSessions = sessions.filter((session) => `${session.name} ${session.command}`.toLowerCase().includes(query.trim().toLowerCase()));
  if (loading) return <View style={styles.loading}><ActivityIndicator color="#D19A2C" /></View>;
  if (!connection) return <><View style={styles.empty}><Text style={styles.wordmark}>agenticRemote</Text><Text style={styles.emptyTitle}>Your terminal, at reach.</Text><Text style={styles.emptyText}>Pair this device with a running daemon to browse sessions and work from anywhere.</Text><Pressable style={styles.primary} onPress={() => setPairingOpen(true)}><Text style={styles.primaryText}>Connect daemon</Text></Pressable></View><PairingSheet visible={pairingOpen} onDismiss={() => setPairingOpen(false)} onConnect={connect} /></>;

  return <SafeAreaView style={styles.screen}>
    <View style={styles.topbar}><View><Text style={styles.wordmark}>agenticRemote</Text><Text style={styles.endpoint}>{new URL(connection.endpoint).host}</Text></View><View style={styles.actions}><Pressable style={styles.action} onPress={() => void refresh()}><Text style={styles.actionText}>Refresh</Text></Pressable><Pressable style={styles.action} onPress={() => router.push('/files')}><Text style={styles.actionText}>Files</Text></Pressable><Pressable style={styles.action} onPress={() => void disconnect()}><Text style={styles.actionText}>Disconnect</Text></Pressable></View></View>
    <View style={styles.controls}><TextInput style={styles.search} value={query} onChangeText={setQuery} placeholder="Search sessions" placeholderTextColor="#888" /><Pressable style={styles.primary} onPress={() => void create()}><Text style={styles.primaryText}>New shell</Text></Pressable></View>
    <FlatList data={visibleSessions} key={`${columns}`} keyExtractor={(session) => session.id} numColumns={columns} contentContainerStyle={styles.list} columnWrapperStyle={columns > 1 ? styles.columns : undefined} ListEmptyComponent={<View style={styles.noSessions}><Text style={styles.emptyTitle}>No matching sessions</Text><Text style={styles.emptyText}>Start a shell to see it here.</Text></View>} renderItem={({ item }) => api ? <SessionCard session={item} api={api} onClose={() => void refresh()} /> : null} />
    {diagnostics.length > 0 && <View style={styles.diagnostics}>{diagnosticsInitial.map((step) => <Text key={step} style={[styles.diagnostic, diagnostics.includes(step) && styles.diagnosticDone]}>{diagnostics.includes(step) ? '✓ ' : '· '}{step}</Text>)}</View>}
    <PairingSheet visible={pairingOpen} onDismiss={() => setPairingOpen(false)} onConnect={connect} />
  </SafeAreaView>;
}

function SessionCard({ session, api, onClose }: { session: SessionSummary; api: AgenticRemoteAPI; onClose: () => void }) {
  return <Pressable style={styles.card} onPress={() => router.push({ pathname: '/terminal/[id]', params: { id: session.id, name: session.name } })}>
    <View style={styles.cardHead}><Text style={styles.cardTitle} numberOfLines={1}>{session.name}</Text><Text style={[styles.status, session.state === 'finished' && styles.finished]}>{session.state}</Text></View>
    <Text style={styles.command} numberOfLines={1}>{session.command}</Text>
    <Text style={styles.preview} numberOfLines={5}>{session.preview.join('\n') || 'No output yet'}</Text>
    {session.waitState && <Text style={styles.wait}>{session.waitState.label}</Text>}
    <View style={styles.cardActions}><Pressable style={styles.open} onPress={() => router.push({ pathname: '/terminal/[id]', params: { id: session.id, name: session.name } })}><Text style={styles.openText}>Open</Text></Pressable><Pressable style={styles.close} onPress={(event) => { event.stopPropagation(); void api.closeSession(session.id).then(onClose); }}><Text style={styles.closeText}>Close</Text></Pressable></View>
  </Pressable>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0A0A0A' }, loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0A0A0A' }, empty: { flex: 1, backgroundColor: '#0A0A0A', justifyContent: 'center', padding: 28, gap: 16 }, wordmark: { color: '#F0F0F0', fontWeight: '800', fontSize: 21 }, endpoint: { color: '#B8B8B8', marginTop: 3 }, emptyTitle: { color: '#F0F0F0', fontSize: 24, fontWeight: '700' }, emptyText: { color: '#B8B8B8', fontSize: 16, lineHeight: 23, maxWidth: 520 }, primary: { minHeight: 48, borderRadius: 8, backgroundColor: '#D19A2C', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 16 }, primaryText: { color: '#0A0A0A', fontWeight: '800' }, topbar: { padding: 18, flexDirection: 'row', justifyContent: 'space-between', gap: 16, borderBottomWidth: 1, borderColor: '#262626' }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }, action: { minHeight: 40, paddingHorizontal: 10, justifyContent: 'center', borderRadius: 7, backgroundColor: '#181818' }, actionText: { color: '#46B8C4', fontWeight: '600' }, controls: { padding: 18, gap: 10, flexDirection: 'row' }, search: { flex: 1, minHeight: 48, paddingHorizontal: 12, color: '#F0F0F0', borderWidth: 1, borderColor: '#3A3A3A', borderRadius: 8 }, list: { padding: 18, gap: 14 }, columns: { gap: 14 }, noSessions: { paddingTop: 70, alignItems: 'center', gap: 8, flex: 1 }, card: { flex: 1, minWidth: 0, borderWidth: 1, borderColor: '#262626', backgroundColor: '#181818', borderRadius: 10, padding: 14, gap: 10, marginBottom: 14 }, cardHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 }, cardTitle: { color: '#F0F0F0', fontSize: 17, fontWeight: '700', flex: 1 }, status: { color: '#46B8C4', fontSize: 12, fontWeight: '700' }, finished: { color: '#B8B8B8' }, command: { color: '#D19A2C', fontFamily: 'monospace' }, preview: { minHeight: 86, color: '#B8B8B8', fontFamily: 'monospace', lineHeight: 18 }, wait: { color: '#D19A2C' }, cardActions: { flexDirection: 'row', gap: 8 }, open: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: '#264E54' }, openText: { color: '#F0F0F0', fontWeight: '700' }, close: { minWidth: 70, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 7, borderWidth: 1, borderColor: '#5A3939' }, closeText: { color: '#F19999', fontWeight: '700' }, diagnostics: { position: 'absolute', left: 18, right: 18, bottom: 18, padding: 14, gap: 5, borderRadius: 9, borderWidth: 1, borderColor: '#3A3A3A', backgroundColor: '#181818' }, diagnostic: { color: '#777' }, diagnosticDone: { color: '#46B8C4' },
});
