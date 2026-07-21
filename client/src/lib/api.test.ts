import { apiURL, wsURL } from './api';

describe('transport URLs', () => {
  it('preserves endpoint paths and upgrades only the WebSocket scheme', () => {
    expect(apiURL('https://daemon.example/', '/v1/sessions')).toBe('https://daemon.example/v1/sessions');
    expect(wsURL('https://daemon.example/', '/v1/ws/sessions/bootstrap')).toBe('wss://daemon.example/v1/ws/sessions/bootstrap');
    expect(wsURL('http://127.0.0.1:8765', '/v1/ws/sessions/id')).toBe('ws://127.0.0.1:8765/v1/ws/sessions/id');
  });
});
