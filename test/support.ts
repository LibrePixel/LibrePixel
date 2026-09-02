import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { webcrypto } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import type { BindingConfig } from '../src/auth.ts';
import { serve } from '../src/node.ts';
import type { RunningServer, ServeOptions } from '../src/node.ts';
import { Writer } from '../src/protobuf.ts';
import type { Bytes } from '../src/protobuf.ts';
import { base64urlDecode, base64urlEncode, concatBytes } from '../src/binding.ts';

export interface TestServer extends RunningServer {
  dir: string;
  stop(): Promise<void>;
}

export async function startServer(options: ServeOptions = {}): Promise<TestServer> {
  const dir = await mkdtemp(join(tmpdir(), 'librepixel-'));
  const probe = await serve({ ...options, dir, port: 0, host: '127.0.0.1' });
  const port = (probe.server.address() as AddressInfo).port;
  await probe.close();

  const running = await serve({ ...options, dir, port, host: '127.0.0.1' });
  return {
    ...running,
    dir,
    async stop() {
      await running.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export interface AssertionOptions {
  binding: BindingConfig;
  keyID: number;
  now?: number;
  overrides?: Record<string, unknown>;
}

export class BindingClient {
  #signing: webcrypto.CryptoKeyPair;
  #ephemeral: webcrypto.CryptoKeyPair;

  constructor(signing: webcrypto.CryptoKeyPair, ephemeral: webcrypto.CryptoKeyPair) {
    this.#signing = signing;
    this.#ephemeral = ephemeral;
  }

  static async create(): Promise<BindingClient> {
    const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ]);
    return new BindingClient(signing, ephemeral);
  }

  async publicKeySPKI(): Promise<Bytes> {
    return new Uint8Array(await crypto.subtle.exportKey('spki', this.#signing.publicKey));
  }

  async issuer(): Promise<string> {
    const spki = await this.publicKeySPKI();
    return base64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', spki)));
  }

  async ephemeralPoint(): Promise<{ x: Bytes; y: Bytes }> {
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', this.#ephemeral.publicKey));
    return { x: raw.slice(1, 33), y: raw.slice(33, 65) };
  }

  async publicKeyset({
    keyID,
    publicKeyType,
    aeadType,
  }: {
    keyID: number;
    publicKeyType: string;
    aeadType: string;
  }): Promise<Bytes> {
    const { x, y } = await this.ephemeralPoint();

    const aesGcmKeyFormat = new Writer().varint(2, 16);
    const aeadDem = new Writer().string(1, aeadType).bytes(2, aesGcmKeyFormat.buffer).varint(3, 1);
    const kemParams = new Writer().varint(1, 2).varint(2, 3);
    const demParams = new Writer().message(2, aeadDem);
    const params = new Writer().message(1, kemParams).message(2, demParams).varint(3, 1);
    const eciesPublicKey = new Writer().message(2, params).bytes(3, x).bytes(4, y);
    const keyData = new Writer()
      .string(1, publicKeyType)
      .bytes(2, eciesPublicKey.buffer)
      .varint(3, 3);
    const key = new Writer().message(1, keyData).varint(2, 1).varint(3, keyID).varint(4, 1);
    return new Writer().varint(1, keyID).message(2, key).buffer;
  }

  async assertionJWT({
    binding,
    keyID,
    now = Math.floor(Date.now() / 1000),
    overrides = {},
  }: AssertionOptions): Promise<string> {
    const keyset = await this.publicKeyset({
      keyID,
      publicKeyType: binding.publicKeyType,
      aeadType: binding.aeadType,
    });
    const payload = {
      namespace: binding.namespace,
      aud: binding.audience,
      iss: await this.issuer(),
      iat: now,
      ephemeral_key: {
        kty: binding.publicKeyType,
        [binding.keysetTypeUrl]: base64urlEncode(keyset),
      },
      ...overrides,
    };
    const header = { alg: 'ES256', typ: 'JWT' };
    const signingInput = `${segment(header)}.${segment(payload)}`;
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        this.#signing.privateKey,
        new TextEncoder().encode(signingInput),
      ),
    );
    return `${signingInput}.${base64urlEncode(signature)}`;
  }

  async unseal(text: string | undefined, keyID: number): Promise<{ token: string; hasPrefix: boolean }> {
    const raw = base64urlDecode(text);
    if (!raw) throw new Error('Not base64url');

    const prefix = new Uint8Array(5);
    prefix[0] = 0x01;
    new DataView(prefix.buffer).setUint32(1, keyID >>> 0);
    const hasPrefix = prefix.every((byte, at) => raw[at] === byte);
    const body = hasPrefix ? raw.slice(prefix.length) : raw;

    const senderPoint = body.slice(0, 65);
    const dem = body.slice(65);
    const sender = await crypto.subtle.importKey(
      'raw',
      senderPoint,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const shared = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'ECDH', public: sender }, this.#ephemeral.privateKey, 256),
    );
    const hkdf = await crypto.subtle.importKey(
      'raw',
      concatBytes(senderPoint, shared),
      'HKDF',
      false,
      ['deriveBits'],
    );
    const derived = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new Uint8Array(0) },
      hkdf,
      128,
    );
    const aes = await crypto.subtle.importKey('raw', derived, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: dem.slice(0, 12), tagLength: 128 },
      aes,
      dem.slice(12),
    );
    return { token: new TextDecoder().decode(plaintext), hasPrefix };
  }
}

function segment(value: unknown): string {
  return base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

export function parseFields(text: string): Record<string, string | undefined> {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1);
  }
  return fields;
}

export const form = (pairs: Record<string, string>): string => new URLSearchParams(pairs).toString();
export const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };
