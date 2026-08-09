import { useEffect, useState } from 'react';
import { Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

type Modifier = 'ctrl' | 'alt';
type Key = { label: string; data: string };

export const terminalRows: Key[][] = [
  [
    { label: 'Esc', data: '\x1b' }, { label: 'Tab', data: '\t' }, { label: '⇧Tab', data: '\x1b[Z' }, { label: '^C', data: '\x03' },
  ],
  [
    { label: '/', data: '/' }, { label: '-', data: '-' }, { label: '_', data: '_' }, { label: '|', data: '|' }, { label: '~', data: '~' }, { label: '`', data: '`' },
  ],
  [
    { label: '↑', data: '\x1b[A' }, { label: '↓', data: '\x1b[B' }, { label: '←', data: '\x1b[D' }, { label: '→', data: '\x1b[C' }, { label: 'Home', data: '\x1b[H' }, { label: 'End', data: '\x1b[F' }, { label: 'PgUp', data: '\x1b[5~' }, { label: 'PgDn', data: '\x1b[6~' }, { label: 'Ins', data: '\x1b[2~' }, { label: 'Del', data: '\x1b[3~' },
  ],
  [
    { label: 'F1', data: '\x1bOP' }, { label: 'F2', data: '\x1bOQ' }, { label: 'F3', data: '\x1bOR' }, { label: 'F4', data: '\x1bOS' },
    { label: 'F5', data: '\x1b[15~' }, { label: 'F6', data: '\x1b[17~' }, { label: 'F7', data: '\x1b[18~' }, { label: 'F8', data: '\x1b[19~' },
    { label: 'F9', data: '\x1b[20~' }, { label: 'F10', data: '\x1b[21~' }, { label: 'F11', data: '\x1b[23~' }, { label: 'F12', data: '\x1b[24~' },
  ],
];

export function modifiedTerminalInput(data: string, modifier: Modifier | null): string {
  if (modifier === 'ctrl' && data.length === 1) return String.fromCharCode(data.toUpperCase().charCodeAt(0) & 0x1f);
  return modifier === 'alt' && data.length === 1 ? `\x1b${data}` : data;
}

export function ShortcutKeyboard({ onInput, bottomInset = 0, onCopy, onPaste, onSelectAll, onExpand, onCollapse }: { onInput: (data: string) => void; bottomInset?: number; onCopy?: () => void; onPaste?: () => void; onSelectAll?: () => void; onExpand?: () => void; onCollapse?: () => void }) {
  const [collapsed, setCollapsed] = useState(false);
  const [modifier, setModifier] = useState<{ kind: Modifier; locked: boolean } | null>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, (e) => {
      setKeyboardVisible(true);
      setKeyboardHeight(e.endCoordinates?.height ?? 0);
    });
    const hide = Keyboard.addListener(hideEvent, () => setKeyboardVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  if (collapsed) return <View style={[styles.dock, { bottom: keyboardVisible ? keyboardHeight : 0 }]}><Pressable style={[styles.show, { paddingBottom: bottomInset }]} onPress={() => { onExpand?.(); setCollapsed(false); }}><Text style={styles.label}>⌨ Shortcuts</Text></Pressable></View>;
  const emit = (key: Key) => {
    onInput(modifiedTerminalInput(key.data, modifier?.kind ?? null));
    if (!modifier?.locked) setModifier(null);
  };
  const toggle = (kind: Modifier, locked = false) => setModifier((current) => current?.kind === kind && current.locked === locked ? null : { kind, locked });
  return (
    <View style={[styles.dock, { bottom: keyboardVisible ? keyboardHeight : 0 }]}>
      <View style={[styles.keyboard, { paddingBottom: bottomInset }]}>
      <View style={styles.toolbar}>
        <Pressable style={[styles.modifier, modifier?.kind === 'ctrl' && styles.active]} onPress={() => toggle('ctrl')} onLongPress={() => toggle('ctrl', true)}><Text style={styles.label}>Ctrl{modifier?.kind === 'ctrl' && modifier.locked ? ' 🔒' : ''}</Text></Pressable>
        <Pressable style={[styles.modifier, modifier?.kind === 'alt' && styles.active]} onPress={() => toggle('alt')} onLongPress={() => toggle('alt', true)}><Text style={styles.label}>Alt{modifier?.kind === 'alt' && modifier.locked ? ' 🔒' : ''}</Text></Pressable>
        {onCopy && <Pressable accessibilityLabel="Copy" android_ripple={{ color: 'rgba(255,255,255,0.15)' }} style={({ pressed }) => [styles.modifier, pressed && styles.pressed]} onPress={onCopy}><Feather name="copy" size={16} color="#F0F0F0" /></Pressable>}
        {onPaste && <Pressable accessibilityLabel="Paste" android_ripple={{ color: 'rgba(255,255,255,0.15)' }} style={({ pressed }) => [styles.modifier, pressed && styles.pressed]} onPress={onPaste}><Feather name="clipboard" size={16} color="#F0F0F0" /></Pressable>}
        {onSelectAll && <Pressable accessibilityLabel="SelAll" android_ripple={{ color: 'rgba(255,255,255,0.15)' }} style={({ pressed }) => [styles.modifier, pressed && styles.pressed]} onPress={onSelectAll}><Feather name="check-square" size={16} color="#F0F0F0" /></Pressable>}
        <Pressable accessibilityLabel="⌄" android_ripple={{ color: 'rgba(255,255,255,0.15)' }} style={({ pressed }) => [styles.hide, pressed && styles.pressed]} onPress={() => { onCollapse?.(); setCollapsed(true); }}><Feather name="chevron-down" size={20} color="#F0F0F0" /></Pressable>
      </View>
      {terminalRows.map((row, index) => (
        <ScrollView key={index} horizontal contentContainerStyle={styles.row} showsHorizontalScrollIndicator={false}>
          {row.map((key) => <Pressable key={key.label} style={styles.key} onPress={() => emit(key)}><Text style={styles.label}>{key.label}</Text></Pressable>)}
        </ScrollView>
      ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { position: 'absolute', left: 0, right: 0 },
  keyboard: { borderTopWidth: 1, borderColor: '#262626', backgroundColor: '#181818', paddingVertical: 5 },
  toolbar: { flexDirection: 'row', paddingHorizontal: 6, gap: 6 },
  row: { gap: 6, paddingHorizontal: 6, paddingTop: 6 },
  key: { minWidth: 48, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: '#262626', paddingHorizontal: 9 },
  modifier: { minWidth: 58, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: '#262626' },
  active: { backgroundColor: '#8B651E' },
  hide: { marginLeft: 'auto', minWidth: 48, alignItems: 'center', justifyContent: 'center' },
  show: { borderTopWidth: 1, borderColor: '#262626', padding: 9, backgroundColor: '#181818' },
  label: { color: '#F0F0F0', fontSize: 13, fontWeight: '600' },
  pressed: { opacity: 0.6 },
});
