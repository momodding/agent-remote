export type DesktopCloseCategory =
  | 'target_dial_failed'
  | 'target_closed'
  | 'websocket_closed'
  | 'ticket_invalid'
  | 'ticket_expired'
  | 'protocol_failure'
  | 'security_negotiation_failed'
  | 'framebuffer_never_initialized'
  | 'client_closed';

export type DesktopStage =
  | 'rfb_creating'
  | 'rfb_connected'
  | 'rfb_disconnected_clean'
  | 'rfb_disconnected_unexpected'
  | 'rfb_security_failure'
  | 'rfb_load_failed'
  | 'window_error'
  | 'unhandled_rejection'
  | DesktopCloseCategory;

export const desktopCloseMessages: Record<DesktopCloseCategory, string> = {
  target_dial_failed: 'Could not reach the remote desktop server.',
  target_closed: 'The remote desktop server closed the connection.',
  websocket_closed: 'The secure remote-desktop connection closed.',
  ticket_invalid: 'Your desktop session authorization was invalid — reconnect.',
  ticket_expired: 'Your desktop session authorization expired — reconnect.',
  protocol_failure: 'The remote-desktop protocol failed. Retry the connection.',
  security_negotiation_failed: 'Desktop security negotiation failed',
  framebuffer_never_initialized: 'The remote desktop never finished starting.',
  client_closed: 'The remote desktop closed the connection.',
};

const desktopStageDetails: Record<DesktopStage, string | null> = {
  rfb_creating: 'Opening the secure remote-desktop connection.',
  rfb_connected: null,
  rfb_disconnected_clean: 'The remote desktop closed the connection.',
  rfb_disconnected_unexpected: 'The remote-desktop connection ended unexpectedly. Retry to request a fresh connection.',
  rfb_security_failure: 'Secure remote-desktop negotiation failed. Check the daemon and retry.',
  rfb_load_failed: 'The embedded remote-desktop client could not start. Retry the connection.',
  window_error: 'The remote-desktop view encountered an error. Retry the connection.',
  unhandled_rejection: 'The remote-desktop view encountered an error. Retry the connection.',
  target_dial_failed: desktopCloseMessages.target_dial_failed,
  target_closed: desktopCloseMessages.target_closed,
  websocket_closed: desktopCloseMessages.websocket_closed,
  ticket_invalid: desktopCloseMessages.ticket_invalid,
  ticket_expired: desktopCloseMessages.ticket_expired,
  protocol_failure: desktopCloseMessages.protocol_failure,
  security_negotiation_failed: 'Secure remote-desktop negotiation failed. Check the daemon and retry.',
  framebuffer_never_initialized: desktopCloseMessages.framebuffer_never_initialized,
  client_closed: desktopCloseMessages.client_closed,
};

export function desktopStageDetail(stage: unknown): string | null | undefined {
  if (typeof stage !== 'string' || !(stage in desktopStageDetails)) return undefined;
  return desktopStageDetails[stage as DesktopStage];
}

export function desktopDisconnectStatus(clean: boolean, connected: boolean, closeReason: unknown): { message: string; stage: DesktopStage } {
  if (clean) return { message: 'Desktop disconnected', stage: 'rfb_disconnected_clean' };
  if (typeof closeReason === 'string' && closeReason in desktopCloseMessages) {
    const stage = closeReason as DesktopCloseCategory;
    return { message: desktopCloseMessages[stage], stage };
  }
  if (!connected) return { message: desktopCloseMessages.framebuffer_never_initialized, stage: 'framebuffer_never_initialized' };
  return { message: 'Desktop disconnected unexpectedly', stage: 'rfb_disconnected_unexpected' };
}
