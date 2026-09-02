import { deflateRawSync, inflateRawSync } from 'node:zlib';

import { CREDENTIAL_FIELD, bindingConfig } from './auth.ts';
import type { AuthMode, BindingConfig } from './auth.ts';
import { MAX_UPLOAD_BYTES } from './handler.ts';

const PLAIN_PREFIX = 'lp1.';
const PACKED_PREFIX = 'lp1z.';
const LINK_PREFIX = 'librepixel://setup?code=';

const b64url = (buf: Uint8Array): string => Buffer.from(buf).toString('base64url');

export interface BearerAuth {
  mode: 'bearer';
}

export interface ExchangeAuth {
  mode: 'exchange';
  url: string;
  form: [string, string][];
  response: { token: string; expiry: string; encrypted: string; error: string };
  binding: BindingConfig;
}

export interface Profile {
  v: 1;
  name: string;
  server: string;
  auth: BearerAuth | ExchangeAuth;
  endpoints: {
    find: string;
    uploadToken: string;
    uploadBytes: string;
    commit: string;
    have: string;
  };
  headers: {
    hash: string;
    hashAlgorithm: string;
    hashFormat: string;
    contentLength: string;
    uploadId: string;
  };
  client: { make: string; platformVersion: number };
  limits: { photoMaxBytes: number; videoMaxBytes: number };
  credential: Record<string, string>;
}

export interface ProfileOptions {
  name?: string;
  mode?: AuthMode;
  maxUploadBytes?: number;
}

export function buildProfile(
  origin: string,
  token: string,
  { name = 'LibrePixel', mode = 'bearer', maxUploadBytes = MAX_UPLOAD_BYTES }: ProfileOptions = {},
): Profile {
  return {
    v: 1,
    name,
    server: new URL(origin).host,
    auth: auth(origin, mode),
    endpoints: {
      find: `${origin}/v1/find`,
      uploadToken: `${origin}/v1/upload-token`,
      uploadBytes: `${origin}/v1/upload?upload_id={token}`,
      commit: `${origin}/v1/commit`,
      have: `${origin}/v1/have`,
    },
    headers: {
      hash: 'X-Content-Hash',
      hashAlgorithm: 'sha256',
      hashFormat: 'sha256={base64}',
      contentLength: 'X-Upload-Content-Length',
      uploadId: 'X-Upload-Id',
    },
    client: { make: 'LibrePixel', platformVersion: 1 },
    limits: { photoMaxBytes: maxUploadBytes, videoMaxBytes: maxUploadBytes },
    credential: { [CREDENTIAL_FIELD]: token },
  };
}

function auth(origin: string, mode: AuthMode): BearerAuth | ExchangeAuth {
  if (mode !== 'exchange') return { mode: 'bearer' };
  const binding = bindingConfig(origin);
  return {
    mode: 'exchange',
    url: `${origin}/v1/auth`,
    form: [[CREDENTIAL_FIELD, `cred:${CREDENTIAL_FIELD}`]],
    response: { token: 'Auth', expiry: 'Expiry', encrypted: 'TokenEncrypted', error: 'Error' },
    binding,
  };
}

export function encodeProfile(profile: Profile): string {
  const raw = Buffer.from(JSON.stringify(profile));
  const plain = `${PLAIN_PREFIX}${b64url(raw)}`;
  const packed = `${PACKED_PREFIX}${b64url(deflateRawSync(raw, { level: 9 }))}`;
  return packed.length < plain.length ? packed : plain;
}

export function decodeProfile(code: unknown): Profile {
  let text = String(code).replace(/\s+/g, '');
  if (text.startsWith(LINK_PREFIX)) text = text.slice(LINK_PREFIX.length);

  let packed = false;
  if (text.startsWith(PACKED_PREFIX)) {
    text = text.slice(PACKED_PREFIX.length);
    packed = true;
  } else if (text.startsWith(PLAIN_PREFIX)) {
    text = text.slice(PLAIN_PREFIX.length);
  } else {
    throw new Error("That connection info isn't recognized");
  }

  let raw = Buffer.from(text, 'base64url');
  if (packed) raw = inflateRawSync(raw);
  return JSON.parse(raw.toString('utf8'));
}

export function setupLink(code: string): string {
  return `${LINK_PREFIX}${code}`;
}
