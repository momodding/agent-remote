import {
  MAX_MULTI_SESSIONS,
  addSession,
  auxSlotCount,
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

  it('allows five open tabs with four web or one native auxiliary slots', () => {
    expect(MAX_MULTI_SESSIONS).toBe(5);
    expect(auxSlotCount({ OS: 'web' } as any)).toBe(4);
    expect(auxSlotCount({ OS: 'android' } as any)).toBe(1);
    expect(auxSlotCount({ OS: 'ios' } as any)).toBe(1);
  });

  it('places an inactive tab into only the indexed slot', () => {
    expect(placeInSplit(['s1', null, null], 's2', 1)).toEqual(['s1', 's2', null]);
    expect(placeInSplit(['s1', 's2', null, null, null], 's3', 4)).toEqual(['s1', 's2', null, null, 's3']);
  });

  it('swaps visible sessions and prevents duplicate placement', () => {
    const layout = ['s1', 's2', null];
    expect(placeInSplit(layout, 's1', 1)).toEqual(['s2', 's1', null]);
    expect(placeInSplit(layout, 's1', 0)).toBe(layout);
  });

  it('compacts valid unique sessions deterministically to the active slot count', () => {
    expect(reconcileSplit(['closed', 's2', null, 's2', 's1'], ['s1', 's2'], 5)).toEqual(['s2', 's1', null, null, null]);
    expect(reconcileSplit(['s1', 's2', 's3', 's4', 's5'], ['s1', 's2', 's3', 's4', 's5'], 3)).toEqual(['s1', 's2', 's3']);
    expect(reconcileSplit(['closed', null, null], ['s1', 's2'], 3)).toEqual(['s1', null, null]);
    expect(reconcileSplit(['closed', null, null], [], 3)).toEqual([null, null, null]);
  });
});
