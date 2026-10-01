jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(),
  getStringAsync: jest.fn(async () => 'clipboard-text'),
}));

const mockInjectJavaScript = jest.fn();
jest.mock('react-native-webview', () => {
  const React = require('react');
  const WebView = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({ injectJavaScript: mockInjectJavaScript }));
    return React.createElement('WebView', props);
  });
  return { __esModule: true, WebView };
});

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import * as Clipboard from 'expo-clipboard';
import { Terminal, type TerminalHandle } from './Terminal';

async function flush() {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

async function renderTerminal(props: { onInput?: jest.Mock; onResize?: jest.Mock; output?: string; ref?: React.RefObject<TerminalHandle | null> }) {
  const onInput = props.onInput ?? jest.fn();
  const onResize = props.onResize ?? jest.fn();
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<Terminal ref={props.ref} onInput={onInput} onResize={onResize} output={props.output ?? ''} />);
    await flush();
  });
  return { tree, onInput, onResize };
}

function findWebView(tree: ReactTestRenderer) {
  return tree.root.findByType('WebView' as never);
}

/** Decodes the dispatchEvent script injectMessage() produces back into the message object it carries. */
function decodeInjectedMessage(script: string) {
  const prefix = "window.dispatchEvent(new MessageEvent('message',{data:";
  const suffix = '}));true;';
  const literal = script.slice(prefix.length, script.length - suffix.length);
  return JSON.parse(JSON.parse(literal));
}

/** Dispatches a raw WebView message and awaits the async onMessage handler, surfacing a rejection instead of letting it escape unhandled. */
async function dispatchMessage(tree: ReactTestRenderer, data: string) {
  const webview = findWebView(tree);
  let caught: unknown;
  await act(async () => {
    try {
      await webview.props.onMessage({ nativeEvent: { data } });
    } catch (err) {
      caught = err;
    }
    await flush();
  });
  if (caught) throw caught;
}

describe('Terminal (WebView bridge)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards a WebView input message to onInput', async () => {
    const { tree, onInput } = await renderTerminal({});
    await dispatchMessage(tree, JSON.stringify({ type: 'input', data: 'marker-input' }));
    expect(onInput).toHaveBeenCalledWith('marker-input');
  });

  it('forwards a WebView resize message to onResize', async () => {
    const { tree, onResize } = await renderTerminal({});
    await dispatchMessage(tree, JSON.stringify({ type: 'resize', cols: 100, rows: 32 }));
    expect(onResize).toHaveBeenCalledWith(100, 32);
  });

  it('writes a copy message to the system clipboard', async () => {
    const { tree } = await renderTerminal({});
    await dispatchMessage(tree, JSON.stringify({ type: 'copy', data: 'selected-text' }));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('selected-text');
  });

  it('answers requestPaste by injecting the clipboard contents back into the WebView', async () => {
    const { tree } = await renderTerminal({});
    mockInjectJavaScript.mockClear();
    await dispatchMessage(tree, JSON.stringify({ type: 'requestPaste' }));
    expect(Clipboard.getStringAsync).toHaveBeenCalled();
    const script = mockInjectJavaScript.mock.calls.at(-1)?.[0] as string;
    expect(decodeInjectedMessage(script)).toEqual({ type: 'paste', data: 'clipboard-text' });
  });

  it('discards a malformed WebView message with a deterministic local warning instead of throwing or dropping silently', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { tree, onInput } = await renderTerminal({});
    await dispatchMessage(tree, 'not json');
    expect(warnSpy).toHaveBeenCalledWith('Terminal: discarding malformed WebView message', expect.any(Error));
    expect(onInput).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('reinjects accumulated output as a delta when output grows', async () => {
    const onInput = jest.fn();
    const onResize = jest.fn();
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Terminal onInput={onInput} onResize={onResize} output="first-chunk" />);
      await flush();
    });
    mockInjectJavaScript.mockClear();
    await act(async () => {
      tree.update(<Terminal onInput={onInput} onResize={onResize} output="first-chunksecond-chunk" />);
      await flush();
    });
    const script = mockInjectJavaScript.mock.calls.at(-1)?.[0] as string;
    expect(decodeInjectedMessage(script)).toEqual({ type: 'output', data: 'second-chunk' });
  });

  it('clears the viewport and resets when output shrinks (e.g. reconnect baseline replacement)', async () => {
    const onInput = jest.fn();
    const onResize = jest.fn();
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Terminal onInput={onInput} onResize={onResize} output="a-long-first-baseline" />);
      await flush();
    });
    mockInjectJavaScript.mockClear();
    await act(async () => {
      tree.update(<Terminal onInput={onInput} onResize={onResize} output="short" />);
      await flush();
    });
    const scripts = mockInjectJavaScript.mock.calls.map((call) => call[0] as string);
    const clearScript = scripts.find((s) => decodeInjectedMessage(s).type === 'clear');
    expect(clearScript).toBeDefined();
  });

  it('exposes imperative copy/paste/selectAll/focus/blur handles that post into the WebView', async () => {
    const ref = React.createRef<TerminalHandle>();
    await renderTerminal({ ref });
    mockInjectJavaScript.mockClear();
    ref.current?.copy();
    ref.current?.paste();
    ref.current?.selectAll();
    ref.current?.focus();
    ref.current?.blur();
    expect(mockInjectJavaScript).toHaveBeenCalledTimes(5);
  });
});
