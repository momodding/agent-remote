import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import Feather from '@expo/vector-icons/Feather';
import { Terminal, type TerminalHandle } from './Terminal';
import { ShortcutKeyboard } from './ShortcutKeyboard';
import { placeInSplit, reconcileSplit, type MultiSessionState, type SplitLayout, type SplitSide } from '../lib/multi-session';

type Props = {
  sessions: Record<string, MultiSessionState>;
  onInput: (sessionId: string, data: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
  onClose: (sessionId: string) => void;
  bottomInset?: number;
};

type DropRect = { x: number; y: number; width: number; height: number };

function Draggable({
  children,
  dropRect,
  isPortrait,
  onPlace,
  onDragState,
  style,
  testID,
}: {
  children: React.ReactNode;
  dropRect: DropRect | null;
  isPortrait: boolean;
  onPlace: (side: SplitSide) => void;
  onDragState: (dragging: boolean, side: SplitSide | null) => void;
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
  const currentSide = useSharedValue<SplitSide | null>(null);
  const isPortraitValue = useSharedValue(isPortrait);

  useEffect(() => {
    isPortraitValue.value = isPortrait;
  }, [isPortrait, isPortraitValue]);

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
    currentSide.value = null;
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
      // ponytail: no onDragState here — drop zones appear only when drag reaches terminal region
    })
    .onUpdate((event) => {
      translateX.value = event.translationX;
      translateY.value = event.translationY;
      const inside = hasDropRect.value && event.absoluteX >= rectX.value && event.absoluteX <= rectX.value + rectWidth.value && event.absoluteY >= rectY.value && event.absoluteY <= rectY.value + rectHeight.value;
      const side = inside
        ? (isPortraitValue.value
          ? (event.absoluteY < rectY.value + rectHeight.value / 2 ? 'left' : 'right')
          : (event.absoluteX < rectX.value + rectWidth.value / 2 ? 'left' : 'right'))
        : null;
      if (side !== currentSide.value) {
        currentSide.value = side;
        runOnJS(onDragState)(side !== null, side);
      }
    })
    .onEnd((event) => {
      const inside = hasDropRect.value && event.absoluteX >= rectX.value && event.absoluteX <= rectX.value + rectWidth.value && event.absoluteY >= rectY.value && event.absoluteY <= rectY.value + rectHeight.value;
      if (inside) {
        const side = isPortraitValue.value
          ? (event.absoluteY < rectY.value + rectHeight.value / 2 ? 'left' : 'right')
          : (event.absoluteX < rectX.value + rectWidth.value / 2 ? 'left' : 'right');
        runOnJS(onPlace)(side);
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
  onSelect,
  onPlace,
  onDragState,
  onClose,
}: {
  session: MultiSessionState;
  active: boolean;
  dropRect: DropRect | null;
  isPortrait: boolean;
  onSelect: () => void;
  onPlace: (side: SplitSide) => void;
  onDragState: (dragging: boolean, side: SplitSide | null) => void;
  onClose: () => void;
}) {
  return <Draggable dropRect={dropRect} isPortrait={isPortrait} onPlace={onPlace} onDragState={onDragState} style={[styles.tab, active && styles.tabActive]} testID={`tab-${session.sessionId}`}>
    <Pressable onPress={onSelect} accessibilityLabel={`Show ${session.name}`} style={styles.tabSelect}>
      <Text style={[styles.tabName, active && styles.tabNameActive]} numberOfLines={1}>{session.name}</Text>
    </Pressable>
    <Pressable onPress={onClose} accessibilityLabel={`Close ${session.name}`} hitSlop={8} style={styles.tabClose}>
      <Feather name="x" size={14} color="#B8B8B8" />
    </Pressable>
  </Draggable>;
}

export function MultiTerminal({ sessions, onInput, onResize, onClose, bottomInset = 0 }: Props) {
  const { width, height } = useWindowDimensions();
  const isPortrait = height > width;
  const sessionList = Object.values(sessions);
  const sessionIds = sessionList.map(({ sessionId }) => sessionId);
  const [layout, setLayout] = useState<SplitLayout>(() => ({ left: sessionIds[0] ?? null, right: null }));
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(sessionIds[0] ?? null);
  const [dragging, setDragging] = useState(false);
  const [dropSide, setDropSide] = useState<SplitSide | null>(null);
  const terminalRefs = useRef<Record<string, TerminalHandle>>({});
  const terminalRegionRef = useRef<View>(null);
  const [dropRect, setDropRect] = useState<DropRect | null>(null);

  useEffect(() => {
    setLayout((current) => reconcileSplit(current, sessionIds));
    setFocusedSessionId((current) => (current && sessionIds.includes(current) ? current : sessionIds[0] ?? null));
  }, [sessions]);

  const measureTerminalRegion = () => {
    terminalRegionRef.current?.measureInWindow((x, y, width, height) => setDropRect({ x, y, width, height }));
  };
  const selectTab = (sessionId: string) => {
    setLayout({ left: sessionId, right: null });
    setFocusedSessionId(sessionId);
  };
  const placeTab = (sessionId: string, side: SplitSide) => {
    setLayout((current) => placeInSplit(current, sessionId, side));
    setFocusedSessionId(sessionId);
  };
  const visibleSessions = [layout.left, layout.right]
    .filter((id): id is string => id !== null)
    .map((id) => sessions[id])
    .filter((session): session is MultiSessionState => Boolean(session));
  const getFocused = () => {
    const id = focusedSessionId ?? visibleSessions[0]?.sessionId;
    return id ? terminalRefs.current[id] : undefined;
  };

  return <View style={styles.container}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs} contentContainerStyle={styles.tabsContent}>
      {sessionList.map((session) => <DraggableTab
        key={session.sessionId}
        session={session}
        active={layout.left === session.sessionId || layout.right === session.sessionId}
        dropRect={dropRect}
        isPortrait={isPortrait}
        onSelect={() => selectTab(session.sessionId)}
        onPlace={(side) => placeTab(session.sessionId, side)}
        onDragState={(isDragging, side) => { setDragging(isDragging); setDropSide(side); }}
        onClose={() => onClose(session.sessionId)}
      />)}
    </ScrollView>
    <View ref={terminalRegionRef} onLayout={measureTerminalRegion} testID="terminal-region" style={[styles.terminalRegion, { flexDirection: isPortrait ? 'column' : 'row' }]}>
      {visibleSessions.map((session) => <Draggable key={session.sessionId} dropRect={dropRect} isPortrait={isPortrait} onPlace={(side) => placeTab(session.sessionId, side)} onDragState={(isDragging, side) => { setDragging(isDragging); setDropSide(side); }} style={styles.pane} testID={`terminal-pane-${session.sessionId}`}>
        <View style={styles.pane} onTouchStart={() => setFocusedSessionId(session.sessionId)}>
          <Terminal
            ref={(handle) => { if (handle) terminalRefs.current[session.sessionId] = handle; else delete terminalRefs.current[session.sessionId]; }}
            output={session.output}
            onInput={(data) => onInput(session.sessionId, data)}
            onResize={(cols, rows) => onResize(session.sessionId, cols, rows)}
          />
        </View>
      </Draggable>)}
      {dragging && <View pointerEvents="none" style={[styles.dropZones, { flexDirection: isPortrait ? 'column' : 'row' }]}>
        <View testID="drop-zone-left" style={[styles.dropZone, dropSide === 'left' && styles.dropZoneActive]}><Text style={styles.dropZoneText}>{isPortrait ? 'Top' : 'Left'}</Text></View>
        <View testID="drop-zone-right" style={[styles.dropZone, dropSide === 'right' && styles.dropZoneActive]}><Text style={styles.dropZoneText}>{isPortrait ? 'Bottom' : 'Right'}</Text></View>
      </View>}
    </View>
    <ShortcutKeyboard
      onInput={(data) => { const id = focusedSessionId ?? visibleSessions[0]?.sessionId; if (id) onInput(id, data); }}
      bottomInset={bottomInset}
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
  pane: { flex: 1, backgroundColor: '#0A0A0A' },
  dropZones: { ...StyleSheet.absoluteFill, padding: 12, gap: 12, backgroundColor: 'rgba(10,10,10,0.62)' },
  dropZone: { flex: 1, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#666', borderRadius: 8, backgroundColor: 'rgba(24,24,24,0.9)' },
  dropZoneActive: { borderColor: '#46B8C4', backgroundColor: 'rgba(38,78,84,0.95)' },
  dropZoneText: { color: '#F0F0F0', fontSize: 16, fontWeight: '700' },
});
