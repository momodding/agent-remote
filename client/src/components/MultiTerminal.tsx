import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Terminal, type TerminalHandle } from './Terminal';
import { ShortcutKeyboard } from './ShortcutKeyboard';
import type { MultiSessionState } from '../lib/multi-session';

type Props = {
  sessions: Record<string, MultiSessionState>;
  onInput: (sessionId: string, data: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
  onMinimize: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  isBroadcasting: boolean;
  onBroadcastToggle: () => void;
  platformMax: number;
  bottomInset?: number;
};

export function MultiTerminal({
  sessions,
  onInput,
  onResize,
  onMinimize,
  onClose,
  isBroadcasting,
  onBroadcastToggle,
  bottomInset = 0,
}: Props) {
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const terminalRefs = useRef<Record<string, TerminalHandle>>({});
  const getFocused = () => {
    const id = focusedSessionId ?? visibleSessions[0]?.sessionId;
    return id ? terminalRefs.current[id] : undefined;
  };
  const sessionList = Object.values(sessions);
  const visibleSessions = sessionList.filter((s) => !s.minimized);
  const minimizedSessions = sessionList.filter((s) => s.minimized);

  const handleInput = (sessionId: string, data: string) => {
    if (isBroadcasting) {
      visibleSessions.forEach((s) => onInput(s.sessionId, data));
    } else {
      onInput(sessionId, data);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Pressable
          style={[styles.broadcastButton, isBroadcasting && styles.broadcastActive]}
          onPress={onBroadcastToggle}
          accessibilityLabel={isBroadcasting ? 'Disable broadcast' : 'Enable broadcast'}
        >
          <Text style={[styles.broadcastText, isBroadcasting && styles.broadcastTextActive]}>
            {isBroadcasting ? '⚡ Broadcasting' : 'Broadcast Input'}
          </Text>
        </Pressable>
      </View>

      <View style={styles.grid}>
        {visibleSessions.map((session) => (
          <View key={session.sessionId} style={styles.pane}>
            <View style={styles.paneHeader}>
              <Text style={styles.paneName} numberOfLines={1}>
                {session.name}
              </Text>
              {isBroadcasting && <Text style={styles.broadcastBadge}>⚡</Text>}
              <View style={styles.paneActions}>
                <Pressable
                  onPress={() => onMinimize(session.sessionId)}
                  accessibilityLabel={`Minimize ${session.name}`}
                >
                  <Text style={styles.paneAction}>−</Text>
                </Pressable>
                <Pressable
                  onPress={() => onClose(session.sessionId)}
                  accessibilityLabel={`Close ${session.name}`}
                >
                  <Text style={styles.paneClose}>✕</Text>
                </Pressable>
              </View>
            </View>
            <View
              style={styles.paneTerminal}
              onTouchStart={() => setFocusedSessionId(session.sessionId)}
            >
              <Terminal
                ref={(handle) => {
                  if (handle) terminalRefs.current[session.sessionId] = handle;
                  else delete terminalRefs.current[session.sessionId];
                }}
                output={session.output}
                onInput={(data) => handleInput(session.sessionId, data)}
                onResize={(cols, rows) => onResize(session.sessionId, cols, rows)}
              />
            </View>
          </View>
        ))}
      </View>

      {minimizedSessions.length > 0 && (
        <ScrollView horizontal style={styles.minimizedStrip} contentContainerStyle={styles.minimizedContent}>
          {minimizedSessions.map((session) => (
            <Pressable
              key={session.sessionId}
              style={styles.minimizedItem}
              onPress={() => onMinimize(session.sessionId)}
              accessibilityLabel={`Restore ${session.name}`}
            >
              <Text style={styles.minimizedName} numberOfLines={1}>
                {session.name}
              </Text>
              <Text style={styles.minimizedPreview} numberOfLines={1}>
                {session.output.slice(-50) || '(no output)'}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <ShortcutKeyboard
        onInput={(data) => {
          if (focusedSessionId) {
            handleInput(focusedSessionId, data);
          } else if (visibleSessions.length > 0) {
            handleInput(visibleSessions[0].sessionId, data);
          }
        }}
        bottomInset={bottomInset}
        onCopy={() => getFocused()?.copy()}
        onPaste={() => getFocused()?.paste()}
        onSelectAll={() => getFocused()?.selectAll()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  toolbar: {
    flexDirection: 'row',
    padding: 10,
    borderBottomWidth: 1,
    borderColor: '#262626',
    backgroundColor: '#181818',
  },
  broadcastButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#3A3A3A',
  },
  broadcastActive: {
    backgroundColor: '#264E54',
    borderColor: '#46B8C4',
  },
  broadcastText: {
    color: '#B8B8B8',
    fontWeight: '600',
  },
  broadcastTextActive: {
    color: '#46B8C4',
  },
  grid: {
    flex: 1,
    gap: 12,
    padding: 10,
  },
  pane: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#262626',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#0A0A0A',
  },
  paneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    backgroundColor: '#181818',
    borderBottomWidth: 1,
    borderColor: '#262626',
    gap: 8,
  },
  paneName: {
    flex: 1,
    color: '#F0F0F0',
    fontSize: 14,
    fontWeight: '700',
  },
  broadcastBadge: {
    color: '#46B8C4',
    fontSize: 12,
  },
  paneActions: {
    flexDirection: 'row',
    gap: 12,
  },
  paneAction: {
    color: '#B8B8B8',
    fontSize: 20,
    fontWeight: '700',
  },
  paneClose: {
    color: '#EF6666',
    fontSize: 16,
    fontWeight: '700',
  },
  paneTerminal: {
    flex: 1,
  },
  minimizedStrip: {
    maxHeight: 60,
    borderTopWidth: 1,
    borderColor: '#262626',
    backgroundColor: '#181818',
  },
  minimizedContent: {
    padding: 8,
    gap: 8,
  },
  minimizedItem: {
    minWidth: 120,
    maxWidth: 200,
    padding: 8,
    borderRadius: 6,
    backgroundColor: '#0A0A0A',
    borderWidth: 1,
    borderColor: '#3A3A3A',
  },
  minimizedName: {
    color: '#F0F0F0',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 2,
  },
  minimizedPreview: {
    color: '#666',
    fontSize: 10,
    fontFamily: 'monospace',
  },
});
