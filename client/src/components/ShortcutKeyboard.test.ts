import { modifiedTerminalInput, terminalRows } from './ShortcutKeyboard';

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
});
