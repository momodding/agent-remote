import { clientProof, parsePairingPayload, validateClientName } from './auth';

describe('Auth-v2 primitives', () => {

  it('builds the backend-compatible client proof', async () => {
    await expect(clientProof('token', 'pair', 'c2FsdC1mb3ItYXV0aC12Mg', 'client', 'server', 'challenge')).resolves.toBe(
      'tGwMgCXetsbr5vAGQ3ua7EodALLxNyeGsxGpPtu1zG0',
    );
  });

  it('validates pairing payloads and device names', () => {
    expect(() => validateClientName(' '.repeat(2))).toThrow('Device name');
    expect(validateClientName('  phone  ')).toBe('phone');
    expect(() => parsePairingPayload('{"v":1}')).toThrow('Invalid pairing payload');
  });
});
