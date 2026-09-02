import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { startServer } from './support.ts';
import type { TestServer } from './support.ts';
import { Writer } from '../src/protobuf.ts';

const MAX_UPLOAD = 64 * 1024;

let running: TestServer;

before(async () => {
  running = await startServer({ maxUploadBytes: MAX_UPLOAD });
});

after(async () => {
  await running.stop();
});

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();

async function requestUpload(size: number, digest: Buffer) {
  return fetch(`${running.origin}/v1/upload-token`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${running.token}`,
      'content-type': 'application/x-protobuf',
      'x-content-hash': `sha256=${digest.toString('base64')}`,
    },
    body: new Writer().varint(7, size).buffer,
  });
}

const uploadURL = (uploadId: string | null) => `${running.origin}/v1/upload?upload_id=${uploadId}`;

test('a declared size over the per-file limit gets no upload URL', async () => {
  const digest = sha256(randomBytes(16));
  const response = await requestUpload(MAX_UPLOAD + 1, digest);
  assert.equal(response.status, 413);
  assert.match(await response.text(), /^too_large: \S/);
});

test('a Content-Length larger than declared is rejected without reading a byte', async () => {
  const declared = 1024;
  const digest = sha256(randomBytes(declared));
  const token = await requestUpload(declared, digest);
  const uploadId = token.headers.get('x-upload-id');

  const put = await fetch(uploadURL(uploadId), { method: 'PUT', body: randomBytes(declared * 4) });
  assert.equal(put.status, 413);
  assert.match(await put.text(), /^too_large: \S/);
});

test('without Content-Length, bytes are counted as they arrive and the upload is cut off when over', async () => {
  const declared = 4096;
  const digest = sha256(randomBytes(declared));
  const token = await requestUpload(declared, digest);
  const uploadId = token.headers.get('x-upload-id');

  const chunk = new Uint8Array(randomBytes(declared));
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent >= 8) return controller.close();
      sent += 1;
      controller.enqueue(chunk);
    },
  });

  const put = await fetch(uploadURL(uploadId), { method: 'PUT', body, duplex: 'half' });
  assert.equal(put.status, 413);
  assert.match(await put.text(), /^too_large: \S/);

  const temp = await readdir(join(running.dir, 'tmp')).catch(() => []);
  assert.deepEqual(temp, [], 'tmp/ is clean after the rejection');
});

test('expired uploads: rows are deleted along with unreferenced bytes', async () => {
  const bytes = randomBytes(2048);
  const digest = sha256(bytes);
  const hex = digest.toString('hex');

  const token = await requestUpload(bytes.length, digest);
  const uploadId = token.headers.get('x-upload-id');
  assert.ok(uploadId);
  const put = await fetch(uploadURL(uploadId), { method: 'PUT', body: bytes });
  assert.equal(put.status, 200);
  assert.equal(await running.blobs.has(hex), true);

  await running.index.putPending({
    uploadId: randomUUID().replaceAll('-', ''),
    hash: sha256(randomBytes(8)).toString('hex'),
    algorithm: 'sha256',
    size: 1,
    expiresAt: Date.now() - 1000,
  });
  await expire(uploadId);

  const swept = await running.sweep();
  assert.equal(swept.uploads, 2, 'both rows expired');
  assert.equal(swept.blobs, 1, 'only the upload that reached disk has bytes to delete');
  assert.equal(await running.blobs.has(hex), false, 'unreferenced bytes are not kept');
  assert.equal(await running.index.stagedById(uploadId), null);
});

test('expiry cleanup leaves committed assets alone', async () => {
  const bytes = randomBytes(1024);
  const digest = sha256(bytes);
  const hex = digest.toString('hex');

  const token = await requestUpload(bytes.length, digest);
  const uploadId = token.headers.get('x-upload-id');
  const put = await fetch(uploadURL(uploadId), { method: 'PUT', body: bytes });
  const echoed = new Uint8Array(await put.arrayBuffer());

  const main = new Writer()
    .bytes(1, echoed)
    .string(2, 'IMG_9000.HEIC')
    .bytes(3, digest)
    .message(4, new Writer().varint(1, 1_757_000_000).varint(3, 1_690_000_000))
    .varint(10, 1);
  const committed = await fetch(`${running.origin}/v1/commit`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${running.token}`,
      'content-type': 'application/x-protobuf',
    },
    body: new Writer().message(1, main).buffer,
  });
  assert.equal(committed.status, 200);

  await expire(uploadId);
  await running.sweep();
  assert.equal(await running.blobs.has(hex), true, 'bytes referenced by an asset are kept');
});

async function expire(uploadId: string | null) {
  await running.db.run('UPDATE uploads SET expires_at = ? WHERE upload_id = ?', [
    Date.now() - 1000,
    uploadId,
  ]);
}
