import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import * as Clipboard from 'expo-clipboard';

import { terminalHTML } from './terminal_html';

type TerminalMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'copy'; data: string }
  | { type: 'requestPaste' };

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

export const Terminal = forwardRef<TerminalHandle, Props>(function Terminal({ onInput, onResize, output }, ref) {
  const web = useRef<WebView>(null);
  const lastOutput = useRef('');
  const currentOutput = useRef(output);
  currentOutput.current = output;

  const injectMessage = (obj: object) =>
    web.current?.injectJavaScript(
      `window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify(obj))}}));true;`
    );

  useEffect(() => {
    if (output === lastOutput.current) return;
    if (output.length < lastOutput.current.length) {
      injectMessage({ type: 'clear' });
      lastOutput.current = '';
    }
    if (!output) return;
    const data = output.slice(lastOutput.current.length);
    lastOutput.current = output;
    injectMessage({ type: 'output', data });
  }, [output]);

  const onMessage = useCallback(
    async ({ nativeEvent }: WebViewMessageEvent) => {
      const message = JSON.parse(nativeEvent.data) as TerminalMessage;
      if (message.type === 'input') onInput(message.data);
      if (message.type === 'resize') onResize(message.cols, message.rows);
      if (message.type === 'copy') await Clipboard.setStringAsync(message.data);
      if (message.type === 'requestPaste') {
        const text = await Clipboard.getStringAsync();
        injectMessage({ type: 'paste', data: text });
      }
    },
    [onInput, onResize],
  );

  useImperativeHandle(ref, () => ({
    copy: () => {
      web.current?.injectJavaScript(
        `window.ReactNativeWebView.postMessage(JSON.stringify({type:'copy',data:terminal.getSelection()||''}));true;`
      );
    },
    paste: () => {
      web.current?.injectJavaScript(
        `window.ReactNativeWebView.postMessage(JSON.stringify({type:'requestPaste'}));true;`
      );
    },
    selectAll: () => {
      web.current?.injectJavaScript(`terminal.selectAll();true;`);
    },
    blur: () => web.current?.injectJavaScript('if(typeof terminal !== "undefined") terminal.blur(); document.activeElement && document.activeElement.blur(); true;'),
    focus: () => web.current?.injectJavaScript('if(typeof terminal !== "undefined") terminal.focus(); true;'),
  }));

  if (Platform.OS === 'web') return <View style={styles.unavailable} />;

  return (
    <WebView ref={web} source={{ html: terminalHTML }} onLoadEnd={() => {
      lastOutput.current = '';
      if (currentOutput.current) {
        injectMessage({ type: 'output', data: currentOutput.current });
      }
    }} onMessage={onMessage} originWhitelist={['*']} style={styles.webview} />
  );
});

const styles = StyleSheet.create({
  webview: { flex: 1, backgroundColor: '#0A0A0A' },
  unavailable: { flex: 1, backgroundColor: '#0A0A0A' },
});
