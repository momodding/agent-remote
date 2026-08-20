import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import Feather from '@expo/vector-icons/Feather';
import { Terminal, type TerminalHandle } from './Terminal';
import { ShortcutKeyboard, type ShortcutKeyboardHandle } from './ShortcutKeyboard';
import { auxSlotCount, placeInSplit, reconcileSplit, type MultiSessionState, type SplitLayout } from '../lib/multi-session';

type Props = {
  sessions: Record<string, MultiSessionState>;
  onInput: (sessionId: string, data: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
  onClose: (sessionId: string) => void;
  bottomInset?: number;
  keyboardInset?: number;
};

type DropRect = { x: number; y: number; width: number; height: number };

function dropSlot(rect: DropRect, x: number, y: number, isWeb: boolean, isPortrait: boolean): number {
  'worklet';
  if (isWeb) {
    const column = x < rect.x + rect.width / 2 ? 0 : 1;
    const row = y < rect.y + rect.height / 2 ? 0 : 1;
    return row * 2 + column + 1;
  }
  if (isPortrait) return y < rect.y + rect.height / 2 ? 1 : 2;
  return x < rect.x + rect.width / 2 ? 1 : 2;
}

function Draggable({
  children,
  dropRect,
  isPortrait,
  isWeb,
  onPlace,
  onDragState,
  style,
  testID,
}: {
  children: React.ReactNode;
  dropRect: DropRect | null;
  isPortrait: boolean;
  isWeb: boolean;
  onPlace: (index: number) => void;
  onDragState: (dragging: boolean, index: number | null) => void;
  style: object;
  testID: string;
}) {
  const reducedMotion = useReducedMotion();
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);
  const rectX = useSharedValue(0);
  const rectY = useSharedValue(0);
  const rectWidth = useSharedValue(0);
  const rectHeight = useSharedValue(0);
  const hasDropRect = useSharedValue(false);
  const currentSlot = useSharedValue<number | null>(null);
  const isPortraitValue = useSharedValue(isPortrait);
  const isWebValue = useSharedValue(isWeb);

  useEffect(() => {
    isPortraitValue.value = isPortrait;
    isWebValue.value = isWeb;
  }, [isPortrait, isPortraitValue, isWeb, isWebValue]);

  useEffect(() => {
    if (!dropRect) {
      hasDropRect.value = false;
      return;
    }
    rectX.value = dropRect.x;
    rectY.value = dropRect.y;
    rectWidth.value = dropRect.width;
    rectHeight.value = dropRect.height;
    hasDropRect.value = true;
  }, [dropRect, hasDropRect, rectHeight, rectWidth, rectX, rectY]);

  const reset = () => {
    'worklet';
    currentSlot.value = null;
    translateX.value = reducedMotion ? 0 : withTiming(0, { duration: 180 });
    translateY.value = reducedMotion ? 0 : withTiming(0, { duration: 180 });
    scale.value = reducedMotion ? 1 : withTiming(1, { duration: 180 });
    opacity.value = reducedMotion ? 1 : withTiming(1, { duration: 180 });
  };
  const pan = Gesture.Pan()
    .activateAfterLongPress(250)
    .onBegin(() => {
      scale.value = reducedMotion ? 1.04 : withTiming(1.04, { duration: 180 });
      opacity.value = reducedMotion ? 1 : withTiming(0.9, { duration: 180 });
    })
    .onUpdate((event) => {
      translateX.value = event.translationX;
      translateY.value = event.translationY;
      const inside = hasDropRect.value && event.absoluteX >= rectX.value && event.absoluteX <= rectX.value + rectWidth.value && event.absoluteY >= rectY.value && event.absoluteY <= rectY.value + rectHeight.value;
      const slot = inside
        ? dropSlot({ x: rectX.value, y: rectY.value, width: rectWidth.value, height: rectHeight.value }, event.absoluteX, event.absoluteY, isWebValue.value, isPortraitValue.value)
        : null;
      if (slot !== currentSlot.value) {
        currentSlot.value = slot;
        runOnJS(onDragState)(slot !== null, slot);
      }
    })
    .onEnd((event) => {
      const inside = hasDropRect.value && event.absoluteX >= rectX.value && event.absoluteX <= rectX.value + rectWidth.value && event.absoluteY >= rectY.value && event.absoluteY <= rectY.value + rectHeight.value;
      if (inside) {
        runOnJS(onPlace)(dropSlot({ x: rectX.value, y: rectY.value, width: rectWidth.value, height: rectHeight.value }, event.absoluteX, event.absoluteY, isWebValue.value, isPortraitValue.value));
      }
      reset();
    })
    .onFinalize(() => {
      reset();
      runOnJS(onDragState)(false, null);
    });
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }],
  }));

  return <GestureDetector gesture={pan}>
    <Animated.View testID={testID} style={[style, animatedStyle]}>{children}</Animated.View>
  </GestureDetector>;
}

function DraggableTab({
  session,
  active,
  dropRect,
  isPortrait,
  isWeb,
  onSelect,
  onPlace,
  onDragState,
  onMinimize,
  onClose,
}: {
  session: MultiSessionState;
  active: boolean;
  dropRect: DropRect | null;
  isPortrait: boolean;
  isWeb: boolean;
  onSelect: () => void;
  onPlace: (index: number) => void;
  onDragState: (dragging: boolean, index: number | null) => void;
  onMinimize: () => void;
  onClose: () => void;
}) {
  return <Draggable dropRect={dropRect} isPortrait={isPortrait} isWeb={isWeb} onPlace={onPlace} onDragState={onDragState} style={[styles.tab, active && styles.tabActive]} testID={`tab-${session.sessionId}`}>
    <Pressable onPress={onSelect} accessibilityLabel={active ? `Show ${session.name}` : `Restore ${session.name}`} style={styles.tabSelect}>
      <Text style={[styles.tabName, active && styles.tabNameActive]} numberOfLines={1}>{session.name}</Text>
    </Pressable>
    {active && <Pressable onPress={onMinimize} accessibilityLabel={`Minimize ${session.name}`} hitSlop={8} style={styles.tabClose}>
      <Feather name="minus" size={14} color="#B8B8B8" />
    </Pressable>}
    <Pressable onPress={onClose} accessibilityLabel={`Close ${session.name}`} hitSlop={8} style={styles.tabClose}>
      <Feather name="x" size={14} color="#B8B8B8" />
    </Pressable>
  </Draggable>;
}

export function MultiTerminal({ sessions, onInput, onResize, onClose, bottomInset = 0, keyboardInset = 0 }: Props) {
  const shortcutKeyboardRef = useRef<ShortcutKeyboardHandle>(null);
  const { width, height } = useWindowDimensions();
  const isPortrait = height > width;
  const isWeb = Platform.OS === 'web';
  const slotCount = auxSlotCount(isWeb) + 1;
  const sessionList = Object.values(sessions);
  const sessionIds = sessionList.map(({ sessionId }) => sessionId);
  const [layout, setLayout] = useState<SplitLayout>(() => reconcileSplit([], sessionIds, slotCount));
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(sessionIds[0] ?? null);
  const [dragging, setDragging] = useState(false);
  const [dropSlotIndex, setDropSlotIndex] = useState<number | null>(null);
  const terminalRefs = useRef<Record<string, TerminalHandle>>({});
  const terminalRegionRef = useRef<View>(null);
  const [dropRect, setDropRect] = useState<DropRect | null>(null);

  useEffect(() => {
    setLayout((current) => reconcileSplit(current, sessionIds, slotCount));
    setFocusedSessionId((current) => (current && sessionIds.includes(current) ? current : sessionIds[0] ?? null));
  }, [sessions, slotCount]);

  const measureTerminalRegion = () => {
    terminalRegionRef.current?.measureInWindow((x, y, measuredWidth, measuredHeight) => setDropRect({ x, y, width: measuredWidth, height: measuredHeight }));
  };
  const restoreTab = (sessionId: string) => {
    setLayout((current) => {
      const empty = current.indexOf(null);
      const focused = current.indexOf(focusedSessionId ?? '');
      return placeInSplit(current, sessionId, empty >= 0 ? empty : focused >= 0 ? focused : 0);
    });
    setFocusedSessionId(sessionId);
  };
  const selectTab = (sessionId: string) => {
    if (layout.includes(sessionId)) setFocusedSessionId(sessionId);
    else restoreTab(sessionId);
  };
  const minimizeTab = (sessionId: string) => {
    setLayout((current) => {
      const index = current.indexOf(sessionId);
      if (index < 0) return current;
      const next = [...current];
      next[index] = null;
      return next;
    });
    if (focusedSessionId === sessionId) setFocusedSessionId(layout.find((id) => id && id !== sessionId) ?? null);
  };
  const placeTab = (sessionId: string, index: number) => {
    setLayout((current) => placeInSplit(current, sessionId, index));
    setFocusedSessionId(sessionId);
  };
  const getFocused = () => {
    const id = focusedSessionId ?? layout.find((id): id is string => id !== null);
    return id ? terminalRefs.current[id] : undefined;
  };
  const dropLabels = isWeb ? ['Top left', 'Top right', 'Bottom left', 'Bottom right'] : isPortrait ? ['Top', 'Bottom'] : ['Left', 'Right'];

  return <View style={styles.container}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs} contentContainerStyle={styles.tabsContent}>
      {sessionList.map((session) => <DraggableTab
        key={session.sessionId}
        session={session}
        active={layout.includes(session.sessionId)}
        dropRect={dropRect}
        isPortrait={isPortrait}
        isWeb={isWeb}
        onSelect={() => selectTab(session.sessionId)}
        onPlace={(index) => placeTab(session.sessionId, index)}
        onDragState={(isDragging, index) => { setDragging(isDragging); setDropSlotIndex(index); }}
        onMinimize={() => minimizeTab(session.sessionId)}
        onClose={() => onClose(session.sessionId)}
      />)}
    </ScrollView>
    <View ref={terminalRegionRef} onLayout={measureTerminalRegion} testID="terminal-region" style={[styles.terminalRegion, isWeb ? styles.webGrid : { flexDirection: isPortrait ? 'column' : 'row' }]}>
      {layout.map((sessionId, index) => <View key={`slot-${index}`} testID={`terminal-slot-${index}`} style={styles.slot}>
        {sessionId && sessions[sessionId] && <Draggable key={sessionId} dropRect={dropRect} isPortrait={isPortrait} isWeb={isWeb} onPlace={(target) => placeTab(sessionId, target)} onDragState={(isDragging, target) => { setDragging(isDragging); setDropSlotIndex(target); }} style={styles.pane} testID={`terminal-pane-${sessionId}`}>
          <View style={styles.pane} onTouchStart={() => setFocusedSessionId(sessionId)}>
            <Terminal
              ref={(handle) => { if (handle) terminalRefs.current[sessionId] = handle; else delete terminalRefs.current[sessionId]; }}
              output={sessions[sessionId].output}
              onInput={(data) => shortcutKeyboardRef.current?.input(data)}
              onResize={(cols, rows) => onResize(sessionId, cols, rows)}
            />
          </View>
        </Draggable>}
      </View>)}
      {dragging && <View pointerEvents="none" style={[styles.dropZones, isWeb ? styles.webDropZones : { flexDirection: isPortrait ? 'column' : 'row' }]}>
        {dropLabels.map((label, index) => <View key={label} testID={`drop-zone-${index}`} style={[styles.dropZone, isWeb && styles.webDropZone, dropSlotIndex === index + 1 && styles.dropZoneActive]}><Text style={styles.dropZoneText}>{label}</Text></View>)}
      </View>}
    </View>
    <ShortcutKeyboard
      ref={shortcutKeyboardRef}
      onInput={(data) => { if (focusedSessionId) onInput(focusedSessionId, data); }}
      bottomInset={bottomInset}
      keyboardInset={keyboardInset}
      onCopy={() => getFocused()?.copy()}
      onPaste={() => getFocused()?.paste()}
      onSelectAll={() => getFocused()?.selectAll()}
      onExpand={() => getFocused()?.blur()}
      onCollapse={() => getFocused()?.focus()}
    />
  </View>;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  tabs: { maxHeight: 56, borderBottomWidth: 1, borderColor: '#262626', backgroundColor: '#181818' },
  tabsContent: { paddingHorizontal: 8, alignItems: 'center', gap: 8 },
  tab: { height: 40, maxWidth: 180, flexDirection: 'row', alignItems: 'center', borderRadius: 6, borderWidth: 1, borderColor: '#3A3A3A', backgroundColor: '#0A0A0A', overflow: 'hidden' },
  tabActive: { borderColor: '#46B8C4', backgroundColor: '#264E54' },
  tabSelect: { minWidth: 88, minHeight: 40, flex: 1, justifyContent: 'center', paddingLeft: 12, overflow: 'hidden' },
  tabName: { color: '#B8B8B8', fontSize: 13, fontWeight: '700' },
  tabNameActive: { color: '#F0F0F0' },
  tabClose: { width: 40, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  terminalRegion: { flex: 1, gap: 1, backgroundColor: '#262626' },
  webGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  slot: { flex: 1, flexBasis: '50%', minWidth: 0, minHeight: 0, backgroundColor: '#0A0A0A' },
  pane: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: '#0A0A0A' },
  dropZones: { ...StyleSheet.absoluteFill, padding: 12, gap: 12, backgroundColor: 'rgba(10,10,10,0.62)' },
  webDropZones: { flexDirection: 'row', flexWrap: 'wrap' },
  dropZone: { flex: 1, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#666', borderRadius: 8, backgroundColor: 'rgba(24,24,24,0.9)' },
  webDropZone: { flexBasis: '45%' },
  dropZoneActive: { borderColor: '#46B8C4', backgroundColor: 'rgba(38,78,84,0.95)' },
  dropZoneText: { color: '#F0F0F0', fontSize: 16, fontWeight: '700' },
});
