import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';

import { AgenticRemoteAPI } from '../src/lib/api';
import { getConnection, loadConnections } from '../src/lib/connection';
import type { FileEntry, GitStatus, ReadFileResponse } from '../src/protocol';

export default function FilesScreen() {
  const { connectionEndpoint } = useLocalSearchParams<{ connectionEndpoint: string }>();
  const [api, setAPI] = useState<AgenticRemoteAPI | null>(null);
  const [path, setPath] = useState('');
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [file, setFile] = useState<ReadFileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async (client = api, location = path, search = query) => {
    if (!client) return;
    setLoading(true);
    try {
      const [nextEntries, status] = await Promise.all([search ? client.searchFiles(location, search) : client.files(location), client.gitStatus(location)]);
      setEntries(nextEntries); setGit(status);
    } catch (error) { Alert.alert('Could not load files', error instanceof Error ? error.message : 'Unknown error'); }
    finally { setLoading(false); }
  }, [api, path, query]);
  useEffect(() => {
    void loadConnections()
      .then((store) => {
        const connection = getConnection(store, connectionEndpoint ?? null);
        if (!connection) {
          setLoading(false);
          Alert.alert('Could not load daemon connection');
          router.replace('/');
          return;
        }
        const client = new AgenticRemoteAPI(connection);
        setAPI(client);
        void reload(client);
      })
      .catch(() => { Alert.alert('Could not load daemon connections'); router.replace('/'); setLoading(false); });
  }, []);
  const gitCodes = useMemo(() => new Map(git?.entries.map((entry) => [entry.path, entry.code])), [git]);
  const open = async (entry: FileEntry) => { if (entry.isDir) { setPath(entry.path); setQuery(''); await reload(api, entry.path, ''); } else if (api) { try { setFile(await api.readFile(entry.path)); } catch (error) { Alert.alert('Could not read file', error instanceof Error ? error.message : 'Unknown error'); } } };
  if (file) return <Editor file={file} api={api} onBack={() => setFile(null)} />;
  return <SafeAreaView style={styles.screen}><Stack.Screen options={{ headerShown: false }} /><View style={styles.header}><Pressable onPress={() => router.back()}><Text style={styles.link}>‹ Sessions</Text></Pressable><Text style={styles.title}>Files</Text><Pressable onPress={() => void reload()}><Text style={styles.link}>Refresh</Text></Pressable></View><TextInput style={styles.input} value={path} onChangeText={setPath} onSubmitEditing={() => void reload()} placeholder="Workspace path" placeholderTextColor="#888" /><TextInput style={styles.input} value={query} onChangeText={setQuery} onSubmitEditing={() => void reload()} placeholder="Search files" placeholderTextColor="#888" />{loading ? <ActivityIndicator color="#D19A2C" style={styles.loader} /> : <FlatList data={entries} keyExtractor={(entry) => entry.path} renderItem={({ item }) => <Pressable style={styles.entry} onPress={() => void open(item)}><Text style={styles.icon}>{item.isDir ? '▸' : '·'}</Text><View style={styles.entryMain}><Text style={styles.name}>{item.name}</Text><Text style={styles.path}>{item.path}</Text></View><Text style={styles.git}>{item.gitCode || gitCodes.get(item.path) || ''}</Text></Pressable>} ListEmptyComponent={<Text style={styles.empty}>No files found.</Text>} />}</SafeAreaView>;
}

function Editor({ file, api, onBack }: { file: ReadFileResponse; api: AgenticRemoteAPI | null; onBack: () => void }) {
  const [content, setContent] = useState(file.text);
  const [saving, setSaving] = useState(false);
  const save = async () => { if (!api) return; setSaving(true); try { await api.writeFile(file.path, content, file.sha256); onBack(); } catch (error) { Alert.alert('Could not save', error instanceof Error ? error.message : 'Unknown error'); } finally { setSaving(false); } };
  return <SafeAreaView style={styles.screen}><View style={styles.header}><Pressable onPress={onBack}><Text style={styles.link}>‹ Files</Text></Pressable><Text style={styles.title} numberOfLines={1}>{file.path.split('/').pop()}</Text><Pressable onPress={() => void save()}><Text style={styles.link}>{saving ? 'Saving…' : 'Save'}</Text></Pressable></View><TextInput style={styles.editor} value={content} onChangeText={setContent} multiline autoCapitalize="none" autoCorrect={false} textAlignVertical="top" /></SafeAreaView>;
}

const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: '#0A0A0A' }, header: { minHeight: 56, paddingHorizontal: 16, alignItems: 'center', flexDirection: 'row', gap: 14, borderBottomWidth: 1, borderColor: '#262626' }, title: { flex: 1, color: '#F0F0F0', fontSize: 18, fontWeight: '700' }, link: { color: '#46B8C4', fontWeight: '700' }, input: { minHeight: 46, marginHorizontal: 16, marginTop: 12, paddingHorizontal: 12, borderWidth: 1, borderRadius: 8, borderColor: '#3A3A3A', color: '#F0F0F0' }, loader: { marginTop: 36 }, entry: { minHeight: 64, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderColor: '#181818' }, icon: { color: '#D19A2C', fontSize: 20 }, entryMain: { flex: 1 }, name: { color: '#F0F0F0', fontWeight: '600' }, path: { color: '#888', fontSize: 12, marginTop: 2 }, git: { color: '#D19A2C', fontWeight: '800' }, empty: { color: '#B8B8B8', textAlign: 'center', marginTop: 50 }, editor: { flex: 1, margin: 16, padding: 12, color: '#F0F0F0', backgroundColor: '#181818', borderRadius: 8, fontFamily: 'monospace' } });
