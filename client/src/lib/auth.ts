import * as Crypto from 'expo-crypto';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { base64Url, decodeBase64Url, utf8 } from './bytes';
import type { PairingPayload } from '../protocol';

const AUTH_CONTEXT = 'agenticRemote-auth-v2';

export function parsePairingPayload(raw: string): PairingPayload {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('Pairing payload must be an object');
  const payload = value as Partial<PairingPayload>;
  if (
    payload.v !== 2 ||
    typeof payload.endpoint !== 'string' ||
    typeof payload.fingerprint !== 'string' ||
    typeof payload.pairingId !== 'string' ||
    typeof payload.token !== 'string' ||
    typeof payload.expiresAt !== 'string'
  ) {
    throw new Error('Invalid pairing payload');
  }
  if (Number.isNaN(Date.parse(payload.expiresAt))) throw new Error('Invalid pairing expiration');
  return payload as PairingPayload;
}

export function validateClientName(raw: string): string {
  const name = raw.trim();
  if (!name || Array.from(name).length > 64) throw new Error('Device name must be 1–64 characters');
  return name;
}

export function newClientNonce(): string {
  return base64Url(Crypto.getRandomBytes(32));
}

export async function clientProof(
  token: string,
  pairingId: string,
  salt: string,
  clientNonce: string,
  serverNonce: string,
  challengeId: string,
): Promise<string> {
  const verifier = hmac(sha256, utf8(token), decodeBase64Url(salt));
  return base64Url(hmac(sha256, verifier, utf8(AUTH_CONTEXT + pairingId + clientNonce + serverNonce + challengeId)));
}
