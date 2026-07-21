import { useCallback, useEffect, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

const terminalHTML = require('../../assets/terminal.html');

type TerminalMessage = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number };

type Props = {
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  output: string;
};

export function Terminal({ onInput, onResize, output }: Props) {
  const web = useRef<WebView>(null);
  const lastOutput = useRef('');

  useEffect(() => {
    if (!output || output === lastOutput.current) return;
    const data = output.slice(lastOutput.current.length);
    lastOutput.current = output;
    web.current?.injectJavaScript(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify({ type: 'output', data }))}}));true;`);
  }, [output]);

  const onMessage = useCallback(
    ({ nativeEvent }: WebViewMessageEvent) => {
      const message = JSON.parse(nativeEvent.data) as TerminalMessage;
      if (message.type === 'input') onInput(message.data);
      if (message.type === 'resize') onResize(message.cols, message.rows);
    },
    [onInput, onResize],
  );

  if (Platform.OS === 'web') return <View style={styles.unavailable} />;
  return <WebView ref={web} source={terminalHTML} onMessage={onMessage} originWhitelist={['*']} allowFileAccess style={styles.webview} />;
}

const styles = StyleSheet.create({
  webview: { flex: 1, backgroundColor: '#0A0A0A' },
  unavailable: { flex: 1, backgroundColor: '#0A0A0A' },
});
