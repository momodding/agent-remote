// ponytail: Reducer mapping OMP RPC events to render state.
import type { AgentSessionEvent, RpcExtensionUIRequest, RpcSessionState, TodoPhase } from '../tabs/rpc-types';

export interface ToolCallState {
  id: string;
  name: string;
  args: unknown;
  intent?: string;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  done: boolean;
}

export interface TurnState {
  id: string;
  role: 'user' | 'assistant' | 'developer';
  content: string;
  toolCalls: ToolCallState[];
}

export interface OmpAdapterState {
  turns: TurnState[];
  todos: TodoPhase[];
  thinkingLevel: RpcSessionState['thinkingLevel'];
  pendingApproval: RpcExtensionUIRequest | null;
  activeTurnId: string | null; // which turn are we currently streaming into
}

export const initialOmpState: OmpAdapterState = {
  turns: [],
  todos: [],
  thinkingLevel: 'auto',
  pendingApproval: null,
  activeTurnId: null,
};

function ensureActiveTurn(state: OmpAdapterState): TurnState {
  if (state.activeTurnId) {
    const existing = state.turns.find(t => t.id === state.activeTurnId);
    if (existing) return existing;
  }
  const id = `turn-${Date.now()}-${Math.random()}`;
  const turn: TurnState = { id, role: 'assistant', content: '', toolCalls: [] };
  state.turns.push(turn);
  state.activeTurnId = id;
  return turn;
}

export function ompReducer(state: OmpAdapterState, event: AgentSessionEvent): OmpAdapterState {
  // ponytail: we mutate a clone to avoid Immer dependency, this app prefers plain React state
  const next = JSON.parse(JSON.stringify(state)) as OmpAdapterState;

  switch (event.type) {
    case 'turn_start':
      next.activeTurnId = `turn-${Date.now()}`;
      next.turns.push({ id: next.activeTurnId, role: 'assistant', content: '', toolCalls: [] });
      break;
    case 'turn_end':
      next.activeTurnId = null;
      break;
    case 'message_start':
    case 'message_update':
    case 'message_end': {
      if (event.message.role === 'toolResult') break; // handled in tool_execution_end
      const active = ensureActiveTurn(next);
      active.role = event.message.role;
      active.content = event.message.content;
      break;
    }
    case 'tool_execution_start': {
      const active = ensureActiveTurn(next);
      active.toolCalls.push({
        id: event.toolCallId, name: event.toolName, args: event.args, intent: event.intent, done: false
      });
      break;
    }
    case 'tool_execution_update': {
      const active = ensureActiveTurn(next);
      const call = active.toolCalls.find(c => c.id === event.toolCallId);
      if (call) {
        call.args = event.args;
        call.partialResult = event.partialResult;
      }
      break;
    }
    case 'tool_execution_end': {
      // Find the turn that has this tool call, since turns might have cycled
      let call: ToolCallState | undefined;
      for (let i = next.turns.length - 1; i >= 0; i--) {
        call = next.turns[i].toolCalls.find(c => c.id === event.toolCallId);
        if (call) break;
      }
      if (call) {
        call.result = event.result;
        call.isError = event.isError;
        call.done = true;
      }
      break;
    }
    case 'thinking_level_changed':
      next.thinkingLevel = event.thinkingLevel;
      break;
    case 'extension_ui_request':
      next.pendingApproval = event;
      break;
    case 'todo_reminder':
      // The event only provides the current list, we just override it. We assume single phase "Current" if needed.
      // OMP core has a richer set_todos action, but we only have todo_reminder in this mirror.
      if (event.todos.length > 0) {
        next.todos = [{ name: 'Current', tasks: event.todos }];
      }
      break;
  }
  return next;
}
