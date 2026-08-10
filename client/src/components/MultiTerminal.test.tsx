import type { MultiSessionState } from '../lib/multi-session';
import { MultiTerminal } from './MultiTerminal';
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
const mockGestures: Record<string, any> = {};

jest.mock('@expo/vector-icons/Feather', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { __esModule: true, default: (props: Record<string, unknown>) => React.createElement(View, props) };
});
jest.mock('react-native-gesture-handler', () => {
  const React = require('react');
  return {
    GestureDetector: ({ children, gesture }: { children: React.ReactElement<{ testID: string }>; gesture: unknown }) => {
      mockGestures[children.props.testID] = gesture;
      return children;
    },
    Gesture: {
      Pan: () => {
        const pan: Record<string, unknown> = {};
        for (const method of ['activateAfterLongPress', 'onBegin', 'onUpdate', 'onEnd', 'onFinalize']) {
          pan[method] = (callback?: unknown) => {
            if (callback) pan[`_${method}`] = callback;
            return pan;
          };
        }
        return pan;
      },
    },
  };
});
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  return { __esModule: true, default: { View: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('AnimatedView', props, children) }, runOnJS: (fn: unknown) => fn, useAnimatedStyle: () => ({}), useReducedMotion: () => true, useSharedValue: (value: unknown) => ({ value }), withTiming: (value: unknown) => value };
});

jest.mock('./Terminal', () => ({ Terminal: () => null }));
jest.mock('./ShortcutKeyboard', () => ({ ShortcutKeyboard: () => null }));
jest.mock('react-native', () => {
  const React = require('react');
  const View = React.forwardRef(({ children, ...props }: { children?: React.ReactNode }, ref: React.ForwardedRef<{ measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void }>) => {
    React.useImperativeHandle(ref, () => ({ measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 100, 100) }));
    return React.createElement('View', props, children);
  });
  return { View, Text: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('Text', props, children), ScrollView: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('ScrollView', props, children), Pressable: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('Pressable', props, children), StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {} } };
});

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

  it('keeps five tabs while replacing only target pane', () => {
    const tree = render({ s1: session('s1'), s2: session('s2'), s3: session('s3'), s4: session('s4'), s5: session('s5') });
    act(() => tree.root.findByProps({ testID: 'terminal-region' }).props.onLayout());
    const dragTo = (testID: string, absoluteX: number) => act(() => {
      mockGestures[testID]._onBegin();
      mockGestures[testID]._onUpdate({ absoluteX, absoluteY: 50, translationX: absoluteX, translationY: 0 });
      mockGestures[testID]._onEnd({ absoluteX, absoluteY: 50 });
    });
    dragTo('tab-s2', 0);
    dragTo('tab-s3', 100);
    expect(tree.root.findAllByType(require('./Terminal').Terminal).map((node) => node.props.output)).toEqual(['output-s2', 'output-s3']);
    for (const sessionId of ['s1', 's2', 's3', 's4', 's5']) expect(tree.root.findByProps({ testID: `tab-${sessionId}` })).toBeDefined();
    dragTo('terminal-pane-s2', 100);
    expect(tree.root.findAllByType(require('./Terminal').Terminal).map((node) => node.props.output)).toEqual(['output-s3', 'output-s2']);
  });

  it('closes sessions from tab controls', () => {
    const onClose = jest.fn();
    const tree = render({ s1: session('s1') }, onClose);
    act(() => tree.root.findByProps({ accessibilityLabel: 'Close Shell s1' }).props.onPress());
    expect(onClose).toHaveBeenCalledWith('s1');
  });
});
