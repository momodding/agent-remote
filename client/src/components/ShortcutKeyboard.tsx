import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

type Modifier = 'ctrl' | 'alt';
type Key = { label: string; data: string };

const rows: Key[][] = [
  [
    { label: 'Esc', data: '\x1b' }, { label: 'Tab', data: '\t' }, { label: '⇧Tab', data: '\x1b[Z' }, { label: '^C', data: '\x03' },
  ],
  [
    { label: '/', data: '/' }, { label: '-', data: '-' }, { label: '_', data: '_' }, { label: '|', data: '|' }, { label: '~', data: '~' }, { label: '`', data: '`' },
  ],
  [
    { label: '↑', data: '\x1b[A' }, { label: '↓', data: '\x1b[B' }, { label: '←', data: '\x1b[D' }, { label: '→', data: '\x1b[C' }, { label: 'Home', data: '\x1b[H' }, { label: 'End', data: '\x1b[F' }, { label: 'PgUp', data: '\x1b[5~' }, { label: 'PgDn', data: '\x1b[6~' }, { label: 'Ins', data: '\x1b[2~' }, { label: 'Del', data: '\x1b[3~' },
  ],
  Array.from({ length: 12 }, (_, index) => ({ label: `F${index + 1}`, data: index < 4 ? `\x1bO${String.fromCharCode(80 + index)}` : `\x1b[${15 + index * 2}~` })),
];

export function ShortcutKeyboard({ onInput }: { onInput: (data: string) => void }) {
  const [collapsed, setCollapsed] = useState(false);
  const [modifier, setModifier] = useState<Modifier | null>(null);
  if (collapsed) return <Pressable style={styles.show} onPress={() => setCollapsed(false)}><Text style={styles.label}>⌨ Shortcuts</Text></Pressable>;
  const emit = (key: Key) => {
    let data = key.data;
    if (modifier === 'ctrl' && data.length === 1) data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 0x1f);
    if (modifier === 'alt' && data.length === 1) data = `\x1b${data}`;
    onInput(data);
    setModifier(null);
  };
  return (
    <View style={styles.keyboard}>
      <View style={styles.toolbar}>
        <Pressable style={[styles.modifier, modifier === 'ctrl' && styles.active]} onPress={() => setModifier(modifier === 'ctrl' ? null : 'ctrl')}><Text style={styles.label}>Ctrl</Text></Pressable>
        <Pressable style={[styles.modifier, modifier === 'alt' && styles.active]} onPress={() => setModifier(modifier === 'alt' ? null : 'alt')}><Text style={styles.label}>Alt</Text></Pressable>
        <Pressable style={styles.hide} onPress={() => setCollapsed(true)}><Text style={styles.label}>⌄</Text></Pressable>
      </View>
      {rows.map((row, index) => (
        <ScrollView key={index} horizontal contentContainerStyle={styles.row} showsHorizontalScrollIndicator={false}>
          {row.map((key) => <Pressable key={key.label} style={styles.key} onPress={() => emit(key)}><Text style={styles.label}>{key.label}</Text></Pressable>)}
        </ScrollView>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  keyboard: { borderTopWidth: 1, borderColor: '#262626', backgroundColor: '#181818', paddingVertical: 5 },
  toolbar: { flexDirection: 'row', paddingHorizontal: 6, gap: 6 },
  row: { gap: 6, paddingHorizontal: 6, paddingTop: 6 },
  key: { minWidth: 48, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: '#262626', paddingHorizontal: 9 },
  modifier: { minWidth: 58, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: '#262626' },
  active: { backgroundColor: '#8B651E' },
  hide: { marginLeft: 'auto', minWidth: 48, alignItems: 'center', justifyContent: 'center' },
  show: { borderTopWidth: 1, borderColor: '#262626', padding: 9, backgroundColor: '#181818' },
  label: { color: '#F0F0F0', fontSize: 13, fontWeight: '600' },
});
