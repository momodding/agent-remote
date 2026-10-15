import { AgenticRemoteAPI, APIError } from '../lib/api';
import type { Connection } from '../lib/connection';

describe('MANUAL-004: Agent Termination Lifecycle Semantics', () => {
  const mockConnection: Pick<Connection, 'endpoint' | 'token'> = {
    endpoint: 'http://localhost:8080',
    token: 'test-token',
  };

  let api: AgenticRemoteAPI;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn();
    Object.defineProperty(globalThis, 'fetch', {
      value: mockFetch,
      writable: true,
      configurable: true,
    });
    api = new AgenticRemoteAPI(mockConnection);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Semantic Boundary: Terminate vs Abort vs Close', () => {
    it('should expose three distinct agent lifecycle methods', () => {
      expect(typeof api.terminateAgent).toBe('function');
      expect(typeof api.abortAgent).toBe('function');
      expect(typeof api.closeSession).toBe('function');
      expect(api.terminateAgent).not.toBe(api.abortAgent);
      expect(api.terminateAgent).not.toBe(api.closeSession);
      expect(api.abortAgent).not.toBe(api.closeSession);
    });

    it('terminateAgent should invoke POST /v1/agents/{id}/terminate', async () => {
      const agentId = 'agent-123';
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 204, statusText: 'No Content' })
      );

      await api.terminateAgent(agentId);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/v1/agents/${agentId}/terminate`),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('abortAgent should invoke POST /v1/agents/{id}/abort', async () => {
      const agentId = 'agent-123';
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 204, statusText: 'No Content' })
      );

      await api.abortAgent(agentId);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/v1/agents/${agentId}/abort`),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('closeSession should invoke POST /v1/sessions/{id}/close', async () => {
      const sessionId = 'session-456';
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 204, statusText: 'No Content' })
      );

      await api.closeSession(sessionId);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`/v1/sessions/${sessionId}/close`),
        expect.not.stringContaining('/terminate')
      );
    });
  });

  describe('Remote Process Death Contract (MANUAL-004.001)', () => {
    it('should return successfully when terminate POST returns 204', async () => {
      const agentId = 'agent-789';
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 204, statusText: 'No Content' })
      );

      const result = await api.terminateAgent(agentId);
      expect(result).toBeUndefined();
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should reject with APIError when terminate POST returns 500', async () => {
      const agentId = 'agent-789';
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Internal Server Error' }), {
          status: 500,
          statusText: 'Internal Server Error',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      await expect(api.terminateAgent(agentId)).rejects.toThrow();
    });

    it('should reject with APIError when terminate POST returns 404', async () => {
      const agentId = 'nonexistent-agent';
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Not Found' }), {
          status: 404,
          statusText: 'Not Found',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      await expect(api.terminateAgent(agentId)).rejects.toThrow();
    });
  });

  describe('URL Encoding Safety (MANUAL-004.005)', () => {
    it('should properly encode agent IDs with special characters', async () => {
      const agentId = 'agent/with:special?chars=123';
      const encodedId = encodeURIComponent(agentId);
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 204, statusText: 'No Content' })
      );

      await api.terminateAgent(agentId);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(encodedId),
        expect.any(Object)
      );
    });
  });

  describe('Close-View vs Terminate Invariant (MANUAL-004.004)', () => {
    it('close-view must not invoke terminateAgent endpoint', async () => {
      const sessionId = 'session-xyz';
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 204, statusText: 'No Content' })
      );

      await api.closeSession(sessionId);

      expect(mockFetch).not.toHaveBeenCalledWith(
        expect.stringContaining('/v1/agents/'),
        expect.anything()
      );
    });
  });
});
