import { useState } from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
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
  const [command, setCommand] = useState('bash');

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
      <Pressable style={styles.backdrop} onPress={() => setVisible(false)}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={{ paddingTop: insets.top }}>
            <View style={styles.header}>
              <Text style={styles.title}>New Session</Text>
              <Pressable onPress={() => setVisible(false)}>
                <Text style={styles.cancel}>Cancel</Text>
              </Pressable>
            </View>
            <View style={styles.form}>
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
              <TextInput
                style={styles.input}
                value={command}
                onChangeText={setCommand}
                placeholder="bash"
                placeholderTextColor="#666"
              />
              <Pressable style={styles.create} onPress={create}>
                <Text style={styles.createText}>Create</Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      </Pressable>
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
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
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
