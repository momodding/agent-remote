import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { TurnState } from '../../lib/agent/omp-adapter';
import { ToolCallCard } from './ToolCallCard';

export function AgentMessageList({ turns }: { turns: TurnState[] }) {
  // ponytail: flat list mapping, no AI avatars, just dense cards
  return (
    <View style={styles.list}>
      {turns.map(turn => (
        <View key={turn.id} style={styles.turn}>
          <Text style={styles.role}>{turn.role === 'user' ? 'User' : 'Agent'}</Text>
          {!!turn.content && <Text style={styles.content}>{turn.content}</Text>}
          {turn.toolCalls.map(call => <ToolCallCard key={call.id} call={call} />)}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { padding: 14, gap: 16 },
  turn: { gap: 6 },
  role: { color: '#888', fontSize: 11, textTransform: 'uppercase', fontWeight: 'bold' },
  content: { color: '#F0F0F0', fontSize: 14, lineHeight: 20 },
});
