import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Directory, File, Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
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
  const [clipboard, setClipboard] = useState<null | { mode: 'copy' | 'cut'; entry: FileEntry }>(null);
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null);
  const [menuEntry, setMenuEntry] = useState<FileEntry | null>(null);
  const [renameText, setRenameText] = useState('');
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
  const paste = async () => {
    if (!api || !clipboard) return;
    const destination = joinRemotePath(path, clipboard.entry.name);
    try {
      if (clipboard.mode === 'copy') await api.copyFile(clipboard.entry.path, destination);
      else await api.renameFile(clipboard.entry.path, destination);
      setClipboard(null);
      void reload(api, path, '');
    } catch (error) {
      Alert.alert('Could not paste file', error instanceof Error ? error.message : 'Unknown error');
    }
  };
  const saveRename = async () => {
    if (!api || !renameTarget) return;
    const name = renameText.trim();
    if (!name || /[/\\]/.test(name)) {
      Alert.alert('Invalid name');
      return;
    }
    try {
      await api.renameFile(renameTarget.path, joinRemotePath(getParentPath(renameTarget.path) ?? '', name));
      setRenameTarget(null);
      setRenameText('');
      void reload(api, path, '');
    } catch (error) {
      Alert.alert('Could not rename file', error instanceof Error ? error.message : 'Unknown error');
    }
  };
  const deleteEntry = (entry: FileEntry) => {
    Alert.alert(`Delete ${entry.name}?`, entry.isDir ? 'This deletes the folder and everything inside it.' : 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        if (!api) return;
        try {
          await api.deleteFile(entry.path);
          setSelectedEntry(null);
          void reload(api, path, '');
        } catch (error) {
          Alert.alert('Could not delete file', error instanceof Error ? error.message : 'Unknown error');
        }
      } },
    ]);
  };
  const download = async (entry: FileEntry, mode: 'download' | 'open') => {
    if (!api) return;
    try {
      const { url, headers } = api.downloadRequest(entry.path);
      if (Platform.OS === 'web') {
        const response = await fetch(url, { headers });
        if (!response.ok) throw new Error(response.statusText || 'Download failed');
        const blobURL = URL.createObjectURL(await response.blob());
        if (mode === 'open') {
          window.open(blobURL, '_blank', 'noopener,noreferrer');
        } else {
          const link = document.createElement('a');
          link.href = blobURL;
          link.download = entry.name;
          link.click();
        }
        setTimeout(() => URL.revokeObjectURL(blobURL), 1000);
        return;
      }
      const directory = new Directory(Paths.cache, 'agenticremote-downloads');
      directory.create({ idempotent: true, intermediates: true });
      const file = await File.downloadFileAsync(url, directory, { headers, idempotent: true });
      const mimeType = file.type ?? 'application/octet-stream';
      if (Platform.OS === 'android') {
        if (mode === 'open') {
          await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
            data: await FileSystem.getContentUriAsync(file.uri),
            type: mimeType,
            flags: 1,
          });
        } else {
          const permission = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
          if (!permission.granted) return;
          const destination = await FileSystem.StorageAccessFramework.createFileAsync(permission.directoryUri, entry.name, mimeType);
          await FileSystem.copyAsync({ from: file.uri, to: destination });
        }
      } else if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { dialogTitle: mode === 'open' ? 'Open with…' : 'Download file', mimeType });
      } else {
        Alert.alert('Downloaded file', file.uri);
      }
    } catch (error) {
      Alert.alert(mode === 'open' ? 'Could not open file' : 'Could not download file', error instanceof Error ? error.message : 'Unknown error');
    }
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
    {clipboard && <View style={styles.pasteBar}>
      <Text style={styles.pasteText} numberOfLines={1}>{clipboard.mode === 'copy' ? 'Copy' : 'Cut'} {clipboard.entry.name}</Text>
      <Pressable accessibilityLabel="Paste into current directory" style={styles.smallBtn} onPress={() => void paste()}><Text style={styles.smallBtnText}>Paste</Text></Pressable>
      <Pressable accessibilityLabel="Cancel paste" style={styles.ghostBtn} onPress={() => setClipboard(null)}><Text style={styles.ghostBtnText}>Cancel</Text></Pressable>
    </View>}
    {loading && <ActivityIndicator color="#46B8C4" style={styles.loader} />}
    {!loading && entries.length === 0 && <Text style={styles.empty}>{query ? 'No matching files' : 'No files in this directory'}</Text>}
    <FlatList
      data={entries}
      keyExtractor={(item) => item.path}
      renderItem={({ item }) => <Pressable accessibilityLabel={item.isDir ? `Open folder ${item.name}` : `Open file ${item.name}`} style={[styles.entry, selectedEntry?.path === item.path && styles.entrySelected]} onPress={() => void open(item)} onLongPress={() => setSelectedEntry(item)}>
        <Feather name={item.isDir ? 'folder' : 'file'} size={20} color={item.isDir ? '#46B8C4' : '#888'} />
        <View style={styles.entryInfo}>
          <Text style={styles.entryName} numberOfLines={1}>{item.name}</Text>
          {query && <Text style={styles.entryPath} numberOfLines={1}>{item.path}</Text>}
        </View>
        {gitCodes.has(item.path) && <Text style={styles.gitCode}>{gitCodes.get(item.path)}</Text>}
        {!item.isDir && item.size != null && <Text style={styles.size}>{formatBytes(item.size)}</Text>}
        {selectedEntry?.path === item.path && <View style={styles.entryActions}>
          <Pressable accessibilityLabel={`More actions ${item.name}`} style={styles.actionBtn} onPress={() => setMenuEntry(item)}>
            <Feather name="more-vertical" size={19} color="#D9FAFF" />
          </Pressable>
          <Pressable accessibilityLabel="Cancel selection" style={styles.actionBtn} onPress={() => setSelectedEntry(null)}>
            <Feather name="x" size={19} color="#D9FAFF" />
          </Pressable>
        </View>}
      </Pressable>}
    />
    <Modal visible={renameTarget != null} animationType="slide" onRequestClose={() => setRenameTarget(null)}>
      <SafeAreaView style={styles.screen}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalBody}>
          <Text style={styles.modalTitle}>Rename {renameTarget?.name}</Text>
          <TextInput accessibilityLabel="New name" style={styles.input} value={renameText} onChangeText={setRenameText} autoCapitalize="none" autoCorrect={false} />
          <View style={styles.modalActions}>
            <Pressable accessibilityLabel="Cancel rename" style={styles.ghostBtn} onPress={() => setRenameTarget(null)}><Text style={styles.ghostBtnText}>Cancel</Text></Pressable>
            <Pressable accessibilityLabel="Save rename" style={styles.smallBtn} onPress={() => void saveRename()}><Text style={styles.smallBtnText}>Save</Text></Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
    <Modal transparent visible={menuEntry != null} animationType="fade" onRequestClose={() => setMenuEntry(null)}>
      <Pressable style={styles.menuBackdrop} onPress={() => setMenuEntry(null)}>
        <View style={styles.menu}>
          {menuEntry && <>
            <Text style={styles.menuTitle} numberOfLines={1}>{menuEntry.name}</Text>
            <MenuButton label={`Copy ${menuEntry.name}`} icon="copy" onPress={() => { setClipboard({ mode: 'copy', entry: menuEntry }); setMenuEntry(null); }} />
            <MenuButton label={`Cut ${menuEntry.name}`} icon="scissors" onPress={() => { setClipboard({ mode: 'cut', entry: menuEntry }); setMenuEntry(null); }} />
            <MenuButton label={`Rename ${menuEntry.name}`} icon="edit-2" onPress={() => { setRenameTarget(menuEntry); setRenameText(menuEntry.name); setMenuEntry(null); }} />
            {!menuEntry.isDir && <MenuButton label={`Download ${menuEntry.name}`} icon="download" onPress={() => { const entry = menuEntry; setMenuEntry(null); void download(entry, 'download'); }} />}
            {!menuEntry.isDir && <MenuButton label={`Open with ${menuEntry.name}`} icon="external-link" onPress={() => { const entry = menuEntry; setMenuEntry(null); void download(entry, 'open'); }} />}
            <MenuButton label={`Delete ${menuEntry.name}`} icon="trash-2" onPress={() => { const entry = menuEntry; setMenuEntry(null); deleteEntry(entry); }} />
          </>}
        </View>
      </Pressable>
    </Modal>
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
  if (path === '/') return null;
  if (!path) return '..';
  const trimmed = path.replace(/\/$/, '');
  const index = trimmed.lastIndexOf('/');
  if (path.startsWith('/')) return index <= 0 ? '/' : trimmed.slice(0, index);
  if (trimmed === '..' || trimmed.startsWith('../')) return `${trimmed}/..`;
  return index < 0 ? '' : trimmed.slice(0, index);
}

function joinRemotePath(base: string, name: string) {
  if (!base) return name;
  if (base === '/') return `/${name}`;
  return `${base.replace(/\/$/, '')}/${name}`;
}

function MenuButton({ label, icon, onPress }: { label: string; icon: ComponentProps<typeof Feather>['name']; onPress: () => void }) {
  return <Pressable accessibilityLabel={label} style={styles.menuItem} onPress={onPress}>
    <Feather name={icon} size={18} color="#D9FAFF" />
    <Text style={styles.menuText}>{label}</Text>
  </Pressable>;
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
  ghostBtn: { minHeight: 46, paddingHorizontal: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#3A3A3A' },
  ghostBtnText: { color: '#F0F0F0', fontWeight: '700' },
  parent: { minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, gap: 12, borderBottomWidth: 1, borderColor: '#181818' },
  parentText: { color: '#F0F0F0', fontSize: 15 },
  pasteBar: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderBottomWidth: 1, borderColor: '#181818', backgroundColor: '#101B1D' },
  pasteText: { flex: 1, color: '#F0F0F0', fontWeight: '600' },
  disabled: { opacity: 0.35 },
  loader: { marginTop: 36 },
  empty: { color: '#888', textAlign: 'center', marginTop: 36 },
  entry: { minHeight: 64, paddingHorizontal: 16, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderColor: '#181818' },
  entrySelected: { backgroundColor: '#102124' },
  entryInfo: { flex: 1, minWidth: 0 },
  entryName: { color: '#F0F0F0', fontSize: 16 },
  entryPath: { color: '#888', fontSize: 12, marginTop: 2 },
  gitCode: { color: '#E8A05C', fontSize: 13, fontWeight: '700', minWidth: 20, textAlign: 'center' },
  size: { color: '#888', fontSize: 13 },
  entryActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionBtn: { width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#123338' },
  menuBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  menu: { margin: 12, padding: 8, borderRadius: 12, borderWidth: 1, borderColor: '#3A3A3A', backgroundColor: '#181818' },
  menuTitle: { color: '#F0F0F0', fontSize: 16, fontWeight: '700', padding: 12 },
  menuItem: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, borderRadius: 8 },
  menuText: { color: '#F0F0F0', fontSize: 15, fontWeight: '600' },
  modalBody: { flex: 1, justifyContent: 'center', gap: 14, padding: 20 },
  modalTitle: { color: '#F0F0F0', fontSize: 20, fontWeight: '700' },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  editor: { flex: 1, padding: 16, color: '#F0F0F0', fontSize: 15, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
});
