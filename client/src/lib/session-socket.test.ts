import { base64, decodeBase64, text, utf8 } from './bytes';

describe('PTY frame byte encoding', () => {
  it('round-trips UTF-8 input through standard padded base64', () => {
    const encoded = base64(utf8('λ'));
    expect(encoded).toContain('=');
    expect(text(decodeBase64(encoded))).toBe('λ');
  });
});
