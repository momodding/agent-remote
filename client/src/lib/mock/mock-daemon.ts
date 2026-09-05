/**
 * In-process backend simulations, one per open channel, driving the mock
 * `DaemonChannel` (`mock-channel.ts`) until a real `/v1/ws/gateway` daemon
 * ships. Each class reacts to inbound `ChannelEnvelope`s narrowed by
 * `.type` and emits frames back through the callback it was built with.
 */
import { base64, decodeBase64, utf8 } from '../bytes';
import type { ChannelEnvelope, ChannelFramePayload } from '../daemon-channel';

export type Emit = (payload: ChannelFramePayload) => void;

/** Echoes typed input back as output; never a real shell. */
export class MockPty {
  private seq = 0;

  constructor(private readonly emit: Emit) {
    this.emit({ type: 'pty.output', data: base64(utf8('mock$ ')), seq: this.seq++ });
  }

  handle(envelope: ChannelEnvelope): void {
    if (envelope.type !== 'pty.input') return;
    const text = new TextDecoder().decode(decodeBase64(envelope.data));
    const echo = text.includes('\r') || text.includes('\n') ? `${text}\r\nmock$ ` : text;
    this.emit({ type: 'pty.output', data: base64(utf8(echo)), seq: this.seq++ });
  }
}

/** Replies to every OMP RPC command with a canned success/turn cycle. */
export class MockAgentSession {
  private thinkingLevel: 'auto' | 'none' | 'slow' | undefined = 'auto';

  constructor(private readonly emit: Emit) {}

  handle(envelope: ChannelEnvelope): void {
    switch (envelope.type) {
      case 'get_state':
        this.emit({
          id: envelope.id,
          type: 'response',
          command: 'get_state',
          success: true,
          data: {
            thinkingLevel: this.thinkingLevel,
            isStreaming: false,
            isCompacting: false,
            steeringMode: 'all',
            followUpMode: 'all',
            interruptMode: 'immediate',
            sessionId: 'mock-session',
            sessionName: 'Mock Agent',
            todoPhases: [],
          },
        });
        return;
      case 'prompt':
      case 'steer':
        this.runTurn(envelope.id, envelope.message);
        return;
      case 'abort':
        this.emit({ id: envelope.id, type: 'response', command: 'abort', success: true });
        return;
      case 'set_thinking_level':
        this.thinkingLevel = envelope.level;
        this.emit({ type: 'thinking_level_changed', thinkingLevel: envelope.level });
        this.emit({ id: envelope.id, type: 'response', command: 'set_thinking_level', success: true });
        return;
      case 'set_model':
        this.emit({ id: envelope.id, type: 'response', command: 'set_model', success: true });
        return;
      default:
        return; // extension_ui_response, server-origin frames: nothing to mock yet.
    }
  }

  private runTurn(id: string | undefined, message: string): void {
    this.emit({ type: 'agent_start' });
    this.emit({ type: 'turn_start' });
    const reply = { role: 'assistant' as const, content: `Mock reply to: ${message}`, timestamp: Date.now() };
    this.emit({ type: 'message_start', message: reply });
    this.emit({ type: 'message_end', message: reply });
    this.emit({ type: 'turn_end' });
    this.emit({ type: 'agent_end', messages: [reply] });
    this.emit({ id, type: 'response', command: 'prompt', success: true });
  }
}

/** Acks an initial framebuffer size; no pixel simulation until VNC gateway lands. */
export class MockDesktop {
  constructor(private readonly emit: Emit) {
    this.emit({ type: 'vnc.resize', width: 1024, height: 768 });
  }

  // ponytail: mock desktop never echoes vnc.data; wire real frames when /v1/ws/gateway ships.
  handle(_envelope: ChannelEnvelope): void {}
}
