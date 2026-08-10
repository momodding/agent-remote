import {
  MAX_MULTI_SESSIONS,
  addSession,
  closeSession,
  placeInSplit,
  reconcileSplit,
  updateOutput,
  type MultiSessionState,
} from './multi-session';

describe('multi-session state', () => {
  const session1: MultiSessionState = { sessionId: 's1', name: 'Shell 1', connectionEndpoint: 'https://example.com', output: 'output1' };
  const session2: MultiSessionState = { sessionId: 's2', name: 'Shell 2', connectionEndpoint: 'https://example.com', output: 'output2' };

  it('adds, closes, and updates sessions', () => {
    const sessions = addSession({}, session1);
    expect(addSession(sessions, session2)).toEqual({ s1: session1, s2: session2 });
    expect(closeSession({ s1: session1, s2: session2 }, 's1')).toEqual({ s2: session2 });
    expect(updateOutput(sessions, 's1', 'new output').s1.output).toBe('new output');
  });

  it('allows five open tabs', () => {
    expect(MAX_MULTI_SESSIONS).toBe(5);
  });

  it('places an inactive tab opposite a lone pane', () => {
    expect(placeInSplit({ left: 's1', right: null }, 's2', 'left')).toEqual({ left: 's2', right: 's1' });
    expect(placeInSplit({ left: 's1', right: null }, 's2', 'right')).toEqual({ left: 's1', right: 's2' });
  });

  it('replaces only the targeted split pane', () => {
    expect(placeInSplit({ left: 's1', right: 's2' }, 's3', 'right')).toEqual({ left: 's1', right: 's3' });
  });

  it('swaps visible panes and ignores a current-side drop', () => {
    const layout = { left: 's1', right: 's2' };
    expect(placeInSplit(layout, 's1', 'right')).toEqual({ left: 's2', right: 's1' });
    expect(placeInSplit(layout, 's1', 'left')).toBe(layout);
  });

  it('reconciles closed IDs while retaining order fallback', () => {
    expect(reconcileSplit({ left: 'closed', right: 's2' }, ['s1', 's2'])).toEqual({ left: 's2', right: null });
    expect(reconcileSplit({ left: 'closed', right: null }, ['s1', 's2'])).toEqual({ left: 's1', right: null });
    expect(reconcileSplit({ left: 'closed', right: null }, [])).toEqual({ left: null, right: null });
  });
});
