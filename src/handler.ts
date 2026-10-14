import { exchange, register, sameSecret } from './auth.ts';
import type { AuthMode, BindingConfig } from './auth.ts';
import { fail } from './errors.ts';
import type { RateLimiter } from './ratelimit.ts';
import type { Index, PairedVideo, StagedUpload, StoredAsset } from './sqlite.ts';
import {
  Writer,
  decode,
  payloadAt,
  varintAt,
  stringAt,
  looksLikeUploadResponse,
  bytesToHex,
  hexToBytes,
} from './protobuf.ts';

interface StagedBlobActions {
  size: number;
  commit(): Promise<void>;
  discard(): Promise<void>;
}

export type StagedBlob =
  | (StagedBlobActions & { tooLarge: true; digest: string | null })
  | (StagedBlobActions & { tooLarge: false; digest: string });

export interface PutStreamOptions {
  limit: number;
  expectedDigest: string;
}

export interface BlobStore {
  putStream(stream: Request['body'], options: PutStreamOptions): Promise<StagedBlob>;
  has(hash: string, expectedSize?: number | null): Promise<boolean>;
  delete(hash: string): Promise<boolean>;
}

export interface HandlerContext {
  token: string;
  origin: string;
  index: Index;
  blobs: BlobStore;
  mode?: AuthMode;
  maxUploadBytes?: number;
  binding?: BindingConfig;
  limiter?: RateLimiter;
  sessionTTL?: number;
}

export interface RequestMeta {
  clientIp?: string;
}

export const UPLOAD_TTL_MS = 30 * 60 * 1000;

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024;

const MAX_CONTROL_BYTES = 8 * 1024 * 1024;

const PROTOBUF = { 'content-type': 'application/x-protobuf' };

const ok = (bytes: Uint8Array<ArrayBuffer>): Response => new Response(bytes, { status: 200, headers: PROTOBUF });

export async function handle(
  request: Request,
  ctx: HandlerContext,
  meta: RequestMeta = {},
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'PUT' && path === '/v1/upload') {
    return uploadBytes(request, ctx, url);
  }

  if (path === '/v1/health') return new Response('ok');

  if (path === '/v1/auth' || path === '/v1/register') {
    if (ctx.limiter && !ctx.limiter.check(meta.clientIp ?? 'local')) {
      return fail(429, 'rate_limited', { 'retry-after': '60' });
    }
  }

  if (request.method === 'POST' && path === '/v1/auth') return exchange(request, ctx);

  const masterOnly = path === '/v1/register';
  if (!(await authorized(request, ctx, masterOnly))) return fail(401, 'unauthorized');

  if (request.method !== 'POST') return fail(405, 'method_not_allowed');
  if (tooLarge(request, MAX_CONTROL_BYTES)) return fail(413, 'too_large');

  if (path === '/v1/register') return register(request, ctx);

  const body = new Uint8Array(await request.arrayBuffer());
  switch (path) {
    case '/v1/find':
      return find(body, ctx);
    case '/v1/upload-token':
      return uploadToken(request, body, ctx);
    case '/v1/commit':
      return commit(body, ctx);
    case '/v1/have':
      return have(body, ctx);
    default:
      return fail(404, 'not_found');
  }
}

async function authorized(request: Request, ctx: HandlerContext, masterOnly: boolean): Promise<boolean> {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const given = header.slice('Bearer '.length);
  if (sameSecret(given, ctx.token)) return masterOnly || (ctx.mode ?? 'bearer') === 'bearer';
  if (masterOnly || (ctx.mode ?? 'bearer') !== 'exchange') return false;
  return ctx.index.liveSession(given, Date.now());
}

function declaredLength(request: Request): number | null {
  const raw = request.headers.get('content-length');
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const tooLarge = (request: Request, limit: number): boolean => (declaredLength(request) ?? 0) > limit;

async function find(body: Uint8Array, ctx: HandlerContext): Promise<Response> {
  const hash = payloadAt(body, [1, 1, 1]);
  if (!hash) return fail(400, 'bad_request');

  const assets = await storedAssets([bytesToHex(hash)], ctx);
  const ref = assets[0]?.ref;
  const root = new Writer();
  if (ref) {
    const inner = new Writer().string(1, ref);
    const middle = new Writer().message(2, inner);
    root.message(1, new Writer().message(2, middle));
  }
  return ok(root.buffer);
}

async function uploadToken(request: Request, body: Uint8Array, ctx: HandlerContext): Promise<Response> {
  const size = varintAt(body, [7]);
  if (size === null) return fail(400, 'missing_size');

  const parsed = parseHashHeader(request.headers.get('x-content-hash'));
  if (!parsed) return fail(400, 'bad_hash_header');

  const limit = ctx.maxUploadBytes ?? MAX_UPLOAD_BYTES;
  if (size > BigInt(limit)) return fail(413, 'too_large');

  const uploadId = crypto.randomUUID().replaceAll('-', '');
  await ctx.index.putPending({
    uploadId,
    hash: parsed.hex,
    algorithm: parsed.algorithm,
    size: Number(size),
    expiresAt: Date.now() + UPLOAD_TTL_MS,
  });

  return new Response(null, {
    status: 200,
    headers: {
      'X-Upload-Id': uploadId,
      'X-Upload-Url': `${ctx.origin}/v1/upload`,
    },
  });
}

function parseHashHeader(value: string | null): { algorithm: string; hex: string } | null {
  if (!value) return null;
  const at = value.indexOf('=');
  if (at <= 0) return null;
  const algorithm = value.slice(0, at).toLowerCase();
  if (algorithm !== 'sha256') return null;
  try {
    const raw = Uint8Array.from(atob(value.slice(at + 1)), (c) => c.charCodeAt(0));
    if (raw.length !== 32) return null;
    return { algorithm, hex: bytesToHex(raw) };
  } catch {
    return null;
  }
}

async function uploadBytes(request: Request, ctx: HandlerContext, url: URL): Promise<Response> {
  const uploadId = url.searchParams.get('upload_id');
  if (!uploadId) return fail(400, 'missing_upload_id');

  const pending = await ctx.index.takePending(uploadId);
  if (!pending) return fail(410, 'upload_id_not_found_or_used');
  if (pending.expiresAt < Date.now()) return fail(410, 'upload_id_expired');

  const limit = Math.min(pending.size, ctx.maxUploadBytes ?? MAX_UPLOAD_BYTES);
  if ((declaredLength(request) ?? 0) > limit) return fail(413, 'too_large');

  const received = await ctx.blobs.putStream(request.body, { limit, expectedDigest: pending.hash });
  if (received.tooLarge) return fail(413, 'too_large');

  if (received.size !== pending.size) {
    await received.discard();
    return fail(409, 'size_mismatch');
  }
  if (received.digest !== pending.hash) {
    await received.discard();
    return fail(409, 'checksum_mismatch');
  }

  await received.commit();
  if (!(await ctx.index.markStaged(uploadId, received.digest))) {
    return fail(410, 'upload_id_not_found_or_used');
  }

  const response = new Writer().varint(1, received.size).string(2, uploadId).buffer;
  return ok(response);
}

async function commit(body: Uint8Array, ctx: HandlerContext): Promise<Response> {
  const main = payloadAt(body, [1]);
  if (!main) return fail(400, 'bad_request');

  const staged = await resolveStaged(main, ctx);
  if (!staged) return fail(410, 'upload_not_found');

  const filename = stringAt(main, [2]) ?? '';
  const hash = payloadAt(main, [3]);
  if (!hash || bytesToHex(hash) !== staged.hash) return fail(409, 'hash_mismatch');

  // 1.4.1 is the client's date for the photo, not when it was sent, so the upload time is this server's clock.
  const uploadedAt = Math.floor(Date.now() / 1000);
  const capturedAt = Number(varintAt(main, [4, 3]) ?? varintAt(main, [4, 1]) ?? 0n);

  const pairedBlock = payloadAt(main, [24]);
  let paired: PairedVideo | null = null;
  if (pairedBlock) {
    const pairedStaged = await resolveStaged(pairedBlock, ctx);
    const pairedHash = payloadAt(pairedBlock, [2]);
    if (!pairedStaged || !pairedHash) return fail(410, 'paired_upload_not_found');
    if (bytesToHex(pairedHash) !== pairedStaged.hash) return fail(409, 'paired_hash_mismatch');
    paired = {
      hash: pairedStaged.hash,
      size: pairedStaged.size,
      stillTimeNs: Number(varintAt(pairedBlock, [3]) ?? 0n),
    };
  }

  const ref = staged.hash;
  await ctx.index.insertAsset({
    ref,
    hash: staged.hash,
    size: staged.size,
    filename,
    capturedAt,
    uploadedAt,
    paired,
  });

  const response = new Writer().message(1, new Writer().message(3, new Writer().string(1, ref)))
    .buffer;
  return ok(response);
}

async function resolveStaged(block: Uint8Array, ctx: HandlerContext): Promise<StagedUpload | null> {
  const echoed = payloadAt(block, [1]);
  if (!echoed || !looksLikeUploadResponse(echoed)) return null;
  const uploadId = stringAt(echoed, [2]);
  if (!uploadId) return null;
  const staged = await ctx.index.stagedById(uploadId);
  if (!staged || !(await ctx.blobs.has(staged.hash, staged.size))) return null;
  return staged;
}

async function have(body: Uint8Array, ctx: HandlerContext): Promise<Response> {
  const asked = (decode(body).get(1) ?? [])
    .filter((entry) => entry.wire === 2)
    .map((entry) => bytesToHex(entry.value));
  if (asked.length === 0) return ok(new Uint8Array(0));

  const present = new Set((await storedAssets(asked, ctx)).map((asset) => asset.hash));
  const root = new Writer();
  for (const hex of asked) {
    if (!present.has(hex)) continue;
    const raw = hexToBytes(hex);
    if (raw) root.bytes(1, raw);
  }
  return ok(root.buffer);
}

async function storedAssets(hashes: string[], ctx: HandlerContext): Promise<StoredAsset[]> {
  const stored: StoredAsset[] = [];
  for (const asset of await ctx.index.assetsForHashes(hashes)) {
    if (!(await ctx.blobs.has(asset.hash, asset.size))) continue;
    if (asset.paired_hash && !(await ctx.blobs.has(asset.paired_hash, asset.paired_size))) continue;
    stored.push(asset);
  }
  return stored;
}
