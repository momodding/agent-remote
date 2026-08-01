import { Platform } from 'react-native';
import type { SessionSocket } from './session-socket';

export type MultiSessionState = {
  sessionId: string;
  name: string;
  connectionEndpoint: string;
  output: string;
  minimized: boolean;
  socket?: SessionSocket;
};

export function getPlatformMax(): number {
  return Platform.OS === 'web' ? 4 : 2;
}

export function addSession(
  sessions: Record<string, MultiSessionState>,
  session: MultiSessionState
): Record<string, MultiSessionState> {
  return { ...sessions, [session.sessionId]: session };
}

export function closeSession(
  sessions: Record<string, MultiSessionState>,
  sessionId: string
): Record<string, MultiSessionState> {
  const { [sessionId]: _, ...rest } = sessions;
  return rest;
}

export function toggleMinimize(
  sessions: Record<string, MultiSessionState>,
  sessionId: string
): Record<string, MultiSessionState> {
  const session = sessions[sessionId];
  if (!session) return sessions;
  return { ...sessions, [sessionId]: { ...session, minimized: !session.minimized } };
}

export function updateOutput(
  sessions: Record<string, MultiSessionState>,
  sessionId: string,
  output: string
): Record<string, MultiSessionState> {
  const session = sessions[sessionId];
  if (!session) return sessions;
  return { ...sessions, [sessionId]: { ...session, output } };
}
