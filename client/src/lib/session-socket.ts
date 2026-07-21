import type { Connection } from './connection';
import { base64, decodeBase64, text, utf8 } from './bytes';
import type { WaitState } from '../protocol';

const wsURL = (endpoint: string, id: string) => `${endpoint.replace(/^http/, 'ws').replace(/\/$/, '')}/v1/ws/sessions/${encodeURIComponent(id)}`;

type SessionFrame =
  | { type: 'pty.output'; sessionId: string; data: string; seq: number }
  | { type: 'session.state'; sessionId: string; state: 'running' | 'finished'; waitState?: WaitState }
  | { type: 'error'; code: string; message: string };

export class SessionSocket {
  private socket?: WebSocket;

  constructor(
    private readonly connection: Connection,
    private readonly sessionId: string,
    private readonly onOutput: (data: string) => void,
    private readonly onState: (state: 'running' | 'finished', waitState?: WaitState) => void,
    private readonly onError: (message: string) => void,
  ) {}

  connect(): void {
    this.close();
    const socket = new WebSocket(wsURL(this.connection.endpoint, this.sessionId));
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth.token', token: this.connection.token }));
    socket.onerror = () => this.onError('Terminal connection lost');
    socket.onmessage = ({ data }) => {
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
  }

  private send(frame: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }
}
