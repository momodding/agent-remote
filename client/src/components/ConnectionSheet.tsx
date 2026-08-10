import { useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { Switch } from 'react-native-gesture-handler';
import { BottomSheetScrollView, BottomSheetTextInput, BottomSheetView, TouchableOpacity } from '@gorhom/bottom-sheet';
import Feather from '@expo/vector-icons/Feather';
import { ActivityIndicator } from 'react-native';

import type { Connection, ConnectionStore } from '../lib/connection';
import { GlassBottomSheet, type GlassBottomSheetHandle } from './GlassBottomSheet';

type Props = {
  visible: boolean;
  store: ConnectionStore;
  onDismiss: () => void;
  onSelect: (endpoint: string) => Promise<void>;
  onSave: (originalEndpoint: string, replacement: Connection) => Promise<void>;
  onDelete: (endpoint: string) => Promise<void>;
  onAdd: () => void;
};

type Palette = { text: string; textSecondary: string; border: string; accent: string; danger: string };

function usePalette(): Palette {
  const colorScheme = useColorScheme();
  return colorScheme === 'dark'
    ? { text: '#F0F0F0', textSecondary: '#B8B8B8', border: '#3A3A3A', accent: '#46B8C4', danger: '#F19999' }
    : { text: '#1A1A1A', textSecondary: '#5A5A5A', border: '#D0D0D0', accent: '#0E8A96', danger: '#B23B3B' };
}

export function ConnectionSheet({ visible, store, onDismiss, onSelect, onSave, onDelete, onAdd }: Props) {
  const palette = usePalette();
  const sheetRef = useRef<GlassBottomSheetHandle>(null);
  const [editing, setEditing] = useState<Connection | null>(null);

  useEffect(() => {
    if (visible) sheetRef.current?.present();
    else sheetRef.current?.dismiss();
  }, [visible]);

  const close = () => { setEditing(null); onDismiss(); };
  const add = () => { setEditing(null); onAdd(); };
  const remove = (connection: Connection) => {
    Alert.alert('Delete daemon?', 'Pairing credentials for this daemon will be removed from this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void onDelete(connection.endpoint) },
    ]);
  };

  return (
    <GlassBottomSheet title="Daemon connections" onDismiss={close} ref={sheetRef}>
      <BottomSheetView style={styles.doneRow}>
        <TouchableOpacity accessibilityLabel="Done" style={styles.iconBtn} onPress={close}><Feather name="check" size={24} color={palette.accent} /></TouchableOpacity>
      </BottomSheetView>
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
        <BottomSheetScrollView contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
          {store.connections.map((connection) => (
            <View key={connection.endpoint} style={[styles.row, { borderColor: palette.border }]}>
              <View style={styles.rowMain}>
                <Text style={[styles.name, { color: palette.text }]} numberOfLines={1}>{connection.name}</Text>
                <Text style={[styles.endpoint, { color: palette.textSecondary }]} numberOfLines={1}>{connection.endpoint}</Text>
                {connection.endpoint === store.selectedEndpoint && <Text style={[styles.selected, { color: palette.accent }]}>Selected</Text>}
              </View>
              <View style={styles.rowActions}>
                <TouchableOpacity style={styles.iconBtn} accessibilityLabel={`Select ${connection.endpoint}`} onPress={() => void onSelect(connection.endpoint)}><Feather name="check-circle" size={20} color={palette.accent} /></TouchableOpacity>
                <TouchableOpacity style={styles.iconBtn} accessibilityLabel={`Edit ${connection.endpoint}`} onPress={() => setEditing(connection)}><Feather name="edit-2" size={20} color={palette.accent} /></TouchableOpacity>
                <TouchableOpacity style={styles.iconBtn} accessibilityLabel={`Delete ${connection.endpoint}`} onPress={() => remove(connection)}><Feather name="trash-2" size={20} color={palette.danger} /></TouchableOpacity>
              </View>
            </View>
          ))}
          <TouchableOpacity accessibilityLabel="Add daemon" style={styles.primary} onPress={add}><Feather name="plus" size={20} color="#0A0A0A" /></TouchableOpacity>
        </BottomSheetScrollView>
      )}
    </GlassBottomSheet>
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
    <BottomSheetScrollView contentContainerStyle={styles.editorContent} keyboardShouldPersistTaps="handled">
      <Text style={labelStyle}>Name</Text>
      <BottomSheetTextInput style={inputStyle} value={name} onChangeText={setName} placeholder="Name" placeholderTextColor="#888" />
      <Text style={labelStyle}>Endpoint</Text>
      <BottomSheetTextInput style={inputStyle} value={endpoint} onChangeText={setEndpoint} placeholder="Endpoint" placeholderTextColor="#888" autoCapitalize="none" />
      <Text style={labelStyle}>Fingerprint</Text>
      <BottomSheetTextInput style={inputStyle} value={fingerprint} onChangeText={setFingerprint} placeholder="Fingerprint" placeholderTextColor="#888" autoCapitalize="none" />
      <Text style={labelStyle}>Client name</Text>
      <BottomSheetTextInput style={inputStyle} value={clientName} onChangeText={setClientName} placeholder="Client name" placeholderTextColor="#888" autoCapitalize="none" />
      <Text style={labelStyle}>Session token</Text>
      <BottomSheetTextInput style={inputStyle} value={token} onChangeText={setToken} placeholder="Session token" placeholderTextColor="#888" secureTextEntry autoCapitalize="none" />
      <View style={styles.row}><Text style={labelStyle}>Skip fingerprint verification</Text><Switch value={skip} onValueChange={setSkip} /></View>
      <View style={styles.rowActions}>
        <TouchableOpacity accessibilityLabel="Cancel edit" style={styles.iconBtn} onPress={onCancel}><Feather name="x" size={24} color={palette.accent} /></TouchableOpacity>
        <TouchableOpacity accessibilityLabel="Save" style={styles.primaryBtn} disabled={saving} onPress={() => void save()}>{saving ? <ActivityIndicator color="#0A0A0A" /> : <Feather name="save" size={24} color="#0A0A0A" />}</TouchableOpacity>
      </View>
    </BottomSheetScrollView>
  );
}

const styles = StyleSheet.create({
  doneRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 20, paddingBottom: 8 },
  cancel: { fontSize: 16 },
  iconBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  listContent: { paddingHorizontal: 20, paddingBottom: 24 },
  editorContent: { paddingHorizontal: 20, paddingBottom: 24, gap: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, borderBottomWidth: 1, paddingVertical: 12 },
  rowMain: { flex: 1, minWidth: 0 },
  name: { fontWeight: '700', fontSize: 16 },
  endpoint: { fontSize: 12, marginTop: 2 },
  selected: { fontWeight: '700', fontSize: 12, marginTop: 2 },
  rowActions: { flexDirection: 'row', gap: 14 },
  link: { fontWeight: '600' },
  danger: { fontWeight: '600' },
  primaryBtn: { minWidth: 44, minHeight: 44, borderRadius: 8, backgroundColor: '#D19A2C', alignItems: 'center', justifyContent: 'center' },
  label: { fontWeight: '600', marginTop: 10, marginBottom: 6 },
  input: { minHeight: 46, borderWidth: 1, borderRadius: 8, padding: 12 },
  primary: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 8, backgroundColor: '#D19A2C', marginTop: 8 },
  primaryText: { color: '#0A0A0A', fontWeight: '700' },
});
