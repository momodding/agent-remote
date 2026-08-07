import { useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { Pressable, Switch } from 'react-native-gesture-handler';
import { BottomSheetScrollView, BottomSheetTextInput, BottomSheetView } from '@gorhom/bottom-sheet';

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
        <Pressable accessibilityLabel="Done" onPress={close}><Text style={[styles.cancel, { color: palette.accent }]}>Done</Text></Pressable>
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
                <Pressable accessibilityLabel={`Select ${connection.endpoint}`} onPress={() => void onSelect(connection.endpoint)}><Text style={[styles.link, { color: palette.accent }]}>Select</Text></Pressable>
                <Pressable accessibilityLabel={`Edit ${connection.endpoint}`} onPress={() => setEditing(connection)}><Text style={[styles.link, { color: palette.accent }]}>Edit</Text></Pressable>
                <Pressable accessibilityLabel={`Delete ${connection.endpoint}`} onPress={() => remove(connection)}><Text style={[styles.danger, { color: palette.danger }]}>Delete</Text></Pressable>
              </View>
            </View>
          ))}
          <Pressable accessibilityLabel="Add daemon" style={styles.primary} onPress={add}><Text style={styles.primaryText}>Add daemon</Text></Pressable>
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
        <Pressable accessibilityLabel="Cancel edit" onPress={onCancel}><Text style={[styles.link, { color: palette.accent }]}>Cancel</Text></Pressable>
        <Pressable accessibilityLabel="Save" style={styles.primary} disabled={saving} onPress={() => void save()}><Text style={styles.primaryText}>{saving ? 'Saving…' : 'Save changes'}</Text></Pressable>
      </View>
    </BottomSheetScrollView>
  );
}

const styles = StyleSheet.create({
  doneRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 20, paddingBottom: 8 },
  cancel: { fontSize: 16 },
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
  label: { fontWeight: '600', marginTop: 10, marginBottom: 6 },
  input: { minHeight: 46, borderWidth: 1, borderRadius: 8, padding: 12 },
  primary: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 8, backgroundColor: '#D19A2C', marginTop: 8 },
  primaryText: { color: '#0A0A0A', fontWeight: '700' },
});
