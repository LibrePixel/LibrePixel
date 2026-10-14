import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { truncate } from 'node:fs/promises';
import { join } from 'node:path';

import { startServer } from './support.ts';
import type { TestServer } from './support.ts';
import {
  Writer,
  payloadAt,
  stringAt,
  decode,
  bytesToHex,
  looksLikeUploadResponse,
} from '../src/protobuf.ts';

let running: TestServer;

before(async () => {
  running = await startServer();
});

after(async () => {
  await running.stop();
});

const auth = () => ({ authorization: `Bearer ${running.token}` });
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();

async function post(path: string, body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) {
  return fetch(`${running.origin}${path}`, {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/x-protobuf', ...headers },
    body,
  });
}

const findBody = (hash: Uint8Array) =>
  new Writer().message(1, new Writer().message(1, new Writer().bytes(1, hash)).empty(2)).buffer;

async function requestUpload(size: number, digest: Buffer) {
  const response = await post('/v1/upload-token', new Writer().varint(7, size).buffer, {
    'x-content-hash': `sha256=${digest.toString('base64')}`,
    'x-upload-content-length': String(size),
  });
  return { status: response.status, uploadId: response.headers.get('x-upload-id') };
}

async function putBytes(uploadId: string | null, bytes: Uint8Array) {
  const put = await fetch(`${running.origin}/v1/upload?upload_id=${uploadId}`, {
    method: 'PUT',
    body: bytes,
  });
  return { status: put.status, echoed: new Uint8Array(await put.arrayBuffer()) };
}

const PHOTO_DATE = 1_680_000_000;
const CAPTURED_AT = 1_690_000_000;

async function upload(
  bytes: Buffer,
  filename: string,
  pairedBytes?: Buffer,
  timestamps = new Writer().varint(1, PHOTO_DATE).varint(3, CAPTURED_AT),
) {
  const digest = sha256(bytes);

  const { status, uploadId } = await requestUpload(bytes.length, digest);
  assert.equal(status, 200);
  assert.ok(uploadId);

  const put = await putBytes(uploadId, bytes);
  assert.equal(put.status, 200);
  assert.ok(looksLikeUploadResponse(put.echoed), 'the upload response is {1: varint, 2: bytes}');

  const main = new Writer()
    .bytes(1, put.echoed)
    .string(2, filename)
    .bytes(3, digest)
    .message(4, timestamps)
    .varint(10, 1);
  if (pairedBytes) {
    const pairedDigest = sha256(pairedBytes);
    const pairedTicket = await requestUpload(pairedBytes.length, pairedDigest);
    const pairedPut = await putBytes(pairedTicket.uploadId, pairedBytes);
    assert.equal(pairedPut.status, 200);
    main.message(24, new Writer().bytes(1, pairedPut.echoed).bytes(2, pairedDigest).varint(3, 1));
  }
  const commitBody = new Writer()
    .message(1, main)
    .message(2, new Writer().string(4, 'test').varint(5, 1)).buffer;

  const committed = await post('/v1/commit', commitBody);
  assert.equal(committed.status, 200);
  const ref = stringAt(new Uint8Array(await committed.arrayBuffer()), [1, 3, 1]);
  assert.ok(ref, 'commit returns the remote ref');
  return { ref, digest };
}

test('a stored still can gain a paired video, and a later still-only commit does not downgrade it', async () => {
  const photo = randomBytes(128);
  const video = randomBytes(256);
  const { ref } = await upload(photo, 'upgrade.heic');
  assert.equal((await running.index.assetByRef(ref))?.paired_hash, null);
  await upload(photo, 'upgrade.heic', video);
  assert.equal((await running.index.assetByRef(ref))?.paired_hash, sha256(video).toString('hex'));
  await upload(photo, 'upgrade.heic');
  assert.equal((await running.index.assetByRef(ref))?.paired_hash, sha256(video).toString('hex'));
});

for (const missing of ['main', 'paired']) {
  test(`a ${missing} staged file lost before commit is not recorded as backed up`, async () => {
    const photo = randomBytes(32), video = randomBytes(48);
    const mainTicket = await requestUpload(photo.length, sha256(photo));
    const mainPut = await putBytes(mainTicket.uploadId, photo);
    const videoTicket = await requestUpload(video.length, sha256(video));
    const videoPut = await putBytes(videoTicket.uploadId, video);
    await running.blobs.delete(sha256(missing === 'main' ? photo : video).toString('hex'));
    const main = new Writer().bytes(1, mainPut.echoed).string(2, 'missing.heic').bytes(3, sha256(photo))
      .message(24, new Writer().bytes(1, videoPut.echoed).bytes(2, sha256(video)).varint(3, 1));
    const response = await post('/v1/commit', new Writer().message(1, main).buffer);
    assert.equal(response.status, 410);
    assert.equal(await running.index.assetByRef(sha256(photo).toString('hex')), null);
  });
}

test('no bearer token means 401', async () => {
  const response = await fetch(`${running.origin}/v1/find`, { method: 'POST', body: new Uint8Array() });
  assert.equal(response.status, 401);
});

test('upload one, dedup hits, have finds it', async () => {
  const bytes = randomBytes(4096);
  const { ref, digest } = await upload(bytes, 'IMG_0001.HEIC');
  assert.equal(ref, digest.toString('hex'), 'content-addressed: the remote ref is the content digest');

  const found = await post('/v1/find', findBody(digest));
  assert.equal(stringAt(new Uint8Array(await found.arrayBuffer()), [1, 2, 2, 1]), ref);

  const missing = await post('/v1/find', findBody(sha256(randomBytes(16))));
  assert.equal(payloadAt(new Uint8Array(await missing.arrayBuffer()), [1, 2, 2, 1]), null);

  const other = sha256(randomBytes(16));
  const haveBody = new Writer().bytes(1, digest).bytes(1, other).buffer;
  const have = await post('/v1/have', haveBody);
  const present = (decode(new Uint8Array(await have.arrayBuffer())).get(1) ?? [])
    .filter((e) => e.wire === 2)
    .map((e) => bytesToHex(e.value));
  assert.deepEqual(present, [digest.toString('hex')]);
});

for (const damage of ['deleted', 'truncated']) {
  test(`an original that is ${damage} is no longer deduped or confirmed, and re-uploading repairs it`, async () => {
    const bytes = randomBytes(128);
    const { ref, digest } = await upload(bytes, 'repair.jpg');
    if (damage === 'deleted') await running.blobs.delete(ref);
    else await truncate(join(running.dir, 'blobs', ref.slice(0, 2), ref), 1);

    const found = await post('/v1/find', findBody(digest));
    assert.equal(stringAt(new Uint8Array(await found.arrayBuffer()), [1, 2, 2, 1]), null);
    const have = await post('/v1/have', new Writer().bytes(1, digest).buffer);
    assert.equal((await have.arrayBuffer()).byteLength, 0);

    await upload(bytes, 'repair.jpg');
    const repaired = await post('/v1/have', new Writer().bytes(1, digest).buffer);
    assert.equal((decode(new Uint8Array(await repaired.arrayBuffer())).get(1) ?? []).length, 1);
    assert.deepEqual(Buffer.from((await running.blobs.get(ref)) ?? []), bytes);
  });
}

for (const damage of ['deleted', 'truncated']) {
  test(`a paired video that is ${damage} unconfirms the whole asset, and re-uploading repairs it`, async () => {
    const photo = randomBytes(128);
    const video = randomBytes(256);
    const { digest } = await upload(photo, 'live.heic', video);
    const videoHash = sha256(video).toString('hex');
    if (damage === 'deleted') await running.blobs.delete(videoHash);
    else await truncate(join(running.dir, 'blobs', videoHash.slice(0, 2), videoHash), 1);
    const have = await post('/v1/have', new Writer().bytes(1, digest).buffer);
    assert.equal((await have.arrayBuffer()).byteLength, 0);
    const found = await post('/v1/find', findBody(digest));
    assert.equal(stringAt(new Uint8Array(await found.arrayBuffer()), [1, 2, 2, 1]), null);
    await upload(photo, 'live.heic', video);
    const repaired = await post('/v1/have', new Writer().bytes(1, digest).buffer);
    assert.equal((decode(new Uint8Array(await repaired.arrayBuffer())).get(1) ?? []).length, 1);
    assert.deepEqual(Buffer.from((await running.blobs.get(videoHash)) ?? []), video);
  });
}

test('a storage error means unconfirmed, not missing', async () => {
  const { digest } = await upload(randomBytes(128), 'storage-error.jpg');
  const has = running.blobs.has;
  running.blobs.has = async () => { throw Object.assign(new Error('storage unavailable'), { code: 'EIO' }); };
  try {
    assert.equal((await post('/v1/find', findBody(digest))).status, 500);
    assert.equal((await post('/v1/have', new Writer().bytes(1, digest).buffer)).status, 500);
  } finally {
    running.blobs.has = has;
  }
  const have = await post('/v1/have', new Writer().bytes(1, digest).buffer);
  assert.equal((decode(new Uint8Array(await have.arrayBuffer())).get(1) ?? []).length, 1);
});

test('capture time comes from 1.4.3 and upload time is when the server received the commit', async () => {
  const before = Math.floor(Date.now() / 1000);
  const { ref } = await upload(randomBytes(1024), 'IMG_0003.HEIC');
  const after = Math.floor(Date.now() / 1000);

  const row = (await running.index.recent(50)).find((r) => r.ref === ref);
  assert.equal(row?.captured_at, CAPTURED_AT, '1.4.3 is the capture time');
  assert.ok(
    row && row.uploaded_at >= before && row.uploaded_at <= after,
    `uploaded_at ${row?.uploaded_at} is the server's clock, not 1.4.1`,
  );
});

test('without 1.4.3 the capture time is 1.4.1', async () => {
  const { ref } = await upload(randomBytes(1024), 'IMG_0006.PNG', undefined, new Writer().varint(1, PHOTO_DATE));

  const row = (await running.index.recent(50)).find((r) => r.ref === ref);
  assert.equal(row?.captured_at, PHOTO_DATE);
});

test('an empty have query gets an empty answer', async () => {
  const have = await post('/v1/have', new Uint8Array(0));
  assert.equal(have.status, 200);
  assert.equal((await have.arrayBuffer()).byteLength, 0, 'an empty have neither crashes nor returns anything');
});

test('bytes that do not match the digest are rejected and not stored', async () => {
  const bytes = randomBytes(1024);
  const lie = sha256(randomBytes(16));

  const { uploadId } = await requestUpload(bytes.length, lie);
  const put = await putBytes(uploadId, bytes);
  assert.equal(put.status, 409, 'a digest mismatch is 409');
  assert.equal(await running.blobs.has(lie.toString('hex')), false);
  assert.equal(await running.blobs.has(sha256(bytes).toString('hex')), false, 'nor stored under the real digest');
});

test('a byte count that does not match the declared size is rejected', async () => {
  const bytes = randomBytes(2048);
  const digest = sha256(bytes);

  const { uploadId } = await requestUpload(bytes.length, digest);
  const put = await putBytes(uploadId, bytes.subarray(0, 1024));
  assert.equal(put.status, 409);
  assert.match(new TextDecoder().decode(put.echoed), /^size_mismatch: \S/);
  assert.equal(await running.blobs.has(digest.toString('hex')), false);
});

test('an upload id cannot be used twice', async () => {
  const bytes = randomBytes(512);
  const digest = sha256(bytes);
  const { uploadId } = await requestUpload(bytes.length, digest);

  assert.equal((await putBytes(uploadId, bytes)).status, 200);
  assert.equal((await putBytes(uploadId, bytes)).status, 410);
});

test('two concurrent requests for one upload id: only one wins', async () => {
  const bytes = randomBytes(4096);
  const digest = sha256(bytes);
  const { uploadId } = await requestUpload(bytes.length, digest);

  const results = await Promise.all([putBytes(uploadId, bytes), putBytes(uploadId, bytes)]);
  assert.deepEqual(
    results.map((r) => r.status).sort(),
    [200, 410],
    'one succeeds, the other is rejected',
  );
});

test('an expired upload id is 410', async () => {
  const bytes = randomBytes(256);
  const digest = sha256(bytes);
  const uploadId = randomUUID().replaceAll('-', '');
  await running.index.putPending({
    uploadId,
    hash: digest.toString('hex'),
    algorithm: 'sha256',
    size: bytes.length,
    expiresAt: Date.now() - 1000,
  });

  const put = await putBytes(uploadId, bytes);
  assert.equal(put.status, 410);
  assert.match(new TextDecoder().decode(put.echoed), /^upload_id_expired: \S/);
});

test('staged bytes are rejected when the commit digest does not match', async () => {
  const bytes = randomBytes(1024);
  const digest = sha256(bytes);
  const { uploadId } = await requestUpload(bytes.length, digest);
  const put = await putBytes(uploadId, bytes);
  assert.equal(put.status, 200);

  const main = new Writer()
    .bytes(1, put.echoed)
    .string(2, 'IMG_0004.HEIC')
    .bytes(3, sha256(randomBytes(8)))
    .message(4, new Writer().varint(1, PHOTO_DATE))
    .varint(10, 1);
  const committed = await post('/v1/commit', new Writer().message(1, main).buffer);
  assert.equal(committed.status, 409);
  assert.match(await committed.text(), /^hash_mismatch: \S/);
});

test('a commit whose paired video was never staged is rejected', async () => {
  const photo = randomBytes(2048);
  const photoDigest = sha256(photo);
  const { uploadId } = await requestUpload(photo.length, photoDigest);
  const put = await putBytes(uploadId, photo);
  assert.equal(put.status, 200);

  const bogus = new Writer().varint(1, 4096).string(2, 'ffffffffffffffffffffffffffffffff').buffer;
  const paired = new Writer().bytes(1, bogus).bytes(2, sha256(randomBytes(8))).varint(3, 1);
  const main = new Writer()
    .bytes(1, put.echoed)
    .string(2, 'IMG_0005.HEIC')
    .bytes(3, photoDigest)
    .message(4, new Writer().varint(1, PHOTO_DATE))
    .varint(10, 1)
    .message(24, paired);

  const committed = await post('/v1/commit', new Writer().message(1, main).buffer);
  assert.equal(committed.status, 410);
  assert.match(await committed.text(), /^paired_upload_not_found: \S/);
  assert.equal(
    await running.index.refForHash(photoDigest.toString('hex')),
    null,
    'the still is not recorded on its own either',
  );
});

test('a live photo commits its still and video together', async () => {
  const photo = randomBytes(2048);
  const video = randomBytes(8192);
  const photoDigest = sha256(photo);
  const videoDigest = sha256(video);

  const stage = async (bytes: Buffer, digest: Buffer) => {
    const { uploadId } = await requestUpload(bytes.length, digest);
    return (await putBytes(uploadId, bytes)).echoed;
  };

  const videoEchoed = await stage(video, videoDigest);
  const photoEchoed = await stage(photo, photoDigest);

  const paired = new Writer()
    .bytes(1, videoEchoed)
    .bytes(2, videoDigest)
    .varint(3, 1_500_000_000);
  const main = new Writer()
    .bytes(1, photoEchoed)
    .string(2, 'IMG_0002.HEIC')
    .bytes(3, photoDigest)
    .message(4, new Writer().varint(1, PHOTO_DATE).varint(3, CAPTURED_AT))
    .varint(10, 1)
    .message(24, paired);

  const committed = await post('/v1/commit', new Writer().message(1, main).buffer);
  assert.equal(committed.status, 200);
  const ref = stringAt(new Uint8Array(await committed.arrayBuffer()), [1, 3, 1]);
  assert.equal(ref, photoDigest.toString('hex'));

  const rows = await running.index.recent(10);
  const row = rows.find((r) => r.ref === ref);
  assert.equal(row?.paired_hash, videoDigest.toString('hex'), 'the paired video is stored on the same row as the still');
});
