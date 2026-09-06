import { ompReducer, initialOmpState } from './omp-adapter';
import type { AgentSessionEvent } from '../tabs/rpc-types';

describe('omp-adapter reducer', () => {
  it('handles message events', () => {
    const s1 = ompReducer(initialOmpState, { type: 'turn_start' });
    expect(s1.turns.length).toBe(1);
    const s2 = ompReducer(s1, { type: 'message_start', message: { role: 'assistant', content: 'hello' } });
    expect(s2.turns[0].content).toBe('hello');
  });

  it('handles tool calls', () => {
    let s = ompReducer(initialOmpState, { type: 'turn_start' });
    s = ompReducer(s, { type: 'tool_execution_start', toolCallId: 't1', toolName: 'test', args: { a: 1 } });
    expect(s.turns[0].toolCalls.length).toBe(1);
    expect(s.turns[0].toolCalls[0].done).toBe(false);

    s = ompReducer(s, { type: 'tool_execution_update', toolCallId: 't1', toolName: 'test', args: { a: 1, b: 2 }, partialResult: 'loading' });
    expect(s.turns[0].toolCalls[0].args).toEqual({ a: 1, b: 2 });
    
    s = ompReducer(s, { type: 'tool_execution_end', toolCallId: 't1', toolName: 'test', result: 'done', isError: false });
    expect(s.turns[0].toolCalls[0].done).toBe(true);
    expect(s.turns[0].toolCalls[0].result).toBe('done');
  });

  it('handles thinking level changed', () => {
    const s = ompReducer(initialOmpState, { type: 'thinking_level_changed', thinkingLevel: 'slow' });
    expect(s.thinkingLevel).toBe('slow');
  });

  it('handles UI request notifications', () => {
    const s = ompReducer(initialOmpState, { type: 'extension_ui_request', id: 'req-1', method: 'confirm', title: 'test', message: 'test' });
    expect(s.pendingApproval?.id).toBe('req-1');
  });
});
