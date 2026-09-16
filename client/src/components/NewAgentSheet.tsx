import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import type { AgenticRemoteAPI } from '../lib/api';
import type { FileEntry } from '../protocol';

type Props = {
  visible: boolean;
  onDismiss: () => void;
  onSubmit: (config: { cwd: string; backend: 'auto' | 'tmux' | 'pty' }) => Promise<void>;
  api?: AgenticRemoteAPI | null;
};

type Palette = {
  text: string;
  textSecondary: string;
  border: string;
  accent: string;
  danger: string;
  surface: string;
  card: string;
};

function usePalette(): Palette {
  const scheme = useColorScheme();
  return scheme === 'dark'
    ? {
        text: '#F0F0F0',
        textSecondary: '#B8B8B8',
        border: '#3A3A3A',
        accent: '#46B8C4',
        danger: '#F19999',
        surface: '#181818',
        card: '#222222',
      }
    : {
        text: '#1A1A1A',
        textSecondary: '#5A5A5A',
        border: '#D0D0D0',
        accent: '#0E8A96',
        danger: '#B23B3B',
        surface: '#EDEDED',
        card: '#FAFAFA',
      };
}

export function NewAgentSheet({ visible, onDismiss, onSubmit, api }: Props) {
  const palette = usePalette();
  const [cwd, setCwd] = useState('');
  const [browsePath, setBrowsePath] = useState('');
  const [directories, setDirectories] = useState<FileEntry[]>([]);
  const [loadingDirs, setLoadingDirs] = useState(false);
  const [backend, setBackend] = useState<'auto' | 'tmux' | 'pty'>('auto');
  const [busy, setBusy] = useState(false);

  const loadDirectories = useCallback(
    async (path: string) => {
      if (!api) return;
      setLoadingDirs(true);
      try {
        const entries = await api.files(path);
        const dirs = entries.filter((e) => e.isDir);
        setDirectories(dirs);
      } catch {
        setDirectories([]);
      } finally {
        setLoadingDirs(false);
      }
    },
    [api]
  );

  useEffect(() => {
    if (visible) {
      setCwd('');
      setBrowsePath('');
      if (api) {
        loadDirectories('');
      }
    }
  }, [visible, api, loadDirectories]);

  const handleNavigate = (path: string) => {
    setBrowsePath(path);
    setCwd(path);
    loadDirectories(path);
  };

  const handleNavigateUp = () => {
    if (!browsePath) return;
    const parts = browsePath.split('/').filter(Boolean);
    parts.pop();
    const parent = parts.join('/');
    setBrowsePath(parent);
    setCwd(parent);
    loadDirectories(parent);
  };

  const handleCreate = async () => {
    const trimmed = cwd.trim();
    if (trimmed.startsWith('/') || trimmed.includes('..')) {
      Alert.alert(
        'Invalid Workspace Path',
        "Workspace path must be relative to workspace root and cannot contain '..' or absolute paths."
      );
      return;
    }
    setBusy(true);
    try {
      await onSubmit({ cwd: trimmed, backend });
      onDismiss();
    } catch (error) {
      Alert.alert('Failed to create agent', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onDismiss}>
      <SafeAreaView style={[styles.sheet, { backgroundColor: palette.surface }]}>
        <KeyboardAvoidingView style={styles.sheet} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.titleRow}>
              <Text style={[styles.title, { color: palette.text }]}>New OMP Agent</Text>
              <Pressable accessibilityLabel="Cancel" style={styles.iconBtn} onPress={onDismiss}>
                <Text style={{ color: palette.textSecondary, fontSize: 16 }}>Cancel</Text>
              </Pressable>
            </View>

            {/* Workspace Directory Browser */}
            <View style={styles.field}>
              <Text style={[styles.label, { color: palette.text }]}>Workspace Directory</Text>

              {api ? (
                <View style={[styles.browserCard, { backgroundColor: palette.card, borderColor: palette.border }]}>
                  {/* Browser Nav / Breadcrumb */}
                  <View style={styles.browserHeader}>
                    <View style={styles.browserPathRow}>
                      <Pressable
                        accessibilityLabel="Workspace Root"
                        style={styles.navRootBtn}
                        onPress={() => handleNavigate('')}
                      >
                        <Feather name="home" size={14} color={palette.accent} />
                        <Text style={[styles.navRootText, { color: palette.accent }]}>root</Text>
                      </Pressable>
                      {browsePath ? (
                        <Text style={[styles.browserPathText, { color: palette.textSecondary }]} numberOfLines={1}>
                          / {browsePath}
                        </Text>
                      ) : null}
                    </View>

                    {browsePath ? (
                      <Pressable
                        accessibilityLabel="Navigate up"
                        style={[styles.upBtn, { borderColor: palette.border }]}
                        onPress={handleNavigateUp}
                      >
                        <Feather name="corner-left-up" size={14} color={palette.text} />
                        <Text style={[styles.upBtnText, { color: palette.text }]}>Up</Text>
                      </Pressable>
                    ) : null}
                  </View>

                  {/* Directory list */}
                  {loadingDirs ? (
                    <View style={styles.loadingContainer}>
                      <ActivityIndicator size="small" color={palette.accent} />
                    </View>
                  ) : (
                    <View style={styles.dirList}>
                      {directories.length === 0 ? (
                        <Text style={[styles.emptyDirsText, { color: palette.textSecondary }]}>
                          No subdirectories found
                        </Text>
                      ) : (
                        directories.map((dir) => (
                          <Pressable
                            key={dir.path}
                            accessibilityLabel={`Directory ${dir.name}`}
                            style={[styles.dirItem, { borderColor: palette.border }]}
                            onPress={() => handleNavigate(dir.path)}
                          >
                            <Feather name="folder" size={16} color={palette.accent} />
                            <Text style={[styles.dirName, { color: palette.text }]} numberOfLines={1}>
                              {dir.name}
                            </Text>
                            <Feather name="chevron-right" size={14} color={palette.textSecondary} />
                          </Pressable>
                        ))
                      )}
                    </View>
                  )}

                  {/* Quick selection confirmation */}
                  <View style={styles.selectRow}>
                    <Pressable
                      accessibilityLabel="Select Current Directory"
                      style={[styles.selectDirBtn, { backgroundColor: palette.accent + '22', borderColor: palette.accent }]}
                      onPress={() => setCwd(browsePath)}
                    >
                      <Text style={[styles.selectDirText, { color: palette.accent }]}>
                        {browsePath ? `Use "${browsePath}"` : 'Use Workspace Root'}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}

              {/* Manual input / override */}
              <View style={styles.manualField}>
                <Text style={[styles.manualLabel, { color: palette.textSecondary }]}>Selected Relative Path:</Text>
                <TextInput
                  style={[styles.input, { color: palette.text, borderColor: palette.border }]}
                  placeholder="e.g. src or leave empty for root"
                  placeholderTextColor={palette.textSecondary}
                  value={cwd}
                  onChangeText={setCwd}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Workspace Path"
                />
                <Text style={[styles.hint, { color: palette.textSecondary }]}>
                  Relative path inside daemon workspace root. Absolute paths and '..' are rejected.
                </Text>
              </View>
            </View>

            {/* Runtime Backend selection */}
            <View style={styles.field}>
              <Text style={[styles.label, { color: palette.text }]}>Runtime Backend</Text>
              <View style={styles.backendRow}>
                {(['auto', 'tmux', 'pty'] as const).map((b) => {
                  const selected = backend === b;
                  return (
                    <Pressable
                      key={b}
                      accessibilityLabel={`Backend ${b}`}
                      style={[
                        styles.backendOption,
                        { borderColor: palette.border },
                        selected && { borderColor: palette.accent, backgroundColor: palette.accent + '22' },
                      ]}
                      onPress={() => setBackend(b)}
                    >
                      <Text style={[styles.backendText, { color: selected ? palette.accent : palette.text }]}>
                        {b.toUpperCase()}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <Pressable
              accessibilityLabel="Create Agent"
              style={[styles.submitBtn, { backgroundColor: palette.accent }, busy && { opacity: 0.6 }]}
              disabled={busy}
              onPress={handleCreate}
            >
              <Text style={styles.submitText}>Start Agent</Text>
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  content: { padding: 24, gap: 20 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  title: { fontSize: 22, fontWeight: '700' },
  iconBtn: { padding: 8 },
  field: { gap: 8 },
  label: { fontSize: 14, fontWeight: '600' },
  browserCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 10,
  },
  browserHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  browserPathRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 6,
  },
  navRootBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: 4,
  },
  navRootText: {
    fontWeight: '600',
    fontSize: 13,
  },
  browserPathText: {
    fontSize: 13,
    flex: 1,
  },
  upBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  upBtnText: {
    fontSize: 12,
    fontWeight: '500',
  },
  loadingContainer: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  dirList: {
    gap: 6,
    maxHeight: 180,
  },
  emptyDirsText: {
    fontSize: 13,
    fontStyle: 'italic',
    paddingVertical: 8,
    textAlign: 'center',
  },
  dirItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  dirName: {
    flex: 1,
    fontSize: 14,
  },
  selectRow: {
    marginTop: 4,
  },
  selectDirBtn: {
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectDirText: {
    fontWeight: '600',
    fontSize: 13,
  },
  manualField: {
    gap: 6,
    marginTop: 4,
  },
  manualLabel: {
    fontSize: 12,
    fontWeight: '500',
  },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, height: 44, fontSize: 16 },
  hint: { fontSize: 12 },
  backendRow: { flexDirection: 'row', gap: 12 },
  backendOption: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backendText: { fontWeight: '600', fontSize: 14 },
  submitBtn: { borderRadius: 8, height: 48, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  submitText: { color: '#0A0A0A', fontSize: 16, fontWeight: '600' },
});
