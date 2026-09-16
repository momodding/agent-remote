import { AgenticRemoteAPI } from '../lib/api';
import type { Connection } from '../lib/connection';

describe('Agent Lifecycle Tests (RAR-036/RAR-037)', () => {
  let api: AgenticRemoteAPI;
  const mockConnection: Pick<Connection, 'endpoint' | 'token'> = {
    endpoint: 'http://localhost:8080',
    token: 'test-token',
  };

  beforeEach(() => {
    api = new AgenticRemoteAPI(mockConnection);
  });

  describe('terminateAgent endpoint', () => {
    it('should have terminateAgent method', () => {
      expect(typeof api.terminateAgent).toBe('function');
    });

    it('should call /v1/agents/{id}/terminate POST', async () => {
      const agentId = 'agent-test-1';
      const mockFetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
          text: async () => JSON.stringify({ ok: true }),
        } as Response)
      );
      Object.defineProperty(globalThis, 'fetch', { value: mockFetch, writable: true, configurable: true });

      await api.terminateAgent(agentId);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/v1/agents/${agentId}/terminate`),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should throw APIError on failure', async () => {
      const mockFetch = jest.fn(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          json: async () => ({ error: 'agent not found', message: 'agent not found' }),
          text: async () => JSON.stringify({ error: 'agent not found' }),
        } as Response)
      );
      Object.defineProperty(globalThis, 'fetch', { value: mockFetch, writable: true, configurable: true });

      await expect(api.terminateAgent('nonexistent')).rejects.toThrow();
    });

    it('should handle URL encoding in agent ID', async () => {
      const agentId = 'agent/with/slashes';
      const mockFetch = jest.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
          text: async () => JSON.stringify({ ok: true }),
        } as Response)
      );
      Object.defineProperty(globalThis, 'fetch', { value: mockFetch, writable: true, configurable: true });

      await api.terminateAgent(agentId);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(encodeURIComponent(agentId)),
        expect.anything()
      );
    });
  });

  describe('Lifecycle state contracts', () => {
    it('terminateAgent should be distinct from closeSession', () => {
      expect(api.terminateAgent).not.toEqual(api.closeSession);
    });

    it('should have consistent agent lifecycle API surface', () => {
      expect(typeof api.agents).toBe('function');
      expect(typeof api.agent).toBe('function');
      expect(typeof api.createAgent).toBe('function');
      expect(typeof api.abortAgent).toBe('function');
      expect(typeof api.terminateAgent).toBe('function');
    });
  });
  describe('Workspace CWD contracts (RAR-039)', () => {
    it('createAgent passes relative cwd and backend in payload', async () => {
      const mockFetch = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            id: 'agent-123',
            adapter: 'omp',
            terminalSessionId: 'term-123',
            cwd: body.cwd || '',
            state: 'idle',
            capabilities: [],
            createdAt: 1000,
            updatedAt: 1000,
          }),
          text: async () => '',
        } as Response);
      });
      Object.defineProperty(globalThis, 'fetch', { value: mockFetch, writable: true, configurable: true });

      const agent = await api.createAgent({ cwd: 'src/lib', backend: 'tmux' });
      expect(agent.cwd).toBe('src/lib');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/agents'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ cwd: 'src/lib', backend: 'tmux' }),
        })
      );
    });
  });
});
