import type { Connection } from './connection';

type ConnectionModule = {
  loadConnection: () => Promise<Connection | null>;
  saveConnection: (connection: Connection) => Promise<void>;
  clearConnection: () => Promise<void>;
};

let mockPlatform = 'web';

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

jest.mock('react-native', () => ({ Platform: { OS: mockPlatform } }));
jest.mock('expo-secure-store', () => mockSecureStore);
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: mockAsyncStorage,
}));

const fixture: Connection = {
  endpoint: 'https://daemon.example:8765',
  fingerprint: 'sha256:00112233445566778899aabbccddeeff',
  skipFingerprintVerification: true,
  token: 'deterministic-session-token',
  clientName: 'test-cashier',
};

const loadConnectionModule = (): ConnectionModule => require('./connection') as ConnectionModule;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockPlatform = 'web';
});

describe('connection storage', () => {
  it('loads, saves, and clears through AsyncStorage on web', async () => {
    mockAsyncStorage.getItem.mockResolvedValue(JSON.stringify(fixture));
    const { clearConnection, loadConnection, saveConnection } = await loadConnectionModule();

    await expect(loadConnection()).resolves.toEqual(fixture);
    await saveConnection(fixture);
    await clearConnection();

    expect(mockAsyncStorage.getItem).toHaveBeenCalledWith('agenticremote.connection');
    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
      'agenticremote.connection',
      JSON.stringify(fixture),
    );
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith('agenticremote.connection');
    expect(mockSecureStore.getItemAsync).not.toHaveBeenCalled();
    expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(mockSecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('removes malformed web storage and returns null', async () => {
    mockAsyncStorage.getItem.mockResolvedValue('{malformed');
    const { loadConnection } = await loadConnectionModule();

    await expect(loadConnection()).resolves.toBeNull();

    expect(mockAsyncStorage.getItem).toHaveBeenCalledWith('agenticremote.connection');
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith('agenticremote.connection');
    expect(mockSecureStore.getItemAsync).not.toHaveBeenCalled();
    expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(mockSecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('loads, saves, and clears through SecureStore on iOS', async () => {
    mockPlatform = 'ios';
    mockSecureStore.getItemAsync.mockResolvedValue(JSON.stringify(fixture));
    const { clearConnection, loadConnection, saveConnection } = await loadConnectionModule();

    await expect(loadConnection()).resolves.toEqual(fixture);
    await saveConnection(fixture);
    await clearConnection();

    expect(mockSecureStore.getItemAsync).toHaveBeenCalledWith('agenticremote.connection');
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
      'agenticremote.connection',
      JSON.stringify(fixture),
    );
    expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith('agenticremote.connection');
    expect(mockAsyncStorage.getItem).not.toHaveBeenCalled();
    expect(mockAsyncStorage.setItem).not.toHaveBeenCalled();
    expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
  });

  it('surfaces native SecureStore errors without AsyncStorage fallback', async () => {
    mockPlatform = 'ios';
    const storageError = new Error('SecureStore unavailable');
    mockSecureStore.getItemAsync.mockRejectedValue(storageError);
    const { loadConnection } = await loadConnectionModule();

    await expect(loadConnection()).rejects.toBe(storageError);

    expect(mockAsyncStorage.getItem).not.toHaveBeenCalled();
    expect(mockAsyncStorage.setItem).not.toHaveBeenCalled();
    expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
  });
});
