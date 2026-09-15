import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type Props = {
  visible: boolean;
  onDismiss: () => void;
  onSubmit: (config: { cwd: string; backend: 'auto' | 'tmux' | 'pty' }) => Promise<void>;
};

type Palette = { text: string; textSecondary: string; border: string; accent: string; danger: string; surface: string };

function usePalette(): Palette {
  const scheme = useColorScheme();
  return scheme === 'dark'
    ? { text: '#F0F0F0', textSecondary: '#B8B8B8', border: '#3A3A3A', accent: '#46B8C4', danger: '#F19999', surface: '#181818' }
    : { text: '#1A1A1A', textSecondary: '#5A5A5A', border: '#D0D0D0', accent: '#0E8A96', danger: '#B23B3B', surface: '#EDEDED' };
}

export function NewAgentSheet({ visible, onDismiss, onSubmit }: Props) {
  const palette = usePalette();
  const [cwd, setCwd] = useState('');
  const [backend, setBackend] = useState<'auto' | 'tmux' | 'pty'>('auto');
  const [busy, setBusy] = useState(false);

  const handleCreate = async () => {
    const trimmed = cwd.trim();
    if (trimmed.startsWith('/') || trimmed.includes('..')) {
      Alert.alert('Invalid Workspace Path', "Workspace path must be relative to workspace root and cannot contain '..' or absolute paths.");
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

            <View style={styles.field}>
              <Text style={[styles.label, { color: palette.text }]}>Workspace Path (relative, optional)</Text>
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
                        selected && { borderColor: palette.accent, backgroundColor: palette.accent + '22' }
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
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, height: 44, fontSize: 16 },
  hint: { fontSize: 12 },
  backendRow: { flexDirection: 'row', gap: 12 },
  backendOption: { flex: 1, borderWidth: 1, borderRadius: 8, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  backendText: { fontWeight: '600', fontSize: 14 },
  submitBtn: { borderRadius: 8, height: 48, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  submitText: { color: '#0A0A0A', fontSize: 16, fontWeight: '700' },
});
