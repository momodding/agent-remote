import type { Connection } from './connection';
import { base64, decodeBase64, text, utf8 } from './bytes';
import type { SessionSummary, WaitState } from '../protocol';

const wsURL = (endpoint: string, id: string) => `${endpoint.replace(/^http/, 'ws').replace(/\/$/, '')}/v1/ws/sessions/${encodeURIComponent(id)}`;

type SessionFrame =
  | { type: 'pty.output'; sessionId: string; data: string; seq: number }
  | { type: 'session.state'; sessionId: string; state: SessionSummary['state']; waitState?: WaitState }
  | { type: 'error'; code: string; message: string };

type InputFrame = { type: 'pty.input'; sessionId: string; data: string };
type ResizeFrame = { type: 'pty.resize'; sessionId: string; cols: number; rows: number };

export class SessionSocket {
  private socket?: WebSocket;
  private pendingInput: InputFrame[] = [];
  private pendingResize?: ResizeFrame;

  constructor(
    private readonly connection: Connection,
    private readonly sessionId: string,
    private readonly onOutput: (data: string) => void,
    private readonly onState: (state: SessionSummary['state'], waitState?: WaitState) => void,
    private readonly onError: (message: string) => void,
  ) {}

  connect(): void {
    this.close();
    this.pendingInput = [];
    this.pendingResize = undefined;
    const socket = new WebSocket(wsURL(this.connection.endpoint, this.sessionId));
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      socket.send(JSON.stringify({ type: 'auth.token', token: this.connection.token }));
      if (this.pendingResize) socket.send(JSON.stringify(this.pendingResize));
      for (const frame of this.pendingInput) socket.send(JSON.stringify(frame));
      this.pendingResize = undefined;
      this.pendingInput = [];
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.onError('Terminal connection lost');
    };
    socket.onmessage = ({ data }) => {
      if (this.socket !== socket) return;
      const frame = JSON.parse(String(data)) as SessionFrame;
      if (frame.type === 'pty.output') this.onOutput(text(decodeBase64(frame.data)));
      if (frame.type === 'session.state') this.onState(frame.state, frame.waitState);
      if (frame.type === 'error') this.onError(frame.message);
    };
  }

  input(data: string): void {
    this.send({ type: 'pty.input', sessionId: this.sessionId, data: base64(utf8(data)) });
  }

  resize(cols: number, rows: number): void {
    this.send({ type: 'pty.resize', sessionId: this.sessionId, cols, rows });
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
    this.pendingInput = [];
    this.pendingResize = undefined;
  }

  private send(frame: InputFrame | ResizeFrame): void {
    const socket = this.socket;
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    } else if (socket.readyState !== WebSocket.CONNECTING) {
      return;
    } else if (frame.type === 'pty.input') {
      this.pendingInput.push(frame);
    } else {
      this.pendingResize = frame;
    }
  }
}
