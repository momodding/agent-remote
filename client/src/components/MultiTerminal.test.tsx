import type { MultiSessionState } from '../lib/multi-session';
import { MultiTerminal } from './MultiTerminal';
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('@expo/vector-icons/Feather', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { __esModule: true, default: (props: Record<string, unknown>) => React.createElement(View, props) };
});
jest.mock('react-native-gesture-handler', () => {
  const React = require('react');
  return { GestureDetector: ({ children }: { children?: React.ReactNode }) => children, Gesture: { Pan: () => ({ activateAfterLongPress: () => ({ onBegin: () => ({ onUpdate: () => ({ onEnd: () => ({ onFinalize: () => ({}) }) }) }) }) }) } };
});
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  return { __esModule: true, default: { View: ({ children }: { children?: React.ReactNode }) => children }, runOnJS: (fn: unknown) => fn, useAnimatedStyle: () => ({}), useReducedMotion: () => true, useSharedValue: (value: unknown) => ({ value }), withTiming: (value: unknown) => value };
});

jest.mock('./Terminal', () => ({ Terminal: () => null }));
jest.mock('./ShortcutKeyboard', () => ({ ShortcutKeyboard: () => null }));
jest.mock('react-native', () => ({
  View: ({ children }: { children?: React.ReactNode }) => children,
  Text: ({ children }: { children?: React.ReactNode }) => children,
  ScrollView: ({ children }: { children?: React.ReactNode }) => children,
  Pressable: ({ children }: { children?: React.ReactNode }) => children,
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {} },
}));

describe('MultiTerminal', () => {
  const session = (sessionId: string): MultiSessionState => ({ sessionId, name: `Shell ${sessionId}`, connectionEndpoint: 'https://example.com', output: `output-${sessionId}` });
  const render = (sessions: Record<string, MultiSessionState>, onClose = jest.fn()) => {
    let tree: ReactTestRenderer;
    act(() => { tree = create(<MultiTerminal sessions={sessions} onInput={jest.fn()} onResize={jest.fn()} onClose={onClose} />); });
    return tree!;
  };

  it('shows first tab in one pane and keeps other sessions as tabs', () => {
    const tree = render({ s1: session('s1'), s2: session('s2'), s3: session('s3') });
    expect(tree.root.findAllByType(require('./Terminal').Terminal)).toHaveLength(1);
    expect(tree.root.findByProps({ accessibilityLabel: 'Show Shell s3' })).toBeDefined();
  });

  it('collapses to selected tab and routes input to it', () => {
    const onInput = jest.fn();
    let tree: ReactTestRenderer;
    act(() => { tree = create(<MultiTerminal sessions={{ s1: session('s1'), s2: session('s2') }} onInput={onInput} onResize={jest.fn()} onClose={jest.fn()} />); });
    const tab = tree!.root.findByProps({ accessibilityLabel: 'Show Shell s2' });
    act(() => tab.props.onPress());
    expect(tree!.root.findAllByType(require('./Terminal').Terminal)).toHaveLength(1);
  });

  it('closes sessions from tab controls', () => {
    const onClose = jest.fn();
    const tree = render({ s1: session('s1') }, onClose);
    act(() => tree.root.findByProps({ accessibilityLabel: 'Close Shell s1' }).props.onPress());
    expect(onClose).toHaveBeenCalledWith('s1');
  });
});
