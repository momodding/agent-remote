import { Platform } from 'react-native';
import { addSession, closeSession, getPlatformMax, toggleMinimize, updateOutput, type MultiSessionState } from './multi-session';

jest.mock('react-native', () => ({
  Platform: { OS: 'web' },
}));

describe('multi-session state', () => {
  const session1: MultiSessionState = {
    sessionId: 's1',
    name: 'Shell 1',
    connectionEndpoint: 'https://example.com',
    output: 'output1',
    minimized: false,
  };

  const session2: MultiSessionState = {
    sessionId: 's2',
    name: 'Shell 2',
    connectionEndpoint: 'https://example.com',
    output: 'output2',
    minimized: false,
  };

  it('adds sessions', () => {
    const sessions = addSession({}, session1);
    expect(sessions).toEqual({ s1: session1 });
    expect(addSession(sessions, session2)).toEqual({ s1: session1, s2: session2 });
  });

  it('closes sessions', () => {
    const sessions = { s1: session1, s2: session2 };
    expect(closeSession(sessions, 's1')).toEqual({ s2: session2 });
    expect(closeSession(sessions, 's2')).toEqual({ s1: session1 });
  });

  it('toggles minimize', () => {
    const sessions = { s1: session1 };
    const minimized = toggleMinimize(sessions, 's1');
    expect(minimized.s1.minimized).toBe(true);
    expect(toggleMinimize(minimized, 's1').s1.minimized).toBe(false);
  });

  it('updates output', () => {
    const sessions = { s1: session1 };
    const updated = updateOutput(sessions, 's1', 'new output');
    expect(updated.s1.output).toBe('new output');
    expect(updated.s1.name).toBe('Shell 1');
  });

  it('returns platform max (4 for web, 2 for native)', () => {
    expect(getPlatformMax()).toBe(4);
    (Platform as { OS: string }).OS = 'android';
    expect(getPlatformMax()).toBe(2);
    (Platform as { OS: string }).OS = 'ios';
    expect(getPlatformMax()).toBe(2);
  });
});
