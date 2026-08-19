import type { SessionSocket } from './session-socket';

export const MAX_MULTI_SESSIONS = 5;

// Slot 0 is the primary pane; the remaining entries are auxiliary split panes.
export type SplitLayout = Array<string | null>;

export type MultiSessionState = {
  sessionId: string;
  name: string;
  connectionEndpoint: string;
  output: string;
  socket?: SessionSocket;
};

export function auxSlotCount(isWeb: boolean): number {
  return isWeb ? 4 : 2;
}

export function placeInSplit(layout: SplitLayout, sessionId: string, index: number): SplitLayout {
  if (layout[index] === sessionId) return layout;
  const next = [...layout];
  const currentIndex = layout.indexOf(sessionId);
  if (currentIndex >= 0) next[currentIndex] = next[index];
  next[index] = sessionId;
  return next;
}

export function reconcileSplit(layout: SplitLayout, orderedSessionIds: string[], slotCount: number): SplitLayout {
  const seen = new Set<string>();
  const occupied: string[] = [];
  for (const id of layout) {
    if (id && orderedSessionIds.includes(id) && !seen.has(id)) {
      seen.add(id);
      occupied.push(id);
    }
  }
  const next: SplitLayout = occupied.slice(0, slotCount);
  while (next.length < slotCount) next.push(null);
  if (!next[0]) {
    const fallback = orderedSessionIds.find((id) => !seen.has(id));
    if (fallback) next[0] = fallback;
  }
  return next;
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
