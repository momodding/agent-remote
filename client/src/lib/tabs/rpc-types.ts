/**
 * Simplified mirror of OMP RPC types needed for initial Tab Deck routing and stubbing.
 *
 * Deliberately does not import from `@oh-my-pi/pi-coding-agent` at runtime: that package
 * is a global CLI install, not a client dependency, and Expo must not depend on it.
 * Phase 1 ships mock adapters against this mirror; a later phase widens it as real
 * `omp --mode=rpc` integration lands (see plans/tab-deck-architecture.md).
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned' | 'blocked';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  blocker?: string;
}

export interface TodoPhase {
  name: string;
  tasks: TodoItem[];
}

export interface RpcSessionState {
  thinkingLevel: 'auto' | 'none' | 'slow' | undefined;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: 'all' | 'one-at-a-time';
  followUpMode: 'all' | 'one-at-a-time';
  interruptMode: 'immediate' | 'wait';
  sessionId: string;
  sessionName?: string;
  todoPhases: TodoPhase[];
}

export type RpcExtensionUIRequest =
  | { type: 'extension_ui_request'; id: string; method: 'select'; title: string; options: string[]; timeout?: number }
  | { type: 'extension_ui_request'; id: string; method: 'confirm'; title: string; message: string; timeout?: number }
  | { type: 'extension_ui_request'; id: string; method: 'input'; title: string; placeholder?: string; timeout?: number }
  | { type: 'extension_ui_request'; id: string; method: 'editor'; title: string; prefill?: string; promptStyle?: boolean }
  | { type: 'extension_ui_request'; id: string; method: 'cancel'; targetId: string }
  | { type: 'extension_ui_request'; id: string; method: 'notify'; message: string; notifyType?: 'info' | 'warning' | 'error' };

export type RpcExtensionUIResponse =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true; timedOut?: boolean };

export type RpcCommand =
  | { id?: string; type: 'prompt'; message: string }
  | { id?: string; type: 'steer'; message: string }
  | { id?: string; type: 'abort' }
  | { id?: string; type: 'get_state' }
  | { id?: string; type: 'set_thinking_level'; level: RpcSessionState['thinkingLevel'] }
  | { id?: string; type: 'set_model'; provider: string; modelId: string }
  | RpcExtensionUIResponse;

export type RpcResponse =
  | { id?: string; type: 'response'; command: 'get_state'; success: true; data: RpcSessionState }
  | { id?: string; type: 'response'; command: string; success: true; data?: unknown }
  | { id?: string; type: 'response'; command: string; success: false; error: string; code?: string };

/** Mirror of the core `AgentEvent` union (message/tool/turn lifecycle). */
export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: unknown[] }
  | { type: 'turn_start' }
  | { type: 'turn_end' }
  | { type: 'message_start'; message: AgentChatMessage }
  | { type: 'message_update'; message: AgentChatMessage }
  | { type: 'message_end'; message: AgentChatMessage }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown; intent?: string }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError?: boolean };

/** Session-specific extras layered on top of the core `AgentEvent` union. */
export type AgentSessionEvent =
  | AgentEvent
  | { type: 'todo_reminder'; todos: TodoItem[]; attempt: number; maxAttempts: number }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string; source?: string }
  | { type: 'thinking_level_changed'; thinkingLevel: RpcSessionState['thinkingLevel'] }
  | { type: 'goal_updated'; goal: unknown }
  | RpcExtensionUIRequest;

export interface AgentChatMessage {
  role: 'user' | 'assistant' | 'toolResult' | 'developer';
  content: string;
  timestamp?: number;
}
