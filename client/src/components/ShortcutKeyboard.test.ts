import { createElement, createRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Pressable } from 'react-native';
import { modifiedTerminalInput, ShortcutKeyboard, type ShortcutKeyboardHandle, terminalRows } from './ShortcutKeyboard';

describe('terminal shortcuts', () => {
  it('uses xterm-compatible special-key byte sequences', () => {
    expect(terminalRows[0].find((key) => key.label === '⇧Tab')?.data).toBe('\x1b[Z');
    expect(terminalRows[0].find((key) => key.label === '^C')?.data).toBe('\x03');
    expect(terminalRows[3].find((key) => key.label === 'F12')?.data).toBe('\x1b[24~');
  });

  it('applies Ctrl and Alt to one-character input', () => {
    expect(modifiedTerminalInput('c', 'ctrl')).toBe('\x03');
    expect(modifiedTerminalInput('x', 'alt')).toBe('\x1bx');
    expect(modifiedTerminalInput('\x1b[A', 'ctrl')).toBe('\x1b[A');
  });

  it('routes imperative and shortcut input through one-shot modifiers', () => {
    const onInput = jest.fn();
    const ref = createRef<ShortcutKeyboardHandle>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(createElement(ShortcutKeyboard, { ref, onInput })); });
    const ctrl = tree.root.findByProps({ accessibilityLabel: 'Ctrl' });

    act(() => ctrl.props.onPress());
    act(() => ref.current?.input('c'));
    act(() => ref.current?.input('x'));

    expect(onInput.mock.calls).toEqual([['\x03'], ['x']]);
  });

  it('keeps long-press modifiers locked for imperative and shortcut input', () => {
    const onInput = jest.fn();
    const ref = createRef<ShortcutKeyboardHandle>();
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(createElement(ShortcutKeyboard, { ref, onInput })); });
    const ctrl = tree.root.findByProps({ accessibilityLabel: 'Ctrl' });

    act(() => ctrl.props.onLongPress());
    act(() => ref.current?.input('c'));
    act(() => tree.root.findByProps({ accessibilityLabel: 'Esc' }).props.onPress());

    expect(onInput.mock.calls).toEqual([['\x03'], ['\x1b']]);
  });

  it('offsets the shortcut dock above Android keyboard inset', () => {
    let tree!: ReactTestRenderer;
    act(() => { tree = create(createElement(ShortcutKeyboard, { onInput: jest.fn(), keyboardInset: 216 })); });

    expect(tree.root.findByProps({ testID: 'shortcut-dock' }).props.style).toEqual(expect.arrayContaining([{ marginBottom: 216 }]));
  });
});
