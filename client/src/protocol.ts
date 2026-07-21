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
  state: 'running' | 'finished';
  createdAt: string;
  updatedAt: string;
  preview: string[];
  waitState?: WaitState;
};

export type CreateSessionRequest = {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
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

export type GitStatus = {
  available: boolean;
  entries: Array<{ code: string; path: string }>;
};

export type ErrorEnvelope = { type: 'error'; code: string; message: string };
