import { useEffect, useRef, useState } from 'react';
import Feather from '@expo/vector-icons/Feather';
import { Alert, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { BottomSheetScrollView, BottomSheetTextInput, TouchableOpacity } from '@gorhom/bottom-sheet';
import type { AgenticRemoteAPI } from '../lib/api';
import { GlassBottomSheet, type GlassBottomSheetHandle } from './GlassBottomSheet';

type Props = {
  api: AgenticRemoteAPI;
  onAdd: (sessionId: string, name: string) => void;
  disabled: boolean;
  bottomInset: number;
};

export function AddSessionFAB({ api, onAdd, disabled, bottomInset }: Props) {
  const colorScheme = useColorScheme();
  const palette = colorScheme === 'dark'
    ? { text: '#F0F0F0', border: '#3A3A3A', accent: '#46B8C4' }
    : { text: '#1A1A1A', border: '#D0D0D0', accent: '#0E8A96' };
  const sheetRef = useRef<GlassBottomSheetHandle>(null);
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
      sheetRef.current?.dismiss();
      setName('');
      setCommand('');
    } catch (error) {
      Alert.alert('Could not create session', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  return <>
    <Pressable
      style={[styles.fab, disabled && styles.fabDisabled, { bottom: 20 + bottomInset }]}
      onPress={() => { setVisible(true); sheetRef.current?.present(); }}
      disabled={disabled}
      accessibilityLabel="Add session"
    >
      <Feather name="plus" size={28} color="#0A0A0A" />
    </Pressable>
    <GlassBottomSheet title="New Session" onDismiss={() => setVisible(false)} ref={sheetRef}>
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={[styles.form, { paddingBottom: bottomInset + 24 }]} keyboardShouldPersistTaps="handled">
        <Text style={[styles.label, { color: palette.text }]}>Name</Text>
        <BottomSheetTextInput
          style={[styles.input, { color: palette.text, borderColor: palette.border }]}
          value={name}
          onChangeText={setName}
          placeholder="e.g. Build, Tests, Logs"
          placeholderTextColor="#666"
          autoFocus
        />
        <Text style={[styles.label, { color: palette.text }]}>Command</Text>
        <View style={styles.radioList}>
          <TouchableOpacity
            style={styles.radioRow}
            onPress={() => setCommand('')}
            accessibilityLabel="Default shell"
            activeOpacity={0.7}
          >
            <View style={[styles.radioOuter, { borderColor: palette.accent }]}>{command === '' && <View style={[styles.radioInner, { backgroundColor: palette.accent }]} />}</View>
            <Text style={[styles.radioLabel, { color: palette.text }]}>Default shell</Text>
          </TouchableOpacity>
          {shells.map((shell) => (
            <TouchableOpacity
              key={shell}
              style={styles.radioRow}
              onPress={() => setCommand(shell)}
              accessibilityLabel={shell}
              activeOpacity={0.7}
            >
              <View style={[styles.radioOuter, { borderColor: palette.accent }]}>{command === shell && <View style={[styles.radioInner, { backgroundColor: palette.accent }]} />}</View>
              <Text style={[styles.radioLabel, { color: palette.text }]}>{shell}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity style={[styles.create, { backgroundColor: palette.accent }]} onPress={create} accessibilityLabel="Create" activeOpacity={0.7}>
          <Feather name="check" size={22} color="#0A0A0A" />
        </TouchableOpacity>
      </BottomSheetScrollView>
    </GlassBottomSheet>
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
  form: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 24,
    gap: 12,
  },
  label: {
    fontWeight: '600',
    marginTop: 4,
  },
  input: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
  },
  radioList: {},
  radioRow: { flexDirection: 'row', alignItems: 'center', minHeight: 46, paddingVertical: 8, gap: 12 },
  radioOuter: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioInner: { width: 10, height: 10, borderRadius: 5 },
  radioLabel: { fontSize: 16 },
  create: {
    minHeight: 48,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
});
