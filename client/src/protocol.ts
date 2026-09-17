export type PairingPayload = {
  v: number;
  endpoint: string;
  fingerprint: string;
  skipFingerprintVerification?: boolean;
  pairingId: string;
  token: string;
  expiresAt: string;
};

export type WaitState = {
  kind: string;
  label: string;
  confidence: number;
  matched: string;
};

export type SessionSummary = {
  id: string;
  name: string;
  command: string;
  cwd: string;
  state: 'running' | 'exited' | 'waiting' | 'idle';
  createdAt: string;
  updatedAt: string;
  preview: string[];
  waitState?: WaitState;
};

export type AgentModelInfo = {
  id: string;
  name: string;
  provider: string;
};

export type AgentCapability = { name: string; enabled: boolean };

export type AgentSession = {
  id: string;
  adapter: string;
  terminalSessionId: string;
  cwd: string;
  state: 'working' | 'idle' | 'needsYou' | 'exited';
  capabilities: AgentCapability[];
  model?: AgentModelInfo;
  thinking?: string;
  availableModels?: AgentModelInfo[];
  availableThinking?: string[];
  createdAt: string;
  updatedAt: string;
};
export type AgentEvent = {
  type: string;
  cursor?: number;
  eventId?: string;
  agentId: string;
  messageId?: string;
  toolCallId?: string;
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  state?: string;
  capabilities?: AgentCapability[];
  model?: AgentModelInfo;
  thinking?: string;
  availableModels?: AgentModelInfo[];
  availableThinking?: string[];
  isError?: boolean;
};

export type AgentHistoryResponse = {
  cursor: number;
  events: AgentEvent[];
};
export type RuntimeLifecycleEvent = {
  cursor?: number;
  surfaceId: string;
  type: string;
  payload: unknown;
};

export type TmuxPane = {
  terminalSessionId: string;
  serverId: string;
  sessionId: string;
  windowId: string;
  paneId: string;
  sessionName: string;
  windowName: string;
  windowIndex: number;
  paneIndex: number;
  cwd: string;
  active: boolean;
};

export type RuntimeSnapshot = {
  cursor: number;
  terminals: Array<{ id: string; name: string; cwd: string; seq: number; exited: boolean }>;
  agents: AgentSession[];
  topology: TmuxPane[];
  desktops: unknown[];
};

export type ChannelOpenEnvelope = {
  type: 'channel.open'; requestId: string; channelId: string; kind: string; targetId: string; after?: number;
};
export type ChannelCloseEnvelope = { type: 'channel.close'; channelId: string };
export type CommandEnvelope = { type: 'command'; requestId: string; targetId: string; command: string; args?: unknown };
export type ChannelOpenedEnvelope = { type: 'channel.opened'; requestId: string; channelId: string; cursor: number };
export type RuntimeEventEnvelope = { type: 'event'; channelId: string; cursor: number; event: unknown };
export type CommandResultEnvelope = { type: 'command.result'; requestId: string; ok: boolean; result?: unknown; error?: string };
export type ChannelClosedEnvelope = { type: 'channel.closed'; channelId: string; reason: string };
export type HostIdentity = {
  hostId: string;
  connectionId: string;
  sessionId: string;
};

export type Capability = {
  name: string;
  enabled: boolean;
};

export type CapabilitiesResponse = {
  capabilities: Capability[];
};

export type DaemonCapabilities = {
  identity: HostIdentity;
  capabilities: Capability[];
};


export type CreateSessionRequest = {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  backend?: string;
};

export type FileEntry = {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  mode: string;
  gitCode?: string;
};

export type ReadFileResponse = { path: string; sha256: string; text: string };
export type ListFilesResponse = {
  entries: FileEntry[];
};

export type RenameFileRequest = { path: string; newPath: string };
export type CopyFileRequest = { path: string; newPath: string };

export type GitEntry = {
  code: string;
  path: string;
};

export type GitStatus = {
  available: boolean;
  entries: GitEntry[];
};

export type GitStatusResponse = {
  available: boolean;
  entries: GitEntry[];
};

export type ListShellsResponse = { shells: string[] };
export type NotifyRegisterRequest = {
  provider: string;
  token: string;
};

export type ErrorEnvelope = { type: 'error'; code: string; message: string };

export type DesktopSessionResponse = {
  ticket: string;
  wsUrl: string;
  expiresAt: string;
};

export type PTYInputEnvelope = {
  type: 'pty.input';
  sessionId: string;
  data: string;
};

export type PTYOutputEnvelope = {
  type: 'pty.output';
  sessionId: string;
  data: string;
  seq: number;
};

export type PTYResizeEnvelope = {
  type: 'pty.resize';
  sessionId: string;
  cols: number;
  rows: number;
};

export type SessionStateEnvelope = {
  type: 'session.state';
  sessionId: string;
  state: string;
  waitState?: WaitState;
};
