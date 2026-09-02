import type { BlobStore } from './handler.ts';
import type { Index } from './sqlite.ts';

export interface SweepResult {
  uploads: number;
  blobs: number;
}

export async function sweep({
  index,
  blobs,
  now = Date.now(),
}: {
  index: Index;
  blobs: Pick<BlobStore, 'delete'>;
  now?: number;
}): Promise<SweepResult> {
  const expired = await index.expiredUploads(now);
  let removedBlobs = 0;
  for (const row of expired) {
    if (row.staged === 2 && !(await index.hashInUse(row.hash, row.upload_id))) {
      if (await blobs.delete(row.hash)) removedBlobs += 1;
    }
    await index.deleteUpload(row.upload_id);
  }
  await index.deleteExpiredSessions(now);
  return { uploads: expired.length, blobs: removedBlobs };
}
