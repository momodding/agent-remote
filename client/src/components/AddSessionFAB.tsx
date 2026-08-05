import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AgenticRemoteAPI } from '../lib/api';

type Props = {
  api: AgenticRemoteAPI;
  onAdd: (sessionId: string, name: string) => void;
  disabled: boolean;
};

export function AddSessionFAB({ api, onAdd, disabled }: Props) {
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [shells, setShells] = useState<string[]>([]);

  useEffect(() => {
    if (visible) {
      api.shells().then(setShells).catch(() => setShells([]));
    }
  }, [visible, api]);


  const create = async () => {
    if (!name.trim()) {
      Alert.alert('Name required', 'Enter a session name');
      return;
    }
    try {
      const session = await api.createSession({ name: name.trim(), command, args: [], cwd: '', cols: 80, rows: 24 });
      onAdd(session.id, session.name);
      setVisible(false);
      setName('');
      setCommand('bash');
    } catch (error) {
      Alert.alert('Could not create session', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  return <>
    <Pressable
      style={[styles.fab, disabled && styles.fabDisabled]}
      onPress={() => setVisible(true)}
      disabled={disabled}
      accessibilityLabel="Add session"
    >
      <Text style={styles.fabText}>+</Text>
    </Pressable>
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
      <Pressable style={styles.backdrop} onPress={() => setVisible(false)} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.sheet}>
          <View style={{ paddingTop: insets.top }}>
            <View style={styles.header}>
              <Text style={styles.title}>New Session</Text>
              <Pressable onPress={() => setVisible(false)}>
                <Text style={styles.cancel}>Cancel</Text>
              </Pressable>
            </View>
            <ScrollView style={styles.formScroll} contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>Name</Text>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder="e.g. Build, Tests, Logs"
                placeholderTextColor="#666"
                autoFocus
              />
              <Text style={styles.label}>Command</Text>
              <ScrollView style={styles.radioList} nestedScrollEnabled>
                <Pressable
                  style={styles.radioRow}
                  onPress={() => setCommand('')}
                  accessibilityLabel="Default shell"
                >
                  <View style={styles.radioOuter}>{command === '' && <View style={styles.radioInner} />}</View>
                  <Text style={styles.radioLabel}>Default shell</Text>
                </Pressable>
                {shells.map((shell) => (
                  <Pressable
                    key={shell}
                    style={styles.radioRow}
                    onPress={() => setCommand(shell)}
                    accessibilityLabel={shell}
                  >
                    <View style={styles.radioOuter}>{command === shell && <View style={styles.radioInner} />}</View>
                    <Text style={styles.radioLabel}>{shell}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <Pressable style={styles.create} onPress={create}>
                <Text style={styles.createText}>Create</Text>
              </Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#46B8C4',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  fabDisabled: {
    backgroundColor: '#3A3A3A',
  },
  fabText: {
    color: '#0A0A0A',
    fontSize: 32,
    fontWeight: '700',
  },
  backdrop: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '85%',
    backgroundColor: '#181818',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    minHeight: 300,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderColor: '#262626',
  },
  title: {
    color: '#F0F0F0',
    fontSize: 20,
    fontWeight: '700',
  },
  cancel: {
    color: '#46B8C4',
    fontSize: 16,
  },
  formScroll: { maxHeight: '100%' },
  form: {
    padding: 16,
    gap: 12,
  },
  label: {
    color: '#F0F0F0',
    fontWeight: '600',
    marginTop: 4,
  },
  input: {
    minHeight: 46,
    borderWidth: 1,
    borderColor: '#3A3A3A',
    borderRadius: 8,
    color: '#F0F0F0',
    padding: 12,
  },
  radioList: { maxHeight: 180 },
  radioRow: { flexDirection: 'row', alignItems: 'center', minHeight: 46, paddingVertical: 8, gap: 12 },
  radioOuter: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: '#46B8C4', alignItems: 'center', justifyContent: 'center' },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#46B8C4' },
  radioLabel: { color: '#F0F0F0', fontSize: 16 },
  create: {
    minHeight: 48,
    borderRadius: 8,
    backgroundColor: '#46B8C4',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  createText: {
    color: '#0A0A0A',
    fontWeight: '800',
  },
});
