import { forwardRef, useImperativeHandle, useRef } from 'react';
import Feather from '@expo/vector-icons/Feather';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import type { TmuxPane } from '../protocol';
import { GlassBottomSheet, type GlassBottomSheetHandle } from './GlassBottomSheet';

export type TmuxPaneSheetHandle = { present: () => void; dismiss: () => void };

type Props = {
  panes: TmuxPane[];
  currentPaneId?: string;
  onSelect: (pane: TmuxPane) => void;
};

export const TmuxPaneSheet = forwardRef<TmuxPaneSheetHandle, Props>(function TmuxPaneSheet({ panes, currentPaneId, onSelect }, ref) {
  const sheet = useRef<GlassBottomSheetHandle>(null);
  const colorScheme = useColorScheme();
  const palette = colorScheme === 'dark'
    ? { text: '#F0F0F0', muted: '#A3A3A3', accent: '#D19A2C', selected: 'rgba(209, 154, 44, 0.14)' }
    : { text: '#1A1A1A', muted: '#5A5A5A', accent: '#946200', selected: 'rgba(148, 98, 0, 0.12)' };

  useImperativeHandle(ref, () => ({ present: () => sheet.current?.present(), dismiss: () => sheet.current?.dismiss() }), []);

  return <GlassBottomSheet ref={sheet} title="Panes">
    <BottomSheetScrollView contentContainerStyle={styles.list}>
      {panes.length === 0 ? <Text style={[styles.empty, { color: palette.muted }]}>No persistent panes in this daemon.</Text> : panes.map((pane) => {
        const selected = pane.paneId === currentPaneId;
        return <Pressable
          key={`${pane.serverId}:${pane.paneId}`}
          accessibilityLabel={`Open ${pane.sessionName} ${pane.windowName} pane ${pane.paneIndex + 1}`}
          accessibilityState={{ selected }}
          onPress={() => { onSelect(pane); sheet.current?.dismiss(); }}
          style={({ pressed }) => [styles.row, selected && { backgroundColor: palette.selected }, pressed && styles.pressed]}
        >
          <Feather name="terminal" size={17} color={selected ? palette.accent : palette.muted} />
          <View style={styles.copy}>
            <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>{pane.sessionName} · {pane.windowName}</Text>
            <Text style={[styles.detail, { color: palette.muted }]} numberOfLines={1}>Pane {pane.paneIndex + 1} · {pane.cwd || 'workspace'}</Text>
          </View>
          {selected && <Feather name="check" size={18} color={palette.accent} />}
        </Pressable>;
      })}
    </BottomSheetScrollView>
  </GlassBottomSheet>;
});

const styles = StyleSheet.create({
  list: { paddingHorizontal: 12, paddingBottom: 28 },
  row: { minHeight: 58, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 10 },
  pressed: { opacity: 0.68 },
  copy: { flex: 1, gap: 2 },
  title: { fontSize: 14, fontWeight: '600' },
  detail: { fontSize: 12 },
  empty: { padding: 16, textAlign: 'center' },
});
