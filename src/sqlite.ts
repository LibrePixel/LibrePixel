export const SCHEMA = `
CREATE TABLE IF NOT EXISTS assets (
  ref         TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL DEFAULT 'me',
  hash        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  filename    TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  paired_hash TEXT,
  paired_size INTEGER,
  still_ns    INTEGER
);
CREATE INDEX IF NOT EXISTS assets_hash ON assets (user_id, hash);
CREATE INDEX IF NOT EXISTS assets_time ON assets (user_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS assets_paired ON assets (paired_hash);

CREATE TABLE IF NOT EXISTS uploads (
  upload_id  TEXT PRIMARY KEY,
  hash       TEXT NOT NULL,
  algorithm  TEXT NOT NULL,
  size       INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  staged     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS uploads_expiry ON uploads (expires_at);

CREATE TABLE IF NOT EXISTS binding_keys (
  issuer     TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL DEFAULT 'me',
  public_key TEXT NOT NULL,
  label      TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL DEFAULT 'me',
  issuer     TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);
`;

export type SqlValue = string | number | bigint | null;

export interface Db {
  all<T = Record<string, unknown>>(sql: string, params: SqlValue[]): Promise<T[]>;
  run(sql: string, params: SqlValue[]): Promise<number>;
}

export interface PendingUpload {
  uploadId: string;
  hash: string;
  algorithm: string;
  size: number;
  expiresAt: number;
}

export interface ClaimedUpload {
  uploadId: string;
  hash: string;
  size: number;
  expiresAt: number;
}

export interface StagedUpload {
  hash: string;
  size: number;
}

export interface PairedVideo {
  hash: string;
  size: number;
  stillTimeNs: number;
}

export interface NewAsset {
  ref: string;
  hash: string;
  size: number;
  filename: string;
  capturedAt: number;
  uploadedAt: number;
  paired: PairedVideo | null;
}

export interface StoredAsset {
  ref: string;
  hash: string;
  size: number;
  paired_hash: string | null;
  paired_size: number | null;
}

export interface RecentAsset {
  ref: string;
  filename: string;
  size: number;
  captured_at: number;
  uploaded_at: number;
  paired_hash: string | null;
}

export interface AssetDetail {
  ref: string;
  filename: string;
  size: number;
  captured_at: number;
  uploaded_at: number;
  created_at: number;
  paired_hash: string | null;
  paired_size: number | null;
  still_ns: number | null;
}

export interface BlobOwner {
  ref: string;
  filename: string;
  paired_hash: string | null;
}

export interface ExpiredUpload {
  upload_id: string;
  hash: string;
  staged: number;
}

export interface BindingKey {
  issuer: string;
  publicKey: string;
  label: string | null;
}

export interface BindingKeyRow {
  issuer: string;
  label: string | null;
  created_at: number;
}

export interface NewSession {
  token: string;
  issuer: string | null;
  expiresAt: number;
}

export const PENDING = 0;
export const CLAIMED = 1;
export const STAGED = 2;

export async function migrate(db: Db): Promise<void> {
  const columns = new Set(
    (await db.all<{ name: string }>('PRAGMA table_info(assets)', [])).map((row) => row.name),
  );
  if (columns.size > 0 && !columns.has('uploaded_at')) {
    await db.run('ALTER TABLE assets ADD COLUMN uploaded_at INTEGER NOT NULL DEFAULT 0', []);
  }
}

export type Index = ReturnType<typeof makeIndex>;

export function makeIndex(db: Db) {
  return {
    async refForHash(hash: string): Promise<string | null> {
      const rows = await db.all<{ ref: string }>('SELECT ref FROM assets WHERE hash = ? LIMIT 1', [hash]);
      return rows[0]?.ref ?? null;
    },

    async haveHashes(hashes: string[]): Promise<Set<string>> {
      const found = new Set<string>();
      for (let i = 0; i < hashes.length; i += 100) {
        const batch = hashes.slice(i, i + 100);
        const marks = batch.map(() => '?').join(',');
        const rows = await db.all<{ hash: string }>(`SELECT hash FROM assets WHERE hash IN (${marks})`, batch);
        for (const row of rows) found.add(row.hash);
      }
      return found;
    },

    async assetsForHashes(hashes: string[]): Promise<StoredAsset[]> {
      const assets: StoredAsset[] = [];
      for (let i = 0; i < hashes.length; i += 100) {
        const batch = hashes.slice(i, i + 100);
        const marks = batch.map(() => '?').join(',');
        assets.push(...await db.all<StoredAsset>(
          `SELECT ref, hash, size, paired_hash, paired_size FROM assets WHERE hash IN (${marks})`,
          batch,
        ));
      }
      return assets;
    },

    async putPending({ uploadId, hash, algorithm, size, expiresAt }: PendingUpload): Promise<void> {
      await db.run(
        'INSERT INTO uploads (upload_id, hash, algorithm, size, expires_at) VALUES (?, ?, ?, ?, ?)',
        [uploadId, hash, algorithm, size, expiresAt],
      );
    },

    async takePending(uploadId: string): Promise<ClaimedUpload | null> {
      const changed = await db.run(
        `UPDATE uploads SET staged = ${CLAIMED} WHERE upload_id = ? AND staged = ${PENDING}`,
        [uploadId],
      );
      if (changed !== 1) return null;
      const rows = await db.all<{ upload_id: string; hash: string; size: number; expires_at: number }>(
        'SELECT upload_id, hash, size, expires_at FROM uploads WHERE upload_id = ?',
        [uploadId],
      );
      const row = rows[0];
      if (!row) return null;
      return { uploadId: row.upload_id, hash: row.hash, size: row.size, expiresAt: row.expires_at };
    },

    async markStaged(uploadId: string, hash: string): Promise<boolean> {
      const changed = await db.run(
        `UPDATE uploads SET staged = ${STAGED}, hash = ? WHERE upload_id = ? AND staged = ${CLAIMED}`,
        [hash, uploadId],
      );
      return changed === 1;
    },

    async stagedById(uploadId: string): Promise<StagedUpload | null> {
      const rows = await db.all<StagedUpload>(
        `SELECT hash, size FROM uploads WHERE upload_id = ? AND staged = ${STAGED}`,
        [uploadId],
      );
      return rows[0] ? { hash: rows[0].hash, size: rows[0].size } : null;
    },

    async insertAsset({ ref, hash, size, filename, capturedAt, uploadedAt, paired }: NewAsset): Promise<void> {
      await db.run(
        `INSERT INTO assets
           (ref, hash, size, filename, captured_at, uploaded_at, created_at,
            paired_hash, paired_size, still_ns)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET
           paired_hash = excluded.paired_hash,
           paired_size = excluded.paired_size,
           still_ns = excluded.still_ns
         WHERE excluded.paired_hash IS NOT NULL`,
        [
          ref,
          hash,
          size,
          filename,
          capturedAt,
          uploadedAt,
          Math.floor(Date.now() / 1000),
          paired?.hash ?? null,
          paired?.size ?? null,
          paired?.stillTimeNs ?? null,
        ],
      );
    },

    async recent(limit = 200): Promise<RecentAsset[]> {
      return db.all<RecentAsset>(
        `SELECT ref, filename, size, captured_at, uploaded_at, paired_hash
           FROM assets
          ORDER BY COALESCE(NULLIF(captured_at, 0), uploaded_at, created_at) DESC,
                   created_at DESC
          LIMIT ?`,
        [limit],
      );
    },

    async assetByRef(ref: string): Promise<AssetDetail | null> {
      const rows = await db.all<AssetDetail>(
        `SELECT ref, filename, size, captured_at, uploaded_at, created_at,
                paired_hash, paired_size, still_ns
           FROM assets WHERE ref = ? LIMIT 1`,
        [ref],
      );
      return rows[0] ?? null;
    },

    async assetForBlob(hash: string): Promise<BlobOwner | null> {
      const rows = await db.all<BlobOwner>(
        `SELECT ref, filename, paired_hash FROM assets
          WHERE hash = ? OR paired_hash = ? LIMIT 1`,
        [hash, hash],
      );
      return rows[0] ?? null;
    },

    async countAssets(): Promise<number> {
      const rows = await db.all<{ n: number | bigint }>('SELECT COUNT(*) AS n FROM assets', []);
      return Number(rows[0]?.n ?? 0);
    },

    async expiredUploads(now: number, limit = 500): Promise<ExpiredUpload[]> {
      return db.all<ExpiredUpload>(
        'SELECT upload_id, hash, staged FROM uploads WHERE expires_at < ? LIMIT ?',
        [now, limit],
      );
    },

    async deleteUpload(uploadId: string): Promise<void> {
      await db.run('DELETE FROM uploads WHERE upload_id = ?', [uploadId]);
    },

    async hashInUse(hash: string, exceptUploadId: string): Promise<boolean> {
      const assets = await db.all(
        'SELECT 1 AS hit FROM assets WHERE hash = ? OR paired_hash = ? LIMIT 1',
        [hash, hash],
      );
      if (assets.length > 0) return true;
      const others = await db.all(
        `SELECT 1 AS hit FROM uploads
          WHERE hash = ? AND upload_id <> ? AND staged = ${STAGED} LIMIT 1`,
        [hash, exceptUploadId],
      );
      return others.length > 0;
    },

    async putBindingKey({ issuer, publicKey, label }: BindingKey): Promise<void> {
      await db.run(
        `INSERT INTO binding_keys (issuer, public_key, label, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(issuer) DO UPDATE SET public_key = excluded.public_key,
                                           label = excluded.label`,
        [issuer, publicKey, label ?? null, Math.floor(Date.now() / 1000)],
      );
    },

    async bindingKey(issuer: string): Promise<string | null> {
      const rows = await db.all<{ public_key: string }>('SELECT public_key FROM binding_keys WHERE issuer = ?', [issuer]);
      return rows[0]?.public_key ?? null;
    },

    async hasBindingKeys(): Promise<boolean> {
      return (await db.all('SELECT 1 AS hit FROM binding_keys LIMIT 1', [])).length > 0;
    },

    async listBindingKeys(): Promise<BindingKeyRow[]> {
      return db.all<BindingKeyRow>(
        'SELECT issuer, label, created_at FROM binding_keys ORDER BY created_at ASC, issuer ASC',
        [],
      );
    },

    async deleteBindingKey(issuer: string): Promise<number> {
      return db.run('DELETE FROM binding_keys WHERE issuer = ?', [issuer]);
    },

    async deleteAllBindingKeys(): Promise<number> {
      const removed = await db.run('DELETE FROM binding_keys', []);
      await db.run('DELETE FROM sessions WHERE issuer IS NOT NULL', []);
      return removed;
    },

    async putSession({ token, issuer, expiresAt }: NewSession): Promise<void> {
      await db.run('INSERT INTO sessions (token, issuer, expires_at) VALUES (?, ?, ?)', [
        token,
        issuer ?? null,
        expiresAt,
      ]);
    },

    async liveSession(token: string, now: number): Promise<boolean> {
      const rows = await db.all(
        'SELECT token FROM sessions WHERE token = ? AND expires_at > ?',
        [token, now],
      );
      return rows.length > 0;
    },

    async deleteExpiredSessions(now: number): Promise<void> {
      await db.run('DELETE FROM sessions WHERE expires_at < ?', [now]);
    },
  };
}
