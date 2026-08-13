import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import { AgenticRemoteAPI } from '../src/lib/api';
import { getConnection, loadConnections, type Connection } from '../src/lib/connection';
import type { FileEntry, GitStatus, ReadFileResponse } from '../src/protocol';

export default function FilesScreen() {
  const { connectionEndpoint } = useLocalSearchParams<{ connectionEndpoint: string }>();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [api, setAPI] = useState<AgenticRemoteAPI | null>(null);
  const [path, setPath] = useState('');
  const [pathText, setPathText] = useState('');
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [file, setFile] = useState<ReadFileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const requestRef = useRef(0);

  const reload = useCallback(async (client = api, location = path, search = query) => {
    if (!client) return false;
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const [nextEntries, status] = await Promise.all([
        search ? client.searchFiles(location, search) : client.files(location),
        client.gitStatus(location),
      ]);
      if (request !== requestRef.current) return false;
      setEntries(nextEntries);
      setGit(status);
      return true;
    } catch (error) {
      if (request === requestRef.current) Alert.alert('Could not load files', error instanceof Error ? error.message : 'Unknown error');
      return false;
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [api, path, query]);

  useEffect(() => {
    void loadConnections().then((store) => {
      const nextConnection = getConnection(store, connectionEndpoint ?? null);
      if (!nextConnection) {
        setLoading(false);
        Alert.alert('Could not load daemon connection');
        router.replace('/');
        return;
      }
      setConnection(nextConnection);
      const client = new AgenticRemoteAPI(nextConnection);
      setAPI(client);
      void reload(client, '', '');
    });
  }, [connectionEndpoint]);

  const gitCodes = useMemo(() => new Map(git?.entries.map((entry) => [entry.path, entry.code]) ?? []), [git]);
  const navigate = async (location: string) => {
    const previousPath = path;
    const previousPathText = pathText;
    setPath(location);
    setPathText(location);
    setQuery('');
    if (!await reload(api, location, '')) {
      setPath(previousPath);
      setPathText(previousPathText);
    }
  };
  const open = async (entry: FileEntry) => {
    if (entry.isDir) return void navigate(entry.path);
    if (!api) return;
    try { setFile(await api.readFile(entry.path)); }
    catch (error) { Alert.alert('Could not open file', error instanceof Error ? error.message : 'Unknown error'); }
  };

  if (file) return <Editor file={file} api={api} onBack={() => { setFile(null); void reload(); }} />;

  const breadcrumbs = buildBreadcrumbs(path);
  const parentPath = getParentPath(path);

  return <SafeAreaView style={styles.screen}>
    <Stack.Screen options={{ headerShown: false }} />
    <View style={styles.header}>
      <Pressable accessibilityLabel="Close file manager" style={styles.iconBtn} onPress={() => router.replace('/')}>
        <Feather name="x" size={22} color="#46B8C4" />
      </Pressable>
      <Text style={styles.title} numberOfLines={1}>{connection ? new URL(connection.endpoint).host : 'Files'}</Text>
      <Pressable accessibilityLabel="Refresh" style={styles.iconBtn} onPress={() => void reload()}>
        <Feather name="refresh-cw" size={20} color="#46B8C4" />
      </Pressable>
    </View>
    <FlatList
      horizontal
      style={styles.breadcrumbs}
      contentContainerStyle={styles.breadcrumbContent}
      showsHorizontalScrollIndicator={false}
      data={breadcrumbs}
      keyExtractor={(item) => item.target || '/'}
      renderItem={({ item, index }) => <Pressable accessibilityLabel={`Navigate to ${item.label}`} style={styles.breadcrumb} onPress={() => void navigate(item.target)}>
        {index > 0 && <Feather name="chevron-right" size={16} color="#666" />}
        <Text style={[styles.breadcrumbText, item.target === path && styles.breadcrumbActive]}>{item.label}</Text>
      </Pressable>}
    />
    <View style={styles.searchRow}>
      <TextInput style={styles.input} value={query} onChangeText={(value) => { setQuery(value); if (!value) void reload(api, path, ''); }} onSubmitEditing={() => void reload()} placeholder="Search files…" placeholderTextColor="#777" returnKeyType="search" />
    </View>
    <View style={styles.pathRow}>
      <TextInput accessibilityLabel="Path" style={[styles.input, styles.pathInput]} value={pathText} onChangeText={setPathText} onSubmitEditing={() => void navigate(pathText.trim())} placeholder="Path" placeholderTextColor="#777" autoCapitalize="none" autoCorrect={false} returnKeyType="go" />
      <Pressable accessibilityLabel="Go to path" style={styles.smallBtn} onPress={() => void navigate(pathText.trim())}><Text style={styles.smallBtnText}>Go</Text></Pressable>
      <Pressable accessibilityLabel="Host root" style={styles.smallBtn} onPress={() => void navigate('/')}><Text style={styles.smallBtnText}>Host root</Text></Pressable>
    </View>
    <Pressable accessibilityLabel="Parent directory" disabled={parentPath == null} style={[styles.parent, parentPath == null && styles.disabled]} onPress={() => parentPath != null && void navigate(parentPath)}>
      <Feather name="corner-up-left" size={18} color={parentPath != null ? '#F0F0F0' : '#666'} />
      <Text style={styles.parentText}>Parent directory</Text>
    </Pressable>
    {loading && <ActivityIndicator color="#46B8C4" style={styles.loader} />}
    {!loading && entries.length === 0 && <Text style={styles.empty}>{query ? 'No matching files' : 'No files in this directory'}</Text>}
    <FlatList
      data={entries}
      keyExtractor={(item) => item.path}
      renderItem={({ item }) => <Pressable accessibilityLabel={item.isDir ? `Open folder ${item.name}` : `Open file ${item.name}`} style={styles.entry} onPress={() => void open(item)}>
        <Feather name={item.isDir ? 'folder' : 'file'} size={20} color={item.isDir ? '#46B8C4' : '#888'} />
        <View style={styles.entryInfo}>
          <Text style={styles.entryName} numberOfLines={1}>{item.name}</Text>
          {query && <Text style={styles.entryPath} numberOfLines={1}>{item.path}</Text>}
        </View>
        {gitCodes.has(item.path) && <Text style={styles.gitCode}>{gitCodes.get(item.path)}</Text>}
        {!item.isDir && item.size != null && <Text style={styles.size}>{formatBytes(item.size)}</Text>}
      </Pressable>}
    />
  </SafeAreaView>;
}

function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / 1024 ** unit).toFixed(1))} ${units[unit]}`;
}

function buildBreadcrumbs(path: string) {
  if (path.startsWith('/')) {
    const segments = path.split('/').filter(Boolean);
    return [{ label: '/', target: '/' }, ...segments.map((segment, index) => ({ label: segment, target: `/${segments.slice(0, index + 1).join('/')}` }))];
  }
  const segments = path.split('/').filter(Boolean);
  return [{ label: 'Workspace', target: '' }, ...segments.map((segment, index) => ({ label: segment, target: segments.slice(0, index + 1).join('/') }))];
}

function getParentPath(path: string) {
  if (!path || path === '/') return null;
  const trimmed = path.replace(/\/$/, '');
  const index = trimmed.lastIndexOf('/');
  if (path.startsWith('/')) return index <= 0 ? '/' : trimmed.slice(0, index);
  return index < 0 ? '' : trimmed.slice(0, index);
}

function Editor({ file, api, onBack }: { file: ReadFileResponse; api: AgenticRemoteAPI | null; onBack: () => void }) {
  const [content, setContent] = useState(file.text);
  const save = async () => {
    if (!api) return;
    try { await api.writeFile(file.path, content, file.sha256); Alert.alert('Saved'); }
    catch (error) { Alert.alert('Could not save', error instanceof Error ? error.message : 'Unknown error'); }
  };
  return <SafeAreaView style={styles.screen}>
    <Stack.Screen options={{ headerShown: false }} />
    <View style={styles.header}>
      <Pressable accessibilityLabel="Back to files" style={styles.iconBtn} onPress={onBack}><Feather name="arrow-left" size={20} color="#46B8C4" /></Pressable>
      <Text style={styles.title} numberOfLines={1}>{file.path}</Text>
      <Pressable accessibilityLabel="Save file" style={styles.iconBtn} onPress={() => void save()}><Feather name="save" size={20} color="#46B8C4" /></Pressable>
    </View>
    <TextInput style={styles.editor} value={content} onChangeText={setContent} multiline textAlignVertical="top" autoCapitalize="none" autoCorrect={false} />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0A0A0A' },
  header: { minHeight: 56, paddingHorizontal: 10, alignItems: 'center', flexDirection: 'row', gap: 10, borderBottomWidth: 1, borderColor: '#262626' },
  title: { flex: 1, color: '#F0F0F0', fontSize: 18, fontWeight: '700' },
  iconBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  breadcrumbs: { flexGrow: 0, minHeight: 44, borderBottomWidth: 1, borderColor: '#181818' },
  breadcrumbContent: { alignItems: 'center', paddingHorizontal: 8 },
  breadcrumb: { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingHorizontal: 6, gap: 2 },
  breadcrumbText: { color: '#AAA', fontSize: 15 },
  breadcrumbActive: { color: '#F0F0F0', fontWeight: '600' },
  searchRow: { padding: 12 },
  input: { minHeight: 46, paddingHorizontal: 12, borderWidth: 1, borderRadius: 8, borderColor: '#3A3A3A', color: '#F0F0F0' },
  pathRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingBottom: 12 },
  pathInput: { flex: 1 },
  smallBtn: { minHeight: 46, paddingHorizontal: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#123338' },
  smallBtnText: { color: '#D9FAFF', fontWeight: '700' },
  parent: { minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 12, borderBottomWidth: 1, borderColor: '#181818' },
  parentText: { color: '#F0F0F0', fontSize: 15 },
  disabled: { opacity: 0.35 },
  loader: { marginTop: 36 },
  empty: { color: '#888', textAlign: 'center', marginTop: 36 },
  entry: { minHeight: 64, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderColor: '#181818' },
  entryInfo: { flex: 1 },
  entryName: { color: '#F0F0F0', fontSize: 16 },
  entryPath: { color: '#888', fontSize: 12, marginTop: 2 },
  gitCode: { color: '#E8A05C', fontSize: 13, fontWeight: '700', minWidth: 20, textAlign: 'center' },
  size: { color: '#888', fontSize: 13 },
  editor: { flex: 1, padding: 16, color: '#F0F0F0', fontSize: 15, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
});
