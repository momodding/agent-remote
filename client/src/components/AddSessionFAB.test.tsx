jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  return { Alert: RN.Alert, Platform: RN.Platform, Pressable: RN.Pressable, StyleSheet: RN.StyleSheet, Text: RN.Text, TextInput: RN.TextInput, useColorScheme: () => 'dark', View: RN.View };
});
jest.mock('@gorhom/bottom-sheet', () => {
  const React = require('react');
  return {
    BottomSheetScrollView: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('BottomSheetScrollView', props, children),
    BottomSheetTextInput: (props: Record<string, unknown>) => React.createElement('BottomSheetTextInput', props),
    TouchableOpacity: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('TouchableOpacity', props, children),
  };
});
jest.mock('./GlassBottomSheet', () => {
  const React = require('react');
  return {
    GlassBottomSheet: React.forwardRef((props: { children?: React.ReactNode }, ref: React.Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({ present: () => {}, dismiss: () => {} }));
      return React.createElement('GlassBottomSheet', null, props.children);
    }),
  };
});
jest.mock('@expo/vector-icons/Feather', () => ({ __esModule: true, default: () => null }));

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform, TextInput } from 'react-native';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { AddSessionFAB } from './AddSessionFAB';
import type { AgenticRemoteAPI } from '../lib/api';

const mockApi = { shells: jest.fn(async () => []) } as unknown as AgenticRemoteAPI;

afterEach(() => jest.restoreAllMocks());

it('renders a plain TextInput on web, avoiding the unsupported bottom-sheet focus API', () => {
  Object.defineProperty(Platform, 'OS', { value: 'web' });
  let tree!: ReactTestRenderer;
  act(() => { tree = create(<AddSessionFAB api={mockApi} onAdd={() => {}} disabled={false} bottomInset={0} />); });
  expect(tree.root.findAllByType(TextInput)).toHaveLength(1);
  expect(tree.root.findAllByType(BottomSheetTextInput as never)).toHaveLength(0);
});

it('renders BottomSheetTextInput on native', () => {
  Object.defineProperty(Platform, 'OS', { value: 'android' });
  let tree!: ReactTestRenderer;
  act(() => { tree = create(<AddSessionFAB api={mockApi} onAdd={() => {}} disabled={false} bottomInset={0} />); });
  expect(tree.root.findAllByType(BottomSheetTextInput as never)).toHaveLength(1);
  expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
});
