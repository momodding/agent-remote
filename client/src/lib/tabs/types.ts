import type { WaitState } from '../../protocol';
import type { RpcExtensionUIRequest, RpcSessionState } from './rpc-types';

export type DaemonId = string; // = Connection.hostId, existing identity

export type TabKind = 'agent' | 'terminal' | 'files' | 'desktop';

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
}

export interface AgentWorkspaceTab extends BaseTab {
  kind: 'agent';
  remoteSessionId: string; // OMP rpc process handle on the daemon
  adapter: 'omp'; // widen when a 2nd adapter ships
  sessionState: RpcSessionState | null; // last get_state snapshot
  pendingApproval: RpcExtensionUIRequest | null;
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

export type WorkspaceTab = TerminalWorkspaceTab | AgentWorkspaceTab | FilesWorkspaceTab | DesktopWorkspaceTab;

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
