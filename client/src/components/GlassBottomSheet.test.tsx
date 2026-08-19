jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  return { Platform: RN.Platform, StyleSheet: RN.StyleSheet, Text: RN.Text, useColorScheme: () => 'dark' };
});
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock('@gorhom/bottom-sheet', () => {
  const React = require('react');
  return {
    BottomSheetBackdrop: () => null,
    BottomSheetModal: React.forwardRef(({ children, ...props }: { children?: React.ReactNode }, ref: React.Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({ present: () => {}, dismiss: () => {} }));
      return React.createElement('BottomSheetModal', props, children);
    }),
    BottomSheetView: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('BottomSheetView', props, children),
  };
});
jest.mock('expo-blur', () => ({ BlurView: () => null }));

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform } from 'react-native';
import { GlassBottomSheet } from './GlassBottomSheet';

function renderSheet() {
  let tree!: ReactTestRenderer;
  act(() => { tree = create(<GlassBottomSheet title="New session"><></></GlassBottomSheet>); });
  return tree.root.findByType('BottomSheetModal' as never);
}

afterEach(() => jest.restoreAllMocks());

it('keeps web sheets below browser chrome', () => {
  Object.defineProperty(Platform, 'OS', { value: 'web' });
  expect(renderSheet().props.snapPoints).toEqual(['55%', '90%']);
});

it('keeps full-height expansion on native', () => {
  Object.defineProperty(Platform, 'OS', { value: 'android' });
  expect(renderSheet().props.snapPoints).toEqual(['55%', '100%']);
});
