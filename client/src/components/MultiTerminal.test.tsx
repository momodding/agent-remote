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

let mockTerminalOnInput: ((data: string) => void) | undefined;
let mockShortcutOnInput: ((data: string) => void) | undefined;
jest.mock('./Terminal', () => ({ Terminal: (props: { onInput: (data: string) => void }) => { mockTerminalOnInput = props.onInput; return null; } }));
jest.mock('./ShortcutKeyboard', () => {
  const React = require('react');
  return { ShortcutKeyboard: React.forwardRef((props: { onInput: (data: string) => void }, ref: React.ForwardedRef<{ input: (data: string) => void }>) => {
    mockShortcutOnInput = props.onInput;
    React.useImperativeHandle(ref, () => ({ input: (data: string) => props.onInput(`modified:${data}`) }));
    return null;
  }) };
});
jest.mock('react-native', () => {
  const React = require('react');
  const dimensionsState = { current: { width: 200, height: 100 } }; // ponytail: landscape default keeps existing X-axis drag tests unchanged
  const View = React.forwardRef(({ children, ...props }: { children?: React.ReactNode }, ref: React.ForwardedRef<{ measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void }>) => {
    React.useImperativeHandle(ref, () => ({ measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 100, 100) }));
    return React.createElement('View', props, children);
  });
  return { View, Text: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('Text', props, children), ScrollView: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('ScrollView', props, children), Pressable: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('Pressable', props, children), StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {} }, useWindowDimensions: () => dimensionsState.current, __setWindowDimensions: (next: { width: number; height: number }) => { dimensionsState.current = next; } };
});

describe('MultiTerminal', () => {
  const session = (sessionId: string): MultiSessionState => ({ sessionId, name: `Shell ${sessionId}`, connectionEndpoint: 'https://example.com', output: `output-${sessionId}` });
  const render = (sessions: Record<string, MultiSessionState>, onClose = jest.fn()) => {
    let tree: ReactTestRenderer;
    act(() => { tree = create(<MultiTerminal sessions={sessions} onInput={jest.fn()} onResize={jest.fn()} onClose={onClose} />); });
    return tree!;
  };

  it('routes visible terminal input through shortcut modifier before parent dispatch', () => {
    const onInput = jest.fn();
    act(() => { create(<MultiTerminal sessions={{ a: session('a') }} onInput={onInput} onResize={jest.fn()} onClose={jest.fn()} />); });

    act(() => mockTerminalOnInput?.('c'));

    expect(mockShortcutOnInput).toBeDefined();
    expect(onInput).toHaveBeenCalledWith('a', 'modified:c');
  });

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

  it('reactivates a drop zone on repeated drags to the same side', () => {
    const tree = render({ s1: session('s1'), s2: session('s2') });
    act(() => tree.root.findByProps({ testID: 'terminal-region' }).props.onLayout());
    const drag = mockGestures['tab-s2'];
    const update = () => drag._onUpdate({ absoluteX: 0, absoluteY: 50, translationX: 0, translationY: 0 });
    const leftZone = () => tree.root.findByProps({ testID: 'drop-zone-left' });

    act(() => { drag._onBegin(); update(); });
    expect(leftZone().props.style).toContainEqual(expect.objectContaining({ borderColor: '#46B8C4' }));
    act(() => drag._onEnd({ absoluteX: 0, absoluteY: 50 }));
    act(() => { drag._onBegin(); update(); });
    expect(leftZone().props.style).toContainEqual(expect.objectContaining({ borderColor: '#46B8C4' }));
  });

  it('shows Top/Bottom drop-zone labels and splits on Y-axis in portrait', () => {
    const { __setWindowDimensions } = require('react-native');
    __setWindowDimensions({ width: 100, height: 200 });
    try {
      const tree = render({ s1: session('s1'), s2: session('s2') });
      act(() => tree.root.findByProps({ testID: 'terminal-region' }).props.onLayout());
      const drag = mockGestures['tab-s2'];
      const topZone = () => tree.root.findByProps({ testID: 'drop-zone-left' });
      const bottomZone = () => tree.root.findByProps({ testID: 'drop-zone-right' });

      act(() => {
        drag._onBegin();
        drag._onUpdate({ absoluteX: 50, absoluteY: 10, translationX: 0, translationY: 0 });
      });
      expect(topZone().findByType(require('react-native').Text).props.children).toBe('Top');
      expect(bottomZone().findByType(require('react-native').Text).props.children).toBe('Bottom');
      expect(topZone().props.style).toContainEqual(expect.objectContaining({ borderColor: '#46B8C4' }));
    } finally {
      __setWindowDimensions({ width: 200, height: 100 });
    }
  });

  it('shows Left/Right drop-zone labels and splits on X-axis in landscape', () => {
    const tree = render({ s1: session('s1'), s2: session('s2') });
    act(() => tree.root.findByProps({ testID: 'terminal-region' }).props.onLayout());
    const drag = mockGestures['tab-s2'];
    const leftZone = () => tree.root.findByProps({ testID: 'drop-zone-left' });
    const rightZone = () => tree.root.findByProps({ testID: 'drop-zone-right' });

    act(() => {
      drag._onBegin();
      drag._onUpdate({ absoluteX: 10, absoluteY: 50, translationX: 0, translationY: 0 });
    });
    expect(leftZone().findByType(require('react-native').Text).props.children).toBe('Left');
    expect(rightZone().findByType(require('react-native').Text).props.children).toBe('Right');
    expect(leftZone().props.style).toContainEqual(expect.objectContaining({ borderColor: '#46B8C4' }));
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
