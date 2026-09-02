import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, unlink, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { bindingConfig } from './auth.ts';
import type { AuthMode, BindingConfig } from './auth.ts';
import { browseHandles, handleBrowse } from './browse.ts';
import type { BlobReader } from './browse.ts';
import { sweep } from './cleanup.ts';
import type { SweepResult } from './cleanup.ts';
import { errorBody } from './errors.ts';
import { handle, MAX_UPLOAD_BYTES } from './handler.ts';
import type { BlobStore, HandlerContext, PutStreamOptions, StagedBlob } from './handler.ts';
import type { Bytes } from './protobuf.ts';
import { createRateLimiter } from './ratelimit.ts';
import { SCHEMA, makeIndex, migrate } from './sqlite.ts';
import type { Db, Index, SqlValue } from './sqlite.ts';

export interface FileBlobStore extends BlobStore, BlobReader {
  get(hash: string): Promise<Bytes | null>;
  clearTemp(): Promise<void>;
}

export interface SqliteDb extends Db {
  close(): void;
}

export interface ServeOptions {
  port?: number;
  dir?: string;
  host?: string;
  origin?: string;
  mode?: AuthMode;
  maxUploadBytes?: number;
  sweepIntervalMs?: number;
  trustProxy?: boolean;
}

export interface RunningServer {
  server: Server;
  token: string;
  origin: string;
  index: Index;
  blobs: FileBlobStore;
  db: SqliteDb;
  binding: BindingConfig;
  sweep(): Promise<SweepResult>;
  close(): Promise<void>;
}

const errorCode = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : undefined;

const blobPath = (dir: string, hash: string): string => join(dir, 'blobs', hash.slice(0, 2), hash);

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

function fileBlobs(dir: string): FileBlobStore {
  const tempDir = join(dir, 'tmp');
  return {
    async putStream(
      stream: Request['body'],
      { limit = Infinity }: Partial<PutStreamOptions> = {},
    ): Promise<StagedBlob> {
      await mkdir(tempDir, { recursive: true });
      const temp = join(tempDir, `${randomUUID()}.part`);
      const digest = createHash('sha256');
      let size = 0;
      let tooLarge = false;

      const handle = await open(temp, 'w');
      try {
        for await (const bytes of stream ?? []) {
          size += bytes.byteLength;
          if (size > limit) {
            tooLarge = true;
            break;
          }
          digest.update(bytes);
          await handle.write(bytes);
        }
      } finally {
        await handle.close();
      }

      if (tooLarge) {
        await rm(temp, { force: true });
        return { tooLarge: true, size, digest: null, commit: async () => {}, discard: async () => {} };
      }

      const hex = digest.digest('hex');
      return {
        tooLarge: false,
        size,
        digest: hex,
        async commit() {
          const path = blobPath(dir, hex);
          await mkdir(dirname(path), { recursive: true });
          await rename(temp, path);
        },
        async discard() {
          await rm(temp, { force: true });
        },
      };
    },

    async get(hash: string) {
      try {
        return new Uint8Array(await readFile(blobPath(dir, hash)));
      } catch {
        return null;
      }
    },

    async openRead(hash: string) {
      try {
        const handle = await open(blobPath(dir, hash), 'r');
        const { size } = await handle.stat();
        return { stream: handle.createReadStream(), size };
      } catch {
        return null;
      }
    },

    async has(hash: string, expectedSize?: number | null) {
      try {
        const file = await stat(blobPath(dir, hash));
        return file.isFile() && (expectedSize == null || file.size === expectedSize);
      } catch (error) {
        const code = errorCode(error);
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
        return false;
      }
    },

    async delete(hash: string) {
      try {
        await unlink(blobPath(dir, hash));
        return true;
      } catch {
        return false;
      }
    },

    async clearTemp() {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function sqliteDb(path: string): SqliteDb {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return {
    async all<T>(sql: string, params: SqlValue[]) {
      return db.prepare(sql).all(...params) as T[];
    },
    async run(sql: string, params: SqlValue[]) {
      return Number(db.prepare(sql).run(...params).changes ?? 0);
    },
    close: () => db.close(),
  };
}

export async function openIndex(dir: string): Promise<{ index: Index; close: () => void }> {
  await mkdir(dir, { recursive: true });
  const db = sqliteDb(join(dir, 'index.db'));
  await migrate(db);
  return { index: makeIndex(db), close: () => db.close() };
}

function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  const direct = req.socket?.remoteAddress ?? 'local';
  if (!trustProxy) return direct;
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return forwarded.at(-1) ?? direct;
}

async function loadToken(dir: string): Promise<string> {
  const path = join(dir, 'token');
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    const token = randomBytes(32).toString('base64url');
    await mkdir(dir, { recursive: true });
    await writeFile(path, `${token}\n`, { mode: 0o600 });
    return token;
  }
}

export async function serve({
  port = 8788,
  dir = './data',
  host = '127.0.0.1',
  origin = `http://${host}:${port}`,
  mode = 'bearer',
  maxUploadBytes = MAX_UPLOAD_BYTES,
  sweepIntervalMs = SWEEP_INTERVAL_MS,
  trustProxy = false,
}: ServeOptions = {}): Promise<RunningServer> {
  await mkdir(dir, { recursive: true });
  const token = await loadToken(dir);
  const db = sqliteDb(join(dir, 'index.db'));
  await migrate(db);
  const index = makeIndex(db);
  const blobs = fileBlobs(dir);
  const limiter = createRateLimiter();
  const ctx: HandlerContext & { binding: BindingConfig } = {
    blobs,
    index,
    token,
    origin,
    mode,
    maxUploadBytes,
    binding: bindingConfig(origin),
    limiter,
  };

  await blobs.clearTemp();
  await sweep({ index, blobs });
  const sweeper = setInterval(() => {
    sweep({ index, blobs }).catch((error) => {
      console.error('Failed to clean up expired uploads');
      console.error(error);
    });
    limiter.sweep();
  }, sweepIntervalMs);
  sweeper.unref?.();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', origin);
      const clientIp = clientAddress(req, trustProxy);
      if (browseHandles(req.method, url.pathname)) {
        await handleBrowse(req, res, url, {
          blobs,
          index,
          token,
          origin,
          mode,
          maxUploadBytes,
          limiter,
          clientIp,
        });
        if (!req.readableEnded) req.resume();
        return;
      }

      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(`${origin}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string | string[]>,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: 'half',
      });

      const response = await handle(request, ctx, { clientIp });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      const payload = Buffer.from(await response.arrayBuffer());
      res.end(payload.length > 0 ? payload : undefined);
      if (!req.readableEnded) req.resume();
    } catch (error) {
      const path = String(req.url ?? '').split('?')[0];
      console.error(`Request failed: ${req.method} ${path}`);
      console.error(error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const body = errorBody('internal_error');
      res.writeHead(500, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(Buffer.byteLength(body)),
      });
      res.end(body);
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    clearInterval(sweeper);
    db.close();
    throw error;
  }
  return {
    server,
    token,
    origin,
    index,
    blobs,
    db,
    binding: ctx.binding,
    sweep: () => sweep({ index, blobs }),
    close: async () => {
      clearInterval(sweeper);
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}
