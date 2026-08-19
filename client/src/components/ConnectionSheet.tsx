import { useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';

import { AgenticRemoteAPI } from '../lib/api';
import type { Connection, ConnectionStore } from '../lib/connection';
import { ConnectionStatusIndicator } from './ConnectionStatusIndicator';

type Props = {
  visible: boolean;
  store: ConnectionStore;
  onDismiss: () => void;
  onSelect: (endpoint: string) => Promise<void>;
  onSave: (originalEndpoint: string, replacement: Connection) => Promise<void>;
  onDelete: (endpoint: string) => Promise<void>;
  onAdd: () => void;
};

type Palette = { text: string; textSecondary: string; border: string; accent: string; danger: string; surface: string };

function usePalette(): Palette {
  const colorScheme = useColorScheme();
  return colorScheme === 'dark'
    ? { text: '#F0F0F0', textSecondary: '#B8B8B8', border: '#3A3A3A', accent: '#46B8C4', danger: '#F19999', surface: '#181818' }
    : { text: '#1A1A1A', textSecondary: '#5A5A5A', border: '#D0D0D0', accent: '#0E8A96', danger: '#B23B3B', surface: '#EDEDED' };
}

export function ConnectionSheet({ visible, store, onDismiss, onSelect, onSave, onDelete, onAdd }: Props) {
  const palette = usePalette();
  const [editing, setEditing] = useState<Connection | null>(null);

  const close = () => { setEditing(null); onDismiss(); };
  const add = () => { setEditing(null); onAdd(); };
  const remove = (connection: Connection) => {
    Alert.alert('Delete daemon?', 'Pairing credentials for this daemon will be removed from this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void onDelete(connection.endpoint) },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <SafeAreaView style={[styles.sheet, { backgroundColor: palette.surface }]}>
        <KeyboardAvoidingView style={styles.sheet} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={editing ? styles.editorContent : styles.listContent} keyboardShouldPersistTaps="handled">
            <View style={styles.titleRow}>
              <Text style={[styles.title, { color: palette.text }]}>Daemon connections</Text>
              <Pressable accessibilityLabel="Done" style={styles.iconBtn} onPress={close}><Feather name="check" size={24} color={palette.accent} /></Pressable>
            </View>
            {editing ? (
              <Editor
                connection={editing}
                palette={palette}
                onCancel={() => setEditing(null)}
                onSave={async (replacement) => {
                  try {
                    await onSave(editing.endpoint, replacement);
                    setEditing(null);
                  } catch (error) {
                    Alert.alert('Could not update daemon', error instanceof Error ? error.message : 'Unknown error');
                  }
                }}
              />
            ) : (
              <>
                {store.connections.map((connection) => (
                  <View key={connection.endpoint} style={[styles.row, { borderColor: palette.border }]}>
                    <View style={styles.rowMain}>
                      <Text style={[styles.name, { color: palette.text }]} numberOfLines={1}>{connection.name}</Text>
                      <Text style={[styles.endpoint, { color: palette.textSecondary }]} numberOfLines={1}>{connection.endpoint}</Text>
                      <ConnectionStatusIndicator api={new AgenticRemoteAPI(connection)} showLatency />
                      {connection.endpoint === store.selectedEndpoint && <Text style={[styles.selected, { color: palette.accent }]}>Selected</Text>}
                    </View>
                    <View style={styles.rowActions}>
                      <Pressable style={styles.iconBtn} accessibilityLabel={`Select ${connection.endpoint}`} onPress={() => void onSelect(connection.endpoint)}><Feather name="check-circle" size={20} color={palette.accent} /></Pressable>
                      <Pressable style={styles.iconBtn} accessibilityLabel={`Edit ${connection.endpoint}`} onPress={() => setEditing(connection)}><Feather name="edit-2" size={20} color={palette.accent} /></Pressable>
                      <Pressable style={styles.iconBtn} accessibilityLabel={`Delete ${connection.endpoint}`} onPress={() => remove(connection)}><Feather name="trash-2" size={20} color={palette.danger} /></Pressable>
                    </View>
                  </View>
                ))}
                <Pressable accessibilityLabel="Add daemon" style={styles.primary} onPress={add}><Feather name="plus" size={20} color="#0A0A0A" /></Pressable>
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

function Editor({ connection, palette, onCancel, onSave }: { connection: Connection; palette: Palette; onCancel: () => void; onSave: (replacement: Connection) => Promise<void> }) {
  const [name, setName] = useState(connection.name);
  const [endpoint, setEndpoint] = useState(connection.endpoint);
  const [fingerprint, setFingerprint] = useState(connection.fingerprint);
  const [clientName, setClientName] = useState(connection.clientName);
  const [token, setToken] = useState(connection.token);
  const [skip, setSkip] = useState(connection.skipFingerprintVerification);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await onSave({ name, endpoint, fingerprint, clientName, token, skipFingerprintVerification: skip });
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = [styles.input, { color: palette.text, borderColor: palette.border }];
  const labelStyle = [styles.label, { color: palette.text }];

  return (
    <>
      <Text style={labelStyle}>Name</Text>
      <TextInput style={inputStyle} value={name} onChangeText={setName} placeholder="Name" placeholderTextColor="#888" />
      <Text style={labelStyle}>Endpoint</Text>
      <TextInput style={inputStyle} value={endpoint} onChangeText={setEndpoint} placeholder="Endpoint" placeholderTextColor="#888" autoCapitalize="none" />
      <Text style={labelStyle}>Fingerprint</Text>
      <TextInput style={inputStyle} value={fingerprint} onChangeText={setFingerprint} placeholder="Fingerprint" placeholderTextColor="#888" autoCapitalize="none" />
      <Text style={labelStyle}>Client name</Text>
      <TextInput style={inputStyle} value={clientName} onChangeText={setClientName} placeholder="Client name" placeholderTextColor="#888" autoCapitalize="none" />
      <Text style={labelStyle}>Session token</Text>
      <TextInput style={inputStyle} value={token} onChangeText={setToken} placeholder="Session token" placeholderTextColor="#888" secureTextEntry autoCapitalize="none" />
      <View style={styles.row}><Text style={labelStyle}>Skip fingerprint verification</Text><Switch value={skip} onValueChange={setSkip} /></View>
      <View style={styles.rowActions}>
        <Pressable accessibilityLabel="Cancel edit" style={styles.iconBtn} onPress={onCancel}><Feather name="x" size={24} color={palette.accent} /></Pressable>
        <Pressable accessibilityLabel="Save" style={styles.primaryBtn} disabled={saving} onPress={() => void save()}>{saving ? <ActivityIndicator color="#0A0A0A" /> : <Feather name="save" size={24} color="#0A0A0A" />}</Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 12 },
  title: { fontSize: 20, fontWeight: '700' },
  iconBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  listContent: { padding: 20 },
  editorContent: { padding: 20, gap: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, borderBottomWidth: 1, paddingVertical: 12 },
  rowMain: { flex: 1, minWidth: 0 },
  name: { fontWeight: '700', fontSize: 16 },
  endpoint: { fontSize: 12, marginTop: 2 },
  selected: { fontWeight: '700', fontSize: 12, marginTop: 2 },
  rowActions: { flexDirection: 'row', gap: 14 },
  primaryBtn: { minWidth: 44, minHeight: 44, borderRadius: 8, backgroundColor: '#D19A2C', alignItems: 'center', justifyContent: 'center' },
  label: { fontWeight: '600', marginTop: 10, marginBottom: 6 },
  input: { minHeight: 46, borderWidth: 1, borderRadius: 8, padding: 12 },
  primary: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 8, backgroundColor: '#D19A2C', marginTop: 8 },
  primaryText: { color: '#0A0A0A', fontWeight: '700' },
});
