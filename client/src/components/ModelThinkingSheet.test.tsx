import React from 'react';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ModelThinkingSheet } from './ModelThinkingSheet';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));

jest.mock('@gorhom/bottom-sheet', () => {
  const React = require('react');
  return {
    BottomSheetBackdrop: () => null,
    BottomSheetModal: React.forwardRef(({ children, ...props }: { children?: React.ReactNode }, ref: React.Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({ present: () => {}, dismiss: () => {} }));
      return React.createElement('BottomSheetModal', props, children);
    }),
    BottomSheetView: ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement('BottomSheetView', props, children),
    BottomSheetScrollView: ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement('BottomSheetScrollView', props, children),
  };
});

jest.mock('expo-blur', () => ({ BlurView: () => null }));
jest.mock('@expo/vector-icons/Feather', () => ({ __esModule: true, default: () => null }));

describe('ModelThinkingSheet', () => {
  const sampleModels = [
    { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', provider: 'anthropic' },
    { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
  ];

  const sampleThinking = ['off', 'low', 'medium', 'high', 'max'];

  it('renders available models and calls onSelectModel when pressed', () => {
    const onSelectModel = jest.fn();
    const onSelectThinking = jest.fn();

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ModelThinkingSheet
          currentModel={sampleModels[0]}
          currentThinking="high"
          availableModels={sampleModels}
          availableThinking={sampleThinking}
          modelEnabled={true}
          thinkingEnabled={true}
          onSelectModel={onSelectModel}
          onSelectThinking={onSelectThinking}
        />,
      );
    });

    const buttons = renderer.root.findAllByProps({ accessibilityRole: 'button' });
    const gpt4oButton = buttons.find(
      (b) => b.props.accessibilityLabel === 'Select model GPT-4o',
    );
    expect(gpt4oButton).toBeDefined();

    act(() => {
      gpt4oButton?.props.onPress();
    });

    expect(onSelectModel).toHaveBeenCalledWith('gpt-4o');
  });

  it('renders available thinking levels and calls onSelectThinking when pressed', () => {
    const onSelectModel = jest.fn();
    const onSelectThinking = jest.fn();

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ModelThinkingSheet
          currentModel={sampleModels[0]}
          currentThinking="off"
          availableModels={sampleModels}
          availableThinking={sampleThinking}
          modelEnabled={true}
          thinkingEnabled={true}
          onSelectModel={onSelectModel}
          onSelectThinking={onSelectThinking}
        />,
      );
    });

    const buttons = renderer.root.findAllByProps({ accessibilityRole: 'button' });
    const highButton = buttons.find(
      (b) => b.props.accessibilityLabel === 'Select thinking level high',
    );
    expect(highButton).toBeDefined();

    act(() => {
      highButton?.props.onPress();
    });

    expect(onSelectThinking).toHaveBeenCalledWith('high');
  });

  it('displays disabled notices when capabilities are disabled', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ModelThinkingSheet
          currentModel={sampleModels[0]}
          currentThinking="off"
          availableModels={sampleModels}
          availableThinking={sampleThinking}
          modelEnabled={false}
          thinkingEnabled={false}
          onSelectModel={jest.fn()}
          onSelectThinking={jest.fn()}
        />,
      );
    });

    const textNodes = renderer.root.findAllByType(Text);
    const texts = textNodes.map((t) => t.props.children).flat();

    expect(
      texts.some(
        (t) =>
          typeof t === 'string' &&
          t.includes('Model switching is not supported'),
      ),
    ).toBe(true);

    expect(
      texts.some(
        (t) =>
          typeof t === 'string' &&
          t.includes('Thinking level adjustment is not supported'),
      ),
    ).toBe(true);
  });
});
