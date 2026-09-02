import {
  base64urlDecode,
  base64urlEncode,
  isPublicKeySPKI,
  issuerFor,
  parsePublicKeyset,
  readAssertion,
  seal,
  utf8,
  verifyAssertion,
  isRecord,
} from './binding.ts';
import type { HandlerContext } from './handler.ts';

export type AuthMode = 'bearer' | 'exchange';

export interface BindingConfig {
  aliasPrefix: string;
  namespace: string;
  audience: string;
  publicKeyType: string;
  aeadType: string;
  keysetTypeUrl: string;
  assertionField: string;
  register: string;
}

type Verified =
  | { error: string; status: number }
  | { claims: Record<string, unknown>; issuer: string };

export const SESSION_TTL_MS = 60 * 60 * 1000;

const CLOCK_SKEW_SECONDS = 10 * 60;

export const CREDENTIAL_FIELD = 'Token';

export function bindingConfig(origin: string): BindingConfig {
  return {
    aliasPrefix: 'librepixel:binding:',
    namespace: 'librepixel',
    audience: `${origin}/v1/auth`,
    publicKeyType: 'librepixel.binding/EciesP256HkdfAes128Gcm',
    aeadType: 'librepixel.binding/Aes128Gcm',
    keysetTypeUrl: 'public_keyset',
    assertionField: 'assertion',
    register: `${origin}/v1/register`,
  };
}

const TEXT = { 'content-type': 'text/plain; charset=utf-8' };

function lines(status: number, fields: Record<string, string | number | null | undefined>): Response {
  const body = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  return new Response(`${body}\n`, { status, headers: TEXT });
}

const refuse = (status: number, code: string): Response => lines(status, { Error: code });

export function sameSecret(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function bindingOf(ctx: HandlerContext): BindingConfig {
  if (!ctx.binding) throw new Error('Device binding is not configured');
  return ctx.binding;
}

async function issueSession(
  ctx: HandlerContext,
  issuer: string | null,
): Promise<{ token: string; expiry: number }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const token = base64urlEncode(raw);
  const expiresAt = Date.now() + (ctx.sessionTTL ?? SESSION_TTL_MS);
  await ctx.index.putSession({ token, issuer, expiresAt });
  return { token, expiry: Math.floor(expiresAt / 1000) };
}

async function verifySignedAssertion(
  jwt: string,
  config: BindingConfig,
  index: HandlerContext['index'],
): Promise<Verified> {
  const assertion = readAssertion(jwt);
  if (!assertion) return { error: 'bad_assertion', status: 400 };

  const claims = assertion.payload;
  if (config.namespace && claims.namespace !== config.namespace) {
    return { error: 'bad_assertion', status: 401 };
  }
  if (config.audience && claims.aud !== config.audience) {
    return { error: 'bad_assertion', status: 401 };
  }

  const issuedAt = Number(claims.iat);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(issuedAt) || Math.abs(now - issuedAt) > CLOCK_SKEW_SECONDS) {
    return { error: 'stale_assertion', status: 401 };
  }

  const issuer = typeof claims.iss === 'string' ? claims.iss : '';
  const registered = issuer ? await index.bindingKey(issuer) : null;
  if (!registered) return { error: 'unknown_key', status: 401 };

  const publicKey = base64urlDecode(registered);
  if (!publicKey || !(await verifyAssertion(assertion, publicKey))) {
    return { error: 'bad_assertion', status: 401 };
  }

  return { claims, issuer };
}

export async function exchange(request: Request, ctx: HandlerContext): Promise<Response> {
  const form = new URLSearchParams(await request.text());

  if (!sameSecret(form.get(CREDENTIAL_FIELD) ?? '', ctx.token)) {
    return refuse(401, 'bad_credential');
  }

  const config = bindingOf(ctx);

  const jwt = form.get(config.assertionField);
  if (!jwt) {
    if (await ctx.index.hasBindingKeys()) return refuse(401, 'binding_required');
    const issued = await issueSession(ctx, null);
    return lines(200, { Auth: issued.token, Expiry: issued.expiry });
  }

  const verified = await verifySignedAssertion(jwt, config, ctx.index);
  if ('error' in verified) return refuse(verified.status, verified.error);
  const { claims, issuer } = verified;

  const ephemeral = claims.ephemeral_key;
  if (!isRecord(ephemeral)) return refuse(400, 'bad_ephemeral_key');
  if (config.publicKeyType && ephemeral.kty !== config.publicKeyType) {
    return refuse(400, 'bad_ephemeral_key');
  }
  const keysetBytes = base64urlDecode(ephemeral[config.keysetTypeUrl]);
  const keyset = keysetBytes ? parsePublicKeyset(keysetBytes) : null;
  if (!keyset) return refuse(400, 'bad_ephemeral_key');
  if (config.publicKeyType && keyset.typeUrl !== config.publicKeyType) {
    return refuse(400, 'bad_ephemeral_key');
  }

  const issued = await issueSession(ctx, issuer);
  let encrypted;
  try {
    encrypted = await seal(utf8(issued.token), keyset);
  } catch {
    return refuse(400, 'bad_ephemeral_key');
  }

  return lines(200, {
    Auth: base64urlEncode(encrypted),
    Expiry: issued.expiry,
    TokenEncrypted: 1,
  });
}

export async function register(request: Request, ctx: HandlerContext): Promise<Response> {
  const form = new URLSearchParams(await request.text());

  const publicKey = base64urlDecode(form.get('public_key') ?? '');
  if (!publicKey || !(await isPublicKeySPKI(publicKey))) return refuse(400, 'bad_public_key');

  if (await ctx.index.hasBindingKeys()) {
    const config = bindingOf(ctx);
    const jwt = form.get(config.assertionField);
    if (!jwt) return refuse(401, 'binding_required');
    const verified = await verifySignedAssertion(jwt, config, ctx.index);
    if ('error' in verified) return refuse(verified.status, verified.error);
  }

  const issuer = await issuerFor(publicKey);
  await ctx.index.putBindingKey({
    issuer,
    publicKey: base64urlEncode(publicKey),
    label: form.get('label') ?? null,
  });
  return lines(200, { Issuer: issuer });
}
