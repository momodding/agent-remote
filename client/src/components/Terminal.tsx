import { NativeTerminal, type NativeTerminalHandle } from '@next_term/native';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, View } from 'react-native';

export type TerminalHandle = {
  copy: () => void;
  paste: () => void;
  selectAll: () => void;
  blur: () => void;
  focus: () => void;
};

type Props = {
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  output: string;
};

const decoder = new TextDecoder();

export const Terminal = forwardRef<TerminalHandle, Props>(function Terminal({ onInput, onResize, output }, ref) {
  const terminal = useRef<NativeTerminalHandle>(null);
  const lastOutput = useRef('');
  const [size, setSize] = useState({ cols: 80, rows: 24 });

  useEffect(() => {
    const previous = lastOutput.current;
    const data = output.startsWith(previous) ? output.slice(previous.length) : output;
    lastOutput.current = output;
    if (data) terminal.current?.write(data);
  }, [output]);

  useImperativeHandle(ref, () => ({
    copy: () => {},
    paste: () => {},
    selectAll: () => {},
    blur: () => terminal.current?.blur(),
    focus: () => terminal.current?.focus(),
  }));

  const resize = ({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    const cols = Math.max(2, Math.floor(layout.width / 9));
    const rows = Math.max(1, Math.floor(layout.height / 17));
    if (cols === size.cols && rows === size.rows) return;
    terminal.current?.resize(cols, rows);
    setSize({ cols, rows });
    onResize(cols, rows);
  };

  return (
    <View onLayout={resize} style={styles.container}>
      <NativeTerminal
        ref={terminal}
        cols={size.cols}
        rows={size.rows}
        fontSize={14}
        onData={(data) => onInput(decoder.decode(data))}
        theme={{ background: '#0A0A0A', foreground: '#F5F5F5' }}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0A0A0A', overflow: 'hidden' },
});
