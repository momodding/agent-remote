import type { SessionSocket } from './session-socket';

export const MAX_MULTI_SESSIONS = 5;

export type SplitSide = 'left' | 'right';

export type SplitLayout = { left: string | null; right: string | null };

export type MultiSessionState = {
  sessionId: string;
  name: string;
  connectionEndpoint: string;
  output: string;
  socket?: SessionSocket;
};

export function placeInSplit(layout: SplitLayout, sessionId: string, side: SplitSide): SplitLayout {
  if (layout[side] === sessionId) return layout;
  const currentSide = layout.left === sessionId ? 'left' : layout.right === sessionId ? 'right' : null;
  if (currentSide) return { ...layout, [side]: sessionId, [currentSide]: layout[side] };
  if (!layout.left || !layout.right) return side === 'left'
    ? { left: sessionId, right: layout.left ?? layout.right }
    : { left: layout.left ?? layout.right, right: sessionId };
  return { ...layout, [side]: sessionId };
}

export function reconcileSplit(layout: SplitLayout, orderedSessionIds: string[]): SplitLayout {
  const left = layout.left && orderedSessionIds.includes(layout.left) ? layout.left : null;
  const right = layout.right && orderedSessionIds.includes(layout.right) ? layout.right : null;
  if (left) return { left, right };
  if (right) return { left: right, right: null };
  return { left: orderedSessionIds[0] ?? null, right: null };
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


export function updateOutput(
  sessions: Record<string, MultiSessionState>,
  sessionId: string,
  output: string
): Record<string, MultiSessionState> {
  const session = sessions[sessionId];
  if (!session) return sessions;
  return { ...sessions, [sessionId]: { ...session, output } };
}
