import { payloadAt, varintAt, stringAt } from './protobuf.ts';
import type { Bytes } from './protobuf.ts';

export interface Assertion {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: Bytes;
  signingInput: Uint8Array;
}

export interface PublicKeyset {
  typeUrl: string;
  x: Uint8Array;
  y: Uint8Array;
  keyID: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object';

export function base64urlEncode(bytes: Iterable<number>): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function base64urlDecode(text: unknown): Bytes | null {
  if (typeof text !== 'string') return null;
  let base64 = text.replaceAll('-', '+').replaceAll('_', '/').replaceAll('=', '');
  base64 += '='.repeat((4 - (base64.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function concatBytes(...parts: Uint8Array[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export async function issuerFor(publicKeySPKI: Bytes): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKeySPKI));
  return base64urlEncode(digest);
}

export async function isPublicKeySPKI(bytes: Bytes): Promise<boolean> {
  try {
    await crypto.subtle.importKey(
      'spki',
      bytes,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return true;
  } catch {
    return false;
  }
}

export function readAssertion(jwt: unknown): Assertion | null {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const header = parseJSON(parts[0]);
  const payload = parseJSON(parts[1]);
  const signature = base64urlDecode(parts[2]);
  if (!header || !payload || !signature) return null;
  if (header.alg !== 'ES256') return null;
  if (signature.length !== 64) return null;
  return {
    header,
    payload,
    signature,
    signingInput: textEncoder.encode(`${parts[0]}.${parts[1]}`),
  };
}

function parseJSON(segment: string): Record<string, unknown> | null {
  const raw = base64urlDecode(segment);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(textDecoder.decode(raw));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export async function verifyAssertion(assertion: Assertion, publicKeySPKI: Bytes): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      publicKeySPKI,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      assertion.signature,
      assertion.signingInput,
    );
  } catch {
    return false;
  }
}

export function parsePublicKeyset(bytes: Uint8Array): PublicKeyset | null {
  const typeUrl = stringAt(bytes, [2, 1, 1]);
  const keyMaterial = payloadAt(bytes, [2, 1, 2]);
  if (!typeUrl || !keyMaterial) return null;
  const x = coordinate(payloadAt(keyMaterial, [3]));
  const y = coordinate(payloadAt(keyMaterial, [4]));
  if (!x || !y) return null;
  const keyID = varintAt(bytes, [2, 3]) ?? varintAt(bytes, [1]);
  if (keyID === null || keyID > 0xffffffffn) return null;
  return { typeUrl, x, y, keyID: Number(keyID) };
}

function coordinate(raw: Uint8Array | null): Uint8Array | null {
  if (!raw || raw.length === 0 || raw.length > 32) return null;
  if (raw.length === 32) return raw;
  const padded = new Uint8Array(32);
  padded.set(raw, 32 - raw.length);
  return padded;
}

export async function seal(plaintext: Uint8Array, { x, y, keyID }: PublicKeyset): Promise<Bytes> {
  const recipient = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: base64urlEncode(x), y: base64urlEncode(y) },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const sender = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  if (!('privateKey' in sender)) throw new Error('ECDH key generation did not return a key pair');
  const exported = await crypto.subtle.exportKey('raw', sender.publicKey);
  if (!(exported instanceof ArrayBuffer)) throw new Error('ECDH public key export did not return raw bytes');
  const senderPoint = new Uint8Array(exported);
  const ecdh = { name: 'ECDH', public: recipient };
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, sender.privateKey, 256));

  const hkdfKey = await crypto.subtle.importKey('raw', concatBytes(senderPoint, shared), 'HKDF', false, [
    'deriveBits',
  ]);
  const derived = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new Uint8Array(0) },
      hkdfKey,
      128,
    ),
  );

  const aes = await crypto.subtle.importKey('raw', derived, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, aes, plaintext),
  );

  const prefix = new Uint8Array(5);
  prefix[0] = 0x01;
  new DataView(prefix.buffer).setUint32(1, keyID >>> 0);
  return concatBytes(prefix, senderPoint, iv, sealed);
}

export const utf8 = (text: string): Uint8Array => textEncoder.encode(text);
