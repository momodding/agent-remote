import { argon2id } from '@noble/hashes/argon2.js';

import { clientProof, parsePairingPayload, validateClientName } from './auth';

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

describe('Auth-v2 primitives', () => {
  it('matches RFC 9106 Argon2id vector', () => {
    expect(
      hex(
        argon2id(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), {
          t: 3,
          m: 32,
          p: 4,
          key: new Uint8Array(8).fill(3),
          personalization: new Uint8Array(12).fill(4),
          dkLen: 32,
        }),
      ),
    ).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  });

  it('builds the backend-compatible client proof', async () => {
    await expect(clientProof('token', 'pair', 'c2FsdC1mb3ItYXV0aC12Mg', 'client', 'server', 'challenge')).resolves.toBe(
      'X96uZzGOBzpHKKPem04jNCZqhqPpLZ3LsIuWbhnW4BQ',
    );
  });

  it('validates pairing payloads and device names', () => {
    expect(() => validateClientName(' '.repeat(2))).toThrow('Device name');
    expect(validateClientName('  phone  ')).toBe('phone');
    expect(() => parsePairingPayload('{"v":1}')).toThrow('Invalid pairing payload');
  });
});
