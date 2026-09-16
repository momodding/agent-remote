import type { WaitState } from '../../protocol';

export type DaemonId = string; // = Connection.hostId, existing identity

export type TabKind = 'terminal' | 'files' | 'desktop' | 'agent';

interface BaseTab {
  tabId: string; // stable local id, independent of remoteSessionId
  daemonId: DaemonId;
  kind: TabKind;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  pinned: boolean;
}

export interface TerminalWorkspaceTab extends BaseTab {
  kind: 'terminal';
  remoteSessionId: string; // maps to backend Session.ID
  state: 'connecting' | 'running' | 'waiting' | 'exited' | 'detached';
  waitState?: WaitState;
  tmuxPaneId?: string;
}


export interface FilesWorkspaceTab extends BaseTab {
  kind: 'files';
  cwd: string; // no remoteSessionId: files is stateless REST
}

export interface DesktopWorkspaceTab extends BaseTab {
  kind: 'desktop';
  remoteSessionId: string; // VNC channel id once multiplexed
  state: 'connecting' | 'connected' | 'disconnected';
}

export interface AgentWorkspaceTab extends BaseTab {
  kind: 'agent';
  agentSessionId: string; // AgentSession.id
  terminalSessionId: string; // shared underlying Session.ID for terminal fallback
  state: 'working' | 'idle' | 'needsYou' | 'exited';
  view: 'chat' | 'terminal'; // which surface is focused for this tab
  tmuxPaneId?: string;
  cwd?: string;
}

export type WorkspaceTab = TerminalWorkspaceTab | FilesWorkspaceTab | DesktopWorkspaceTab | AgentWorkspaceTab;

export type SplitLayout = {
  direction?: 'horizontal' | 'vertical';
  first?: SplitLayout;
  second?: SplitLayout;
  weight?: number;
  id?: string;
};

export interface TabDeckState {
  tabs: WorkspaceTab[];
  activeId: string | null;
  layout: SplitLayout;
}
