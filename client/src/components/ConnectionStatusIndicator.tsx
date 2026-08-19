import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { AgenticRemoteAPI } from '../lib/api';

type Status = 'connecting' | 'ready' | 'error';

type Props = {
  api: AgenticRemoteAPI | null;
  showLatency?: boolean;
  label?: string;
};

const states = {
  connecting: { text: 'Connecting', color: '#D19A2C' },
  ready: { text: 'Ready', color: '#46B86B' },
  error: { text: 'Error', color: '#EF6666' },
} as const;

export function ConnectionStatusIndicator({ api, showLatency = false, label }: Props) {
  const [status, setStatus] = useState<Status>('connecting');
  const [latency, setLatency] = useState<number>();

  useEffect(() => {
    if (!api) {
      setStatus('error');
      setLatency(undefined);
      return;
    }

    const controller = new AbortController();
    let active = true;
    let probing = false;
    setStatus('connecting');
    setLatency(undefined);

    const probe = async (retry = false) => {
      if (probing) return;
      probing = true;
      if (retry) setStatus((current) => current === 'ready' ? current : 'connecting');
      const started = performance.now();
      try {
        await api.ping(controller.signal);
        if (active) {
          setLatency(Math.round(performance.now() - started));
          setStatus('ready');
        }
      } catch {
        if (active && !controller.signal.aborted) setStatus('error');
      } finally {
        probing = false;
      }
    };

    void probe();
    const timer = setInterval(() => void probe(true), 5000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [api]);

  const state = states[status];
  const text = `${label ? `${label} · ` : ''}${state.text}${showLatency && latency !== undefined ? ` · ${latency} ms` : ''}`;
  return <View style={styles.row} accessibilityLabel={text} testID="connection-status"><View style={[styles.dot, { backgroundColor: state.color }]} /><Text style={[styles.text, { color: state.color }]}>{text}</Text></View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  text: { fontSize: 12, fontWeight: '700' },
});
