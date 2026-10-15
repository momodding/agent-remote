import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform, Text, View } from 'react-native';
import type { TmuxPane } from '../protocol';
import { TmuxPaneSheet, type TmuxPaneSheetHandle } from './TmuxPaneSheet';

jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  const platformState = { current: 'android' };
  const colorSchemeState = { current: 'dark' };
  return {
    Platform: {
      get OS() {
        return platformState.current;
      },
    },
    StyleSheet: RN.StyleSheet,
    Text: RN.Text,
    View: RN.View,
    Pressable: RN.Pressable,
    useColorScheme: () => colorSchemeState.current,
    __setPlatform: (os: string) => {
      platformState.current = os;
    },
    __setColorScheme: (scheme: 'dark' | 'light') => {
      colorSchemeState.current = scheme;
    },
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons/Feather', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => React.createElement(View, props),
  };
});

let mockDismiss = jest.fn();
let mockPresent = jest.fn();

jest.mock('./GlassBottomSheet', () => {
  const React = require('react');
  return {
    GlassBottomSheet: React.forwardRef(
      (
        { title, children }: { title: string; children?: React.ReactNode },
        ref: React.Ref<{ present: () => void; dismiss: () => void }>,
      ) => {
        React.useImperativeHandle(ref, () => ({
          present: mockPresent,
          dismiss: mockDismiss,
        }));
        return React.createElement('GlassBottomSheet', { title }, children);
      },
    ),
  };
});

jest.mock('@gorhom/bottom-sheet', () => {
  const React = require('react');
  return {
    BottomSheetScrollView: ({
      children,
      ...props
    }: {
      children?: React.ReactNode;
      [key: string]: unknown;
    }) => React.createElement('BottomSheetScrollView', props, children),
  };
});

describe('TmuxPaneSheet', () => {
  beforeEach(() => {
    mockDismiss = jest.fn();
    mockPresent = jest.fn();
    const { __setPlatform, __setColorScheme } = require('react-native');
    __setPlatform('android');
    __setColorScheme('dark');
  });

  const samplePanes: TmuxPane[] = [
    {
      serverId: 'srv1',
      sessionId: '$1',
      sessionName: 'dev',
      windowId: '@1',
      windowName: 'editor',
      windowIndex: 0,
      paneIndex: 0,
      paneId: '%0',
      terminalSessionId: 'sess-1',
      cwd: '/home/user/code/project',
      active: true,
    },
    {
      serverId: 'srv1',
      sessionId: '$1',
      sessionName: 'dev',
      windowId: '@2',
      windowName: 'server',
      windowIndex: 1,
      paneIndex: 1,
      paneId: '%1',
      terminalSessionId: 'sess-2',
      cwd: '/home/user/code/project/backend',
      active: false,
    },
  ];

  it('renders empty message when no panes are available', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <TmuxPaneSheet panes={[]} onSelect={jest.fn()} />,
      );
    });
    const { Text } = require('react-native');
    const texts = tree.root.findAllByType(Text);
    const emptyText = texts.find((t) =>
      t.props.children?.includes('No persistent panes in this daemon.'),
    );
    expect(emptyText).toBeDefined();
  });

  it('renders list of panes with correct accessibility labels and selection indicator', () => {
    const onSelect = jest.fn();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <TmuxPaneSheet panes={samplePanes} currentPaneId="%0" onSelect={onSelect} />,
      );
    });

    const row0 = tree.root.findByProps({ accessibilityLabel: 'Open dev editor pane 1' });
    const row1 = tree.root.findByProps({ accessibilityLabel: 'Open dev server pane 2' });
    expect(row0.props.accessibilityState).toEqual({ selected: true });
    expect(row1.props.accessibilityState).toEqual({ selected: false });

    act(() => {
      row1.props.onPress();
    });
    expect(onSelect).toHaveBeenCalledWith(samplePanes[1]);
    expect(mockDismiss).toHaveBeenCalled();
  });

  it('renders 12 long panes in a bounded scroll view with two-line text and naturally growing rows', () => {
    const longPanes: TmuxPane[] = Array.from({ length: 12 }, (_, i) => ({
      serverId: 'srv1',
      sessionId: `$${i}`,
      sessionName: i === 0
        ? 'extremely-long-session-name-for-a-very-large-monorepo-project-with-many-services'
        : `session-${i}`,
      windowId: `@${i}`,
      windowName: i === 0
        ? 'deeply-nested-frontend-client-worker-thread-pane-with-an-intentionally-long-name'
        : `window-${i}`,
      windowIndex: i,
      paneIndex: i,
      paneId: `%${i}`,
      terminalSessionId: `sess-${i}`,
      cwd: i === 0
        ? '/var/log/containers/deeply/nested/path/to/enterprise/microservices/app/client/node_modules/with/a/path/that/is-longer/than/one/hundred/characters'
        : `/workspace/pane-${i}`,
      active: i === 0,
    }));

    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <TmuxPaneSheet panes={longPanes} currentPaneId="%0" onSelect={jest.fn()} />,
      );
    });

    const { Text } = require('react-native');
    const texts = tree.root.findAllByType(Text);
    const titleText = texts.find((t) =>
      String(t.props.children).includes('extremely-long-session-name-for-a-very-large-monorepo-project'),
    );
    const detailText = texts.find((t) =>
      String(t.props.children).includes('/var/log/containers/deeply/nested/path/to/enterprise/microservices'),
    );
    expect(titleText?.props.numberOfLines).toBe(2);
    expect(titleText?.props.allowFontScaling).not.toBe(false);
    expect(detailText?.props.numberOfLines).toBe(2);
    expect(detailText?.props.allowFontScaling).not.toBe(false);

    for (let i = 0; i < 12; i++) {
      const row = tree.root.findByProps({
        accessibilityLabel: `Open ${longPanes[i].sessionName} ${longPanes[i].windowName} pane ${i + 1}`,
      });
      expect(row).toBeDefined();
    }

    const longRow = tree.root.findByProps({
      accessibilityLabel: `Open ${longPanes[0].sessionName} ${longPanes[0].windowName} pane 1`,
    });
    const rowStyle = longRow.props.style({ pressed: false });
    expect(rowStyle).toEqual(
      expect.arrayContaining([expect.objectContaining({ minHeight: 58, paddingVertical: 10, alignItems: 'flex-start' })]),
    );
    expect(rowStyle[0].height).toBeUndefined();
  });

  it('renders many panes in a flexed scroll view on narrow web viewports', () => {
    const { __setPlatform } = require('react-native');
    __setPlatform('web');

    const manyPanes: TmuxPane[] = Array.from({ length: 25 }, (_, i) => ({
      serverId: 'srv-web',
      sessionId: `$${i}`,
      sessionName: `session-${i}`,
      windowId: `@${i}`,
      windowName: `win-${i}`,
      windowIndex: i,
      paneIndex: i,
      paneId: `%${i}`,
      terminalSessionId: `sess-${i}`,
      cwd: `/workspace/pane-${i}`,
      active: i === 10,
    }));

    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <TmuxPaneSheet panes={manyPanes} currentPaneId="%10" onSelect={jest.fn()} />,
      );
    });

    const scrollView = tree.root.findByType('BottomSheetScrollView' as never);
    expect(scrollView).toBeDefined();
    expect(scrollView.props.style).toEqual(
      expect.objectContaining({ flex: 1, minHeight: 0 }),
    );
    expect(scrollView.props.contentContainerStyle).toEqual(
      expect.objectContaining({ flexGrow: 1, paddingHorizontal: 12, paddingBottom: 28 }),
    );

    for (let i = 0; i < 25; i++) {
      const row = tree.root.findByProps({ accessibilityLabel: `Open session-${i} win-${i} pane ${i + 1}` });
      expect(row).toBeDefined();
    }
    const selectedRow = tree.root.findByProps({ accessibilityLabel: 'Open session-10 win-10 pane 11' });
    expect(selectedRow.props.accessibilityState).toEqual({ selected: true });
  });

  it('exposes imperative present and dismiss handles', () => {
    const sheetRef = React.createRef<TmuxPaneSheetHandle>();
    act(() => {
      create(
        <TmuxPaneSheet ref={sheetRef} panes={samplePanes} onSelect={jest.fn()} />,
      );
    });

    act(() => {
      sheetRef.current?.present();
    });
    expect(mockPresent).toHaveBeenCalledTimes(1);

    act(() => {
      sheetRef.current?.dismiss();
    });
    expect(mockDismiss).toHaveBeenCalledTimes(1);
  });
});
