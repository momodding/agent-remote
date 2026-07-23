import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { PairingPayload } from '../protocol';

const CONNECTION_KEY = 'agenticremote.connection';

export type Connection = Pick<PairingPayload, 'endpoint' | 'fingerprint' | 'skipFingerprintVerification'> & {
  token: string;
  clientName: string;
};

async function getConnectionValue(): Promise<string | null> {
  if (Platform.OS === 'web') {
    return AsyncStorage.getItem(CONNECTION_KEY);
  }
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

export async function loadConnection(): Promise<Connection | null> {
  const raw = await getConnectionValue();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Connection;
  } catch {
    await removeConnectionValue();
    return null;
  }
}

export async function saveConnection(connection: Connection): Promise<void> {
  await setConnectionValue(JSON.stringify(connection));
}

export async function clearConnection(): Promise<void> {
  await removeConnectionValue();
}
