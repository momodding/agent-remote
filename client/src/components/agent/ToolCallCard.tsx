import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { ToolCallState } from '../../lib/agent/omp-adapter';
import Feather from '@expo/vector-icons/Feather';

export function ToolCallCard({ call }: { call: ToolCallState }) {
  // ponytail: render plain dense dark UI for tool execution. JSON.stringify covers complex generic args/results.
  const isDone = call.done;
  const isSuccess = isDone && !call.isError;
  const isError = isDone && call.isError;

  return (
    <View style={[styles.card, isError ? styles.errorBorder : null]}>
      <View style={styles.header}>
        <Feather name={isDone ? (isSuccess ? "check-circle" : "x-circle") : "loader"} size={14} color={isDone ? (isSuccess ? "#46B86B" : "#F19999") : "#D19A2C"} />
        <Text style={styles.name}>{call.intent || call.name}</Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.codeText} numberOfLines={isDone ? 2 : undefined}>
          {typeof call.args === 'string' ? call.args : JSON.stringify(call.args)}
        </Text>
        {isDone && call.result !== undefined && (
          <View style={styles.resultBox}>
            <Text style={[styles.codeText, isError && styles.errorText]} numberOfLines={3}>
              {typeof call.result === 'string' ? call.result : JSON.stringify(call.result)}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#181818', borderRadius: 8, padding: 10, marginVertical: 4, borderWidth: 1, borderColor: '#262626' },
  errorBorder: { borderColor: '#5c2222' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  name: { color: '#F0F0F0', fontSize: 13, fontWeight: '600', fontFamily: 'monospace' },
  body: { gap: 8 },
  codeText: { color: '#bbb', fontSize: 11, fontFamily: 'monospace' },
  errorText: { color: '#F19999' },
  resultBox: { backgroundColor: '#0A0A0A', padding: 8, borderRadius: 4, borderLeftWidth: 2, borderColor: '#262626' },
});
