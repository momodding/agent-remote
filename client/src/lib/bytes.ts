const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (value: string) => encoder.encode(value);
export const text = (value: Uint8Array) => decoder.decode(value);

export function base64Url(value: Uint8Array): string {
  let raw = '';
  value.forEach((byte) => (raw += String.fromCharCode(byte)));
  return btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function decodeBase64Url(value: string): Uint8Array {
  return decodeBase64(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4));
}

export function base64(value: Uint8Array): string {
  let raw = '';
  value.forEach((byte) => (raw += String.fromCharCode(byte)));
  return btoa(raw);
}

export function decodeBase64(value: string): Uint8Array {
  const raw = atob(value);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
