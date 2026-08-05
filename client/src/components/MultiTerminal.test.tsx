jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import Feather from '@expo/vector-icons/Feather';

jest.mock('@expo/vector-icons/Feather', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => React.createElement(View, { 'data-testid': 'feather-mock', ...props })
  };
});

import { MultiTerminal } from './MultiTerminal';
import type { MultiSessionState } from '../lib/multi-session';

jest.mock('./Terminal', () => ({
  Terminal: ({ output, onInput, onResize }: { output: string; onInput: (data: string) => void; onResize: (cols: number, rows: number) => void }) => null,
}));

jest.mock('./ShortcutKeyboard', () => ({
  ShortcutKeyboard: ({ onInput }: { onInput: (data: string) => void }) => null,
}));

jest.mock('react-native', () => ({
  View: ({ children }: { children?: React.ReactNode }) => children,
  Text: ({ children }: { children?: React.ReactNode }) => children,
  Pressable: ({ children }: { children?: React.ReactNode }) => children,
  ScrollView: ({ children }: { children?: React.ReactNode }) => children,
  Platform: { OS: 'web', select: <T,>(specifics: { web?: T; default?: T }) => specifics.web ?? specifics.default },
  StyleSheet: { create: <T,>(styles: T) => styles },
}));

describe('MultiTerminal', () => {
  const session1: MultiSessionState = {
    sessionId: 's1',
    name: 'Shell 1',
    connectionEndpoint: 'https://example.com',
    output: 'output1',
    minimized: false,
  };

  const session2: MultiSessionState = {
    sessionId: 's2',
    name: 'Shell 2',
    connectionEndpoint: 'https://example.com',
    output: 'output2',
    minimized: false,
  };

  const session3: MultiSessionState = {
    sessionId: 's3',
    name: 'Shell 3',
    connectionEndpoint: 'https://example.com',
    output: 'output3',
    minimized: true,
  };

  it('renders visible sessions in grid and minimized sessions in strip', () => {
    let tree: ReactTestRenderer;
    act(() => {
      tree = create(
        <MultiTerminal
          sessions={{ s1: session1, s2: session2, s3: session3 }}
          onInput={jest.fn()}
          onResize={jest.fn()}
          onMinimize={jest.fn()}
          onClose={jest.fn()}
          isBroadcasting={false}
          onBroadcastToggle={jest.fn()}
          platformMax={4}
        />
      );
    });

    expect(tree!.root.findAllByType(require('./Terminal').Terminal)).toHaveLength(2);
    expect(tree!.root.findByProps({ accessibilityLabel: 'Restore Shell 3' })).toBeDefined();
  });

  it('delegates broadcast routing up and emits only for the originating pane when broadcast enabled', () => {
    const onInput = jest.fn();
    let tree: ReactTestRenderer;
    act(() => {
      tree = create(
        <MultiTerminal
          sessions={{ s1: session1, s2: session2, s3: session3 }}
          onInput={onInput}
          onResize={jest.fn()}
          onMinimize={jest.fn()}
          onClose={jest.fn()}
          isBroadcasting={true}
          onBroadcastToggle={jest.fn()}
          platformMax={4}
        />
      );
    });

    const terminals = tree!.root.findAllByType(require('./Terminal').Terminal);
    expect(terminals.length).toBe(2); // s1 and s2 visible

    act(() => terminals[0].props.onInput('test'));
    // It should ONLY call onInput once for the originating terminal, because the parent screen ([id].tsx) will handle broadcasting it.
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith('s1', 'test');
  });

  it('sends input to single session when broadcast disabled', () => {
    const onInput = jest.fn();
    let tree: ReactTestRenderer;
    act(() => {
      tree = create(
        <MultiTerminal
          sessions={{ s1: session1 }}
          onInput={onInput}
          onResize={jest.fn()}
          onMinimize={jest.fn()}
          onClose={jest.fn()}
          isBroadcasting={false}
          onBroadcastToggle={jest.fn()}
          platformMax={4}
        />
      );
    });

    const terminal = tree!.root.findByType(require('./Terminal').Terminal);
    act(() => terminal.props.onInput('test'));
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith('s1', 'test');
  });

  it('calls onMinimize and onClose for pane actions', () => {
    const onMinimize = jest.fn();
    const onClose = jest.fn();
    let tree: ReactTestRenderer;

    act(() => {
      tree = create(
        <MultiTerminal
          sessions={{ s1: session1 }}
          onInput={jest.fn()}
          onResize={jest.fn()}
          onMinimize={onMinimize}
          onClose={onClose}
          isBroadcasting={false}
          onBroadcastToggle={jest.fn()}
          platformMax={4}
        />
      );
    });

    const minimizeButton = tree!.root.findAll((node) => node.props.accessibilityLabel === 'Minimize Shell 1')[0];
    act(() => minimizeButton.props.onPress());
    expect(onMinimize).toHaveBeenCalledWith('s1');

    const closeButton = tree!.root.findAll((node) => node.props.accessibilityLabel === 'Close Shell 1')[0];
    act(() => closeButton.props.onPress());
    expect(onClose).toHaveBeenCalledWith('s1');
  });

  it('toggles broadcast state via toolbar button', () => {
    const onBroadcastToggle = jest.fn();
    let tree: ReactTestRenderer;
    act(() => {
      tree = create(
        <MultiTerminal
          sessions={{ s1: session1 }}
          onInput={jest.fn()}
          onResize={jest.fn()}
          onMinimize={jest.fn()}
          onClose={jest.fn()}
          isBroadcasting={false}
          onBroadcastToggle={onBroadcastToggle}
          platformMax={4}
        />
      );
    });

    const broadcastButton = tree!.root.findAll((node) =>
      node.props.accessibilityLabel === 'Enable broadcast' || node.props.accessibilityLabel === 'Disable broadcast'
    )[0];
    act(() => broadcastButton.props.onPress());
    expect(onBroadcastToggle).toHaveBeenCalledTimes(1);
  });
});
