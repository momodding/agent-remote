import type { Connection, ConnectionStore } from './connection';

type ConnectionModule = typeof import('./connection');

let mockPlatform = 'web';
let stored: string | null = null;

const mockSecureStore = {
  getItemAsync: jest.fn<Promise<string | null>, [string]>(),
  setItemAsync: jest.fn<Promise<void>, [string, string]>(),
  deleteItemAsync: jest.fn<Promise<void>, [string]>(),
};
const mockAsyncStorage = {
  getItem: jest.fn<Promise<string | null>, [string]>(),
  setItem: jest.fn<Promise<void>, [string, string]>(),
  removeItem: jest.fn<Promise<void>, [string]>(),
};

jest.mock('react-native', () => ({ Platform: { get OS() { return mockPlatform; } } }));
jest.mock('expo-secure-store', () => mockSecureStore);
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: mockAsyncStorage }));

const first: Connection = {
  name: 'Primary daemon', endpoint: 'https://daemon.example:8765', hostId: 'daemon-8765',
  fingerprint: 'sha256:first', skipFingerprintVerification: true, token: 'first-token', clientName: 'test-client',
};
const second: Connection = {
  name: 'Backup daemon', endpoint: 'https://127.0.0.1:8766', hostId: 'backup-8766',
  fingerprint: '', skipFingerprintVerification: false, token: 'second-token', clientName: 'test-client',
};
const empty: ConnectionStore = { connections: [] };
const loadModule = (): ConnectionModule => require('./connection') as ConnectionModule;

beforeEach(() => {
  jest.clearAllMocks(); mockPlatform = 'web'; stored = null;
  mockAsyncStorage.getItem.mockImplementation(async () => stored);
  mockAsyncStorage.setItem.mockImplementation(async (_key, value) => { stored = value; });
  mockAsyncStorage.removeItem.mockImplementation(async () => { stored = null; });
  mockSecureStore.getItemAsync.mockImplementation(async () => stored);
  mockSecureStore.setItemAsync.mockImplementation(async (_key, value) => { stored = value; });
  mockSecureStore.deleteItemAsync.mockImplementation(async () => { stored = null; });
});

describe('connection storage', () => {
  it.each(['web', 'ios'])('round-trips a store on %s', async (platform) => {
    mockPlatform = platform;
    const { loadConnections, saveConnection } = loadModule();
    await expect(saveConnection(first)).resolves.toEqual({ connections: [first] });
    await expect(loadConnections()).resolves.toEqual({ connections: [first] });
    if (platform === 'web') expect(mockAsyncStorage.getItem).toHaveBeenCalledTimes(2);
    else expect(mockSecureStore.getItemAsync).toHaveBeenCalledTimes(2);
  });

  it('migrates the legacy single connection and derives its name', async () => {
    const legacy = { ...first, hostId: 'legacy-host' } as Partial<Connection>; delete legacy.name; stored = JSON.stringify(legacy);
    const { loadConnections } = loadModule();
    const expected = { connections: [{ ...first, hostId: 'legacy-host', name: 'daemon.example:8765' }] };
    await expect(loadConnections()).resolves.toEqual(expected); expect(stored).toBe(JSON.stringify(expected));
  });

  it('upserts a normalized endpoint with one write', async () => {
    stored = JSON.stringify({ connections: [first] });
    const replacement = { ...first, endpoint: `${first.endpoint}/`, token: 'refreshed' };
    const { saveConnection } = loadModule();
    await expect(saveConnection(replacement)).resolves.toEqual({ connections: [{ ...replacement, endpoint: first.endpoint }] });
    expect(mockAsyncStorage.setItem).toHaveBeenCalledTimes(1);
  });

  it('updates every field of an existing connection', async () => {
    stored = JSON.stringify({ connections: [first] });
    await expect(loadModule().updateConnection(first.hostId, second)).resolves.toEqual({ connections: [second] });
  });

  it('rejects changing a connection to an owned hostId', async () => {
    stored = JSON.stringify({ connections: [first, second] });
    await expect(loadModule().updateConnection(first.hostId, { ...first, hostId: second.hostId })).rejects.toThrow('already exists');
  });

  it('deletes a connection while leaving the others untouched', async () => {
    stored = JSON.stringify({ connections: [first, second] });
    await expect(loadModule().deleteConnection(second.hostId)).resolves.toEqual({ connections: [first] });
  });

  it('returns an empty store after deleting the last connection', async () => {
    stored = JSON.stringify({ connections: [first] });
    await expect(loadModule().deleteConnection(first.hostId)).resolves.toEqual(empty);
  });

  it('drops a legacy selectedHostId field from persisted storage on load', async () => {
    stored = JSON.stringify({ connections: [first], selectedHostId: first.hostId });
    await expect(loadModule().loadConnections()).resolves.toEqual({ connections: [first] });
    expect(mockAsyncStorage.setItem).toHaveBeenCalledTimes(1);
  });

  it.each(['{malformed', JSON.stringify({ connections: [{}] })])('removes malformed storage', async (value) => {
    stored = value; await expect(loadModule().loadConnections()).resolves.toEqual(empty);
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith('agenticremote.connection');
  });

  it.each([
    [{ ...first, endpoint: 'http://daemon.example' }, 'must use https'],
    [{ ...first, endpoint: 'https://user:pass@daemon.example' }, 'credentials'],
    [{ ...first, endpoint: 'https://daemon.example/path' }, 'path'],
    [{ ...first, name: ' ' }, 'Name'], [{ ...first, name: 'x'.repeat(65) }, 'Name'],
    [{ ...first, clientName: '' }, 'Client name'], [{ ...first, token: ' ' }, 'Session token'],
    [{ ...first, fingerprint: 1 as unknown as string }, 'Fingerprint'],
    [{ ...first, skipFingerprintVerification: undefined as unknown as boolean }, 'boolean'],
  ])('rejects invalid connections', async (connection, message) => {
    await expect(loadModule().saveConnection(connection)).rejects.toThrow(message);
  });

  it('surfaces native SecureStore errors without AsyncStorage fallback', async () => {
    mockPlatform = 'ios'; const error = new Error('SecureStore unavailable'); mockSecureStore.getItemAsync.mockRejectedValue(error);
    await expect(loadModule().loadConnections()).rejects.toBe(error); expect(mockAsyncStorage.getItem).not.toHaveBeenCalled();
  });
});
