import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const CONNECTION_KEY = 'agenticremote.connection';

export type Connection = {
  name: string;
  endpoint: string;
  hostId: string;
  fingerprint: string;
  skipFingerprintVerification: boolean;
  token: string;
  clientName: string;
};

export type PairedConnection = Omit<Connection, 'name'>;

export type ConnectionStore = {
  connections: Connection[];
};

const emptyStore = (): ConnectionStore => ({ connections: [] });

function normalizeEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Endpoint is required');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Endpoint must be a valid URL');
  }
  if (url.protocol !== 'https:' || !url.host) throw new Error('Endpoint must use https and include a host');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Endpoint cannot include credentials, a path, query, or fragment');
  return url.origin;
}

function normalizeLabel(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} is required`);
  const trimmed = value.trim();
  if (!trimmed || Array.from(trimmed).length > 64) throw new Error(`${field} must be 1–64 characters`);
  return trimmed;
}

function normalizeHostId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Host ID is required');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256) throw new Error('Host ID must be 1–256 characters');
  return trimmed;
}

function normalizeConnection(value: unknown, legacy = false): Connection {
  if (!value || typeof value !== 'object') throw new Error('Invalid daemon connection');
  const input = value as Record<string, unknown>;
  const endpoint = normalizeEndpoint(input.endpoint);
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (!token) throw new Error('Session token is required');
  if (typeof input.fingerprint !== 'string') throw new Error('Fingerprint must be a string');
  const skipFingerprintVerification = legacy && input.skipFingerprintVerification === undefined ? false : input.skipFingerprintVerification;
  if (typeof skipFingerprintVerification !== 'boolean') throw new Error('Skip fingerprint verification must be a boolean');
  return {
    name: input.name === undefined && legacy ? new URL(endpoint).host : normalizeLabel(input.name, 'Name'),
    endpoint,
    hostId: normalizeHostId(input.hostId ?? input.fingerprint),
    fingerprint: input.fingerprint,
    skipFingerprintVerification,
    token,
    clientName: normalizeLabel(input.clientName, 'Client name'),
  };
}

function normalizeStore(value: unknown): ConnectionStore {
  if (!value || typeof value !== 'object') throw new Error('Invalid daemon connection store');
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.connections)) throw new Error('Invalid daemon connection store');
  const connections = input.connections.map((connection) => normalizeConnection(connection));
  if (new Set(connections.map(({ endpoint }) => endpoint)).size !== connections.length) throw new Error('Duplicate daemon endpoint');
  if (new Set(connections.map(({ hostId }) => hostId)).size !== connections.length) throw new Error('Duplicate daemon host');
  return { connections };
}

async function getConnectionValue(): Promise<string | null> {
  if (Platform.OS === 'web') return AsyncStorage.getItem(CONNECTION_KEY);
  return SecureStore.getItemAsync(CONNECTION_KEY);
}

async function setConnectionValue(value: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(CONNECTION_KEY, value);
    return;
  }
  await SecureStore.setItemAsync(CONNECTION_KEY, value);
}

async function removeConnectionValue(): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.removeItem(CONNECTION_KEY);
    return;
  }
  await SecureStore.deleteItemAsync(CONNECTION_KEY);
}

async function readConnections(persistRepair: boolean): Promise<ConnectionStore> {
  const raw = await getConnectionValue();
  if (!raw) return emptyStore();
  let parsed: unknown;
  let store: ConnectionStore;
  try {
    parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray((parsed as Record<string, unknown>).connections)) {
      store = { connections: [normalizeConnection(parsed, true)] };
    } else {
      store = normalizeStore(parsed);
    }
  } catch {
    if (persistRepair) await removeConnectionValue();
    return emptyStore();
  }
  if (persistRepair && JSON.stringify(store) !== JSON.stringify(parsed)) await setConnectionValue(JSON.stringify(store));
  return store;
}

export function loadConnections(): Promise<ConnectionStore> {
  return readConnections(true);
}

export function getConnection(store: ConnectionStore, hostId: string | null): Connection | null {
  if (!hostId) return null;
  return store.connections.find((connection) => connection.hostId === hostId) ?? null;
}

export async function saveConnection(connection: Connection): Promise<ConnectionStore> {
  const store = await readConnections(false);
  const replacement = normalizeConnection(connection);
  const index = store.connections.findIndex(({ hostId }) => hostId === replacement.hostId);
  if (index < 0) store.connections.push(replacement);
  else store.connections[index] = replacement;
  await setConnectionValue(JSON.stringify(store));
  return store;
}

export async function updateConnection(originalHostId: string, replacement: Connection): Promise<ConnectionStore> {
  const store = await readConnections(false);
  const index = store.connections.findIndex(({ hostId }) => hostId === originalHostId);
  if (index < 0) throw new Error('Daemon connection not found');
  const normalized = normalizeConnection(replacement);
  if (store.connections.some(({ hostId }, candidate) => candidate !== index && hostId === normalized.hostId)) throw new Error('A daemon with this host already exists');
  store.connections[index] = normalized;
  await setConnectionValue(JSON.stringify(store));
  return store;
}

export async function deleteConnection(hostId: string): Promise<ConnectionStore> {
  const store = await readConnections(false);
  const index = store.connections.findIndex((connection) => connection.hostId === hostId);
  if (index < 0) throw new Error('Daemon connection not found');
  store.connections.splice(index, 1);
  await setConnectionValue(JSON.stringify(store));
  return store;
}
