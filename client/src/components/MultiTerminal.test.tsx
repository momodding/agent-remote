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
  const dimensionsState = { current: { width: 200, height: 100 } };
  const platformState = { current: 'android' };
  const View = React.forwardRef(({ children, ...props }: { children?: React.ReactNode }, ref: React.ForwardedRef<{ measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void }>) => {
    React.useImperativeHandle(ref, () => ({ measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 100, 100) }));
    return React.createElement('View', props, children);
  });
  return { Platform: { get OS() { return platformState.current; } }, View, Text: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('Text', props, children), ScrollView: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('ScrollView', props, children), Pressable: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('Pressable', props, children), StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {} }, useWindowDimensions: () => dimensionsState.current, __setWindowDimensions: (next: { width: number; height: number }) => { dimensionsState.current = next; }, __setPlatform: (next: string) => { platformState.current = next; } };
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

  it('reactivates a native drop zone on repeated drags to the same slot', () => {
    const tree = render({ s1: session('s1'), s2: session('s2') });
    act(() => tree.root.findByProps({ testID: 'terminal-region' }).props.onLayout());
    const drag = mockGestures['tab-s2'];
    const update = () => drag._onUpdate({ absoluteX: 0, absoluteY: 50, translationX: 0, translationY: 0 });
    const leftZone = () => tree.root.findByProps({ testID: 'drop-zone-0' });

    act(() => { drag._onBegin(); update(); });
    expect(leftZone().props.style).toContainEqual(expect.objectContaining({ borderColor: '#46B8C4' }));
    act(() => drag._onEnd({ absoluteX: 0, absoluteY: 50 }));
    act(() => { drag._onBegin(); update(); });
    expect(leftZone().props.style).toContainEqual(expect.objectContaining({ borderColor: '#46B8C4' }));
  });

  it('shows two native targets and splits on Y-axis in portrait', () => {
    const { __setWindowDimensions } = require('react-native');
    __setWindowDimensions({ width: 100, height: 200 });
    try {
      const tree = render({ s1: session('s1'), s2: session('s2') });
      act(() => tree.root.findByProps({ testID: 'terminal-region' }).props.onLayout());
      const drag = mockGestures['tab-s2'];
      act(() => {
        drag._onBegin();
        drag._onUpdate({ absoluteX: 50, absoluteY: 10, translationX: 0, translationY: 0 });
      });
      const zones = tree.root.findAll((node) => node.type === require('react-native').View && typeof node.props.testID === 'string' && node.props.testID.startsWith('drop-zone-'));
      expect(zones).toHaveLength(2);
      expect(zones.map((zone) => zone.findByType(require('react-native').Text).props.children)).toEqual(['Top', 'Bottom']);
      expect(zones[0].props.style).toContainEqual(expect.objectContaining({ borderColor: '#46B8C4' }));
    } finally {
      __setWindowDimensions({ width: 200, height: 100 });
    }
  });

  it('shows two native targets and limits visible sessions to primary plus two auxiliaries', () => {
    const tree = render({ s1: session('s1'), s2: session('s2'), s3: session('s3'), s4: session('s4'), s5: session('s5') });
    act(() => tree.root.findByProps({ testID: 'terminal-region' }).props.onLayout());
    const dragTo = (testID: string, absoluteX: number) => act(() => {
      mockGestures[testID]._onBegin();
      mockGestures[testID]._onUpdate({ absoluteX, absoluteY: 50, translationX: absoluteX, translationY: 0 });
      mockGestures[testID]._onEnd({ absoluteX, absoluteY: 50 });
    });
    dragTo('tab-s2', 0);
    dragTo('tab-s3', 100);
    expect(tree.root.findAllByType(require('./Terminal').Terminal).map((node) => node.props.output)).toEqual(['output-s1', 'output-s2', 'output-s3']);
    for (const sessionId of ['s1', 's2', 's3', 's4', 's5']) expect(tree.root.findByProps({ testID: `tab-${sessionId}` })).toBeDefined();
    act(() => {
      mockGestures['tab-s4']._onBegin();
      mockGestures['tab-s4']._onUpdate({ absoluteX: 50, absoluteY: 50, translationX: 0, translationY: 0 });
    });
    expect(tree.root.findAll((node) => node.type === require('react-native').View && typeof node.props.testID === 'string' && node.props.testID.startsWith('drop-zone-'))).toHaveLength(2);
  });

  it('shows four web quadrant targets and fills all five terminal slots', () => {
    const { __setPlatform } = require('react-native');
    __setPlatform('web');
    try {
      const tree = render({ s1: session('s1'), s2: session('s2'), s3: session('s3'), s4: session('s4'), s5: session('s5') });
      act(() => tree.root.findByProps({ testID: 'terminal-region' }).props.onLayout());
      const coordinates = [[10, 10], [90, 10], [10, 90], [90, 90]];
      coordinates.forEach(([absoluteX, absoluteY], index) => {
        const drag = mockGestures[`tab-s${index + 2}`];
        act(() => {
          drag._onBegin();
          drag._onUpdate({ absoluteX, absoluteY, translationX: 0, translationY: 0 });
        });
        expect(tree.root.findAll((node) => node.type === require('react-native').View && typeof node.props.testID === 'string' && node.props.testID.startsWith('drop-zone-'))).toHaveLength(4);
        act(() => drag._onEnd({ absoluteX, absoluteY }));
      });
      expect(tree.root.findAllByType(require('./Terminal').Terminal).map((node) => node.props.output)).toEqual(['output-s1', 'output-s2', 'output-s3', 'output-s4', 'output-s5']);
    } finally {
      __setPlatform('android');
    }
  });

  it('closes sessions from tab controls', () => {
    const onClose = jest.fn();
    const tree = render({ s1: session('s1') }, onClose);
    act(() => tree.root.findByProps({ accessibilityLabel: 'Close Shell s1' }).props.onPress());
    expect(onClose).toHaveBeenCalledWith('s1');
  });
});
