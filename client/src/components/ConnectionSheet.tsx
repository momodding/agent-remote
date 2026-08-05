import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Connection, ConnectionStore } from '../lib/connection';

type Props = {
  visible: boolean;
  store: ConnectionStore;
  onDismiss: () => void;
  onSelect: (endpoint: string) => Promise<void>;
  onSave: (originalEndpoint: string, replacement: Connection) => Promise<void>;
  onDelete: (endpoint: string) => Promise<void>;
  onAdd: () => void;
};

export function ConnectionSheet({ visible, store, onDismiss, onSelect, onSave, onDelete, onAdd }: Props) {
  const insets = useSafeAreaInsets();
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
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.sheet, { paddingTop: Math.max(insets.top, 20) }]}>
        <View style={styles.header}><Text style={styles.title}>Daemon connections</Text><Pressable accessibilityLabel="Done" onPress={close}><Text style={styles.cancel}>Done</Text></Pressable></View>
        {editing ? (
          <Editor
            connection={editing}
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
            <ScrollView style={styles.list}>
              {store.connections.map((connection) => (
                <View key={connection.endpoint} style={styles.row}>
                  <View style={styles.rowMain}>
                    <Text style={styles.name} numberOfLines={1}>{connection.name}</Text>
                    <Text style={styles.endpoint} numberOfLines={1}>{connection.endpoint}</Text>
                    {connection.endpoint === store.selectedEndpoint && <Text style={styles.selected}>Selected</Text>}
                  </View>
                  <View style={styles.rowActions}>
                    <Pressable accessibilityLabel={`Select ${connection.endpoint}`} onPress={() => void onSelect(connection.endpoint)}><Text style={styles.link}>Select</Text></Pressable>
                    <Pressable accessibilityLabel={`Edit ${connection.endpoint}`} onPress={() => setEditing(connection)}><Text style={styles.link}>Edit</Text></Pressable>
                    <Pressable accessibilityLabel={`Delete ${connection.endpoint}`} onPress={() => remove(connection)}><Text style={styles.danger}>Delete</Text></Pressable>
                  </View>
                </View>
              ))}
            </ScrollView>
            <Pressable accessibilityLabel="Add daemon" style={styles.primary} onPress={add}><Text style={styles.primaryText}>Add daemon</Text></Pressable>
          </>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Editor({ connection, onCancel, onSave }: { connection: Connection; onCancel: () => void; onSave: (replacement: Connection) => Promise<void> }) {
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

  return (
    <ScrollView style={styles.list}>
      <Text style={styles.label}>Name</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Name" placeholderTextColor="#888" />
      <Text style={styles.label}>Endpoint</Text>
      <TextInput style={styles.input} value={endpoint} onChangeText={setEndpoint} placeholder="Endpoint" placeholderTextColor="#888" autoCapitalize="none" />
      <Text style={styles.label}>Fingerprint</Text>
      <TextInput style={styles.input} value={fingerprint} onChangeText={setFingerprint} placeholder="Fingerprint" placeholderTextColor="#888" autoCapitalize="none" />
      <Text style={styles.label}>Client name</Text>
      <TextInput style={styles.input} value={clientName} onChangeText={setClientName} placeholder="Client name" placeholderTextColor="#888" autoCapitalize="none" />
      <Text style={styles.label}>Session token</Text>
      <TextInput style={styles.input} value={token} onChangeText={setToken} placeholder="Session token" placeholderTextColor="#888" secureTextEntry autoCapitalize="none" />
      <View style={styles.row}><Text style={styles.label}>Skip fingerprint verification</Text><Switch value={skip} onValueChange={setSkip} /></View>
      <View style={styles.rowActions}>
        <Pressable accessibilityLabel="Cancel edit" onPress={onCancel}><Text style={styles.link}>Cancel</Text></Pressable>
        <Pressable accessibilityLabel="Save" style={styles.primary} disabled={saving} onPress={() => void save()}><Text style={styles.primaryText}>{saving ? 'Saving…' : 'Save changes'}</Text></Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, gap: 14, padding: 20, backgroundColor: '#0A0A0A' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: '#F0F0F0', fontSize: 22, fontWeight: '700' },
  cancel: { color: '#46B8C4', fontSize: 16 },
  list: { flex: 1 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderColor: '#262626', paddingVertical: 12 },
  rowMain: { flex: 1, minWidth: 0 },
  name: { color: '#F0F0F0', fontWeight: '700', fontSize: 16 },
  endpoint: { color: '#B8B8B8', fontSize: 12, marginTop: 2 },
  selected: { color: '#46B8C4', fontWeight: '700', fontSize: 12, marginTop: 2 },
  rowActions: { flexDirection: 'row', gap: 14 },
  link: { color: '#46B8C4', fontWeight: '600' },
  danger: { color: '#F19999', fontWeight: '600' },
  label: { color: '#F0F0F0', fontWeight: '600', marginTop: 10, marginBottom: 6 },
  input: { minHeight: 46, borderWidth: 1, borderColor: '#3A3A3A', borderRadius: 8, color: '#F0F0F0', padding: 12 },
  primary: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 8, backgroundColor: '#D19A2C', marginTop: 8 },
  primaryText: { color: '#0A0A0A', fontWeight: '700' },
});
