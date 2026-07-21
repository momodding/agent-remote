import * as SecureStore from 'expo-secure-store';

import type { PairingPayload } from '../protocol';

const CONNECTION_KEY = 'agenticremote.connection';

export type Connection = Pick<PairingPayload, 'endpoint' | 'fingerprint' | 'skipFingerprintVerification'> & {
  token: string;
  clientName: string;
};

export async function loadConnection(): Promise<Connection | null> {
  const raw = await SecureStore.getItemAsync(CONNECTION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Connection;
  } catch {
    await SecureStore.deleteItemAsync(CONNECTION_KEY);
    return null;
  }
}

export async function saveConnection(connection: Connection): Promise<void> {
  await SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify(connection));
}

export async function clearConnection(): Promise<void> {
  await SecureStore.deleteItemAsync(CONNECTION_KEY);
}
