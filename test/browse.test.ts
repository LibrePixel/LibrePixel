import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { startServer } from './support.ts';
import type { TestServer } from './support.ts';
import { Writer, looksLikeUploadResponse } from '../src/protobuf.ts';
import { handleBrowse } from '../src/browse.ts';
import type { BrowseResponse } from '../src/browse.ts';

let running: TestServer;

before(async () => {
  running = await startServer();
});

after(async () => {
  await running.stop();
});

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
const bearer = () => ({ authorization: `Bearer ${running.token}` });
const basic = () => ({ authorization: `Basic ${Buffer.from(`:${running.token}`).toString('base64')}` });

async function stage(bytes: Buffer) {
  const digest = sha256(bytes);
  const token = await fetch(`${running.origin}/v1/upload-token`, {
    method: 'POST',
    headers: { ...bearer(), 'content-type': 'application/x-protobuf', 'x-content-hash': `sha256=${digest.toString('base64')}` },
    body: new Writer().varint(7, bytes.length).buffer,
  });
  const uploadId = token.headers.get('x-upload-id');
  const put = await fetch(`${running.origin}/v1/upload?upload_id=${uploadId}`, { method: 'PUT', body: bytes });
  const echoed = new Uint8Array(await put.arrayBuffer());
  assert.ok(looksLikeUploadResponse(echoed));
  return { digest, echoed };
}

async function commit(main: Writer) {
  const res = await fetch(`${running.origin}/v1/commit`, {
    method: 'POST',
    headers: { ...bearer(), 'content-type': 'application/x-protobuf' },
    body: new Writer().message(1, main).buffer,
  });
  assert.equal(res.status, 200);
}

async function uploadPhoto(bytes: Buffer, filename: string) {
  const { digest, echoed } = await stage(bytes);
  const main = new Writer()
    .bytes(1, echoed)
    .string(2, filename)
    .bytes(3, digest)
    .message(4, new Writer().varint(1, 1_757_000_000).varint(3, 1_690_000_000))
    .varint(10, 1);
  await commit(main);
  return digest.toString('hex');
}

async function uploadLivePhoto(photo: Buffer, video: Buffer, filename: string) {
  const v = await stage(video);
  const p = await stage(photo);
  const paired = new Writer().bytes(1, v.echoed).bytes(2, v.digest).varint(3, 1_500_000_000);
  const main = new Writer()
    .bytes(1, p.echoed)
    .string(2, filename)
    .bytes(3, p.digest)
    .message(4, new Writer().varint(1, 1_757_000_000).varint(3, 1_690_000_000))
    .varint(10, 1)
    .message(24, paired);
  await commit(main);
  return { ref: p.digest.toString('hex'), videoHash: v.digest.toString('hex') };
}

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${running.origin}${path}`, { headers });

const HAN = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/;
function assertEnglishOnly(html: string, what: string) {
  assert.doesNotMatch(html, HAN, `${what} is English only`);
  assert.match(html, /<html lang="en">/);
}

test('no photos yet: the whole page is "Connect the app" with the connection info expanded', async () => {
  const fresh = await startServer();
  try {
    const res = await fetch(`${fresh.origin}/`, {
      headers: { authorization: `Bearer ${fresh.token}` },
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assertEnglishOnly(html, 'first-run page');
    assert.match(html, /Connect the app/);
    assert.match(html, /No photos yet\./);
    assert.match(html, /0 items/);
    assert.doesNotMatch(html, /<details/, 'not collapsed when the library is empty');
    assert.match(html, /<svg[^>]*viewBox="0 0 \d+ \d+" shape-rendering/, 'QR code');
    assert.match(html, /id="connection-info" readonly[^>]*value="lp1z?\./, 'selectable read-only connection info');
    assert.match(html, /data-copy="connection-info" hidden/, 'copy button stays hidden without scripts');
    assert.match(html, /Anyone with this connection info can access this server/);
    assert.doesNotMatch(html, new RegExp(new URL(fresh.origin).host.replaceAll('.', '\\.') + '<'), 'the header does not show the server address');
  } finally {
    await fresh.stop();
  }
});

test('no credentials: 401 with a Basic auth prompt', async () => {
  const res = await get('/');
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /Basic/);
  const page = await res.text();
  assertEnglishOnly(page, '401 page');
  assert.match(page, /Password required/);
  assert.match(page, /<b>Password:<\/b> this server's token/);
  assert.match(page, /<code>token<\/code> file in the data directory/);
});

test('the password hint on the 401 page can be replaced, and is escaped', async () => {
  let status = 0;
  let body = '';
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(chunk?: string) {
      body = String(chunk ?? '');
    },
  } as unknown as BrowseResponse;
  await handleBrowse({ headers: {} }, res, new URL(`${running.origin}/`), {
    ...running,
    passwordHint: 'the one in the <review> notes.',
  });
  assert.equal(status, 401);
  assert.match(body, /<b>Password:<\/b> the one in the &lt;review&gt; notes\./);
  assert.doesNotMatch(body, /data directory/);
});

test('broken percent-encoding: 404 for a photo, 400 for a blob, never 500', async () => {
  const photo = await get('/photo/%E0%A4%A', basic());
  assert.equal(photo.status, 404);
  assert.match(await photo.text(), /Photo not found/);
  const blob = await get('/v1/blob/%E0%A4%A', basic());
  assert.equal(blob.status, 400);
  assert.match(await blob.text(), /File not found/);
});

test('favicon needs no credentials', async () => {
  const res = await get('/favicon.ico');
  assert.equal(res.status, 204);
});

test('grid: uploaded photos listed by month, with the connection QR code', async () => {
  await uploadPhoto(randomBytes(2048), 'IMG_0001.JPG');
  await uploadPhoto(randomBytes(1024), 'IMG_0002.HEIC');

  const res = await get('/', basic());
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /IMG_0001\.JPG/);
  assert.match(html, /IMG_0002\.HEIC/);
  assert.match(html, /class="grid"/);
  assertEnglishOnly(html, 'grid page');
  assert.match(html, /<h2>July 2023<\/h2>/);
  assert.match(html, /No preview/);
  assert.match(html, /<details class="connect">/);
  assert.match(html, /Connect the app/);
  assert.match(html, /<svg[^>]*shape-rendering/);
  assert.match(html, /value="lp1z?\./);
});

test('original download: bearer or Basic auth, bytes match the upload', async () => {
  const bytes = randomBytes(4096);
  const ref = await uploadPhoto(bytes, 'IMG_0003.JPG');

  const unauth = await get(`/v1/blob/${ref}`);
  assert.equal(unauth.status, 401, 'original downloads need credentials');

  const res = await get(`/v1/blob/${ref}`, bearer());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('content-length'), String(bytes.length));
  const got = new Uint8Array(await res.arrayBuffer());
  assert.equal(sha256(Buffer.from(got)).toString('hex'), ref, 'downloaded bytes match the content digest');
});

test('original download: ?download=1 sends an attachment with the filename', async () => {
  const ref = await uploadPhoto(randomBytes(512), 'IMG_0004.JPG');
  const res = await get(`/v1/blob/${ref}?download=1`, basic());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /attachment/);
  assert.match(res.headers.get('content-disposition') ?? '', /IMG_0004\.JPG/);
});

async function downloadDisposition(hash: string, size: number) {
  const res = await fetch(`${running.origin}/v1/blob/${hash}?download=1`, {
    headers: basic(),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(size));
  assert.equal((await res.arrayBuffer()).byteLength, size);
  return res.headers.get('content-disposition') ?? '';
}

test('original download: non-ASCII filename uses an ASCII fallback in filename and the real name in filename*', async () => {
  const bytes = randomBytes(700);
  const ref = await uploadPhoto(bytes, 'Ταξίδι φωτό.JPG');
  const cd = await downloadDisposition(ref, bytes.length);
  assert.match(cd, /^attachment; /);
  assert.match(cd, /filename="_ _\.JPG"/, 'non-ASCII becomes _, the extension stays');
  assert.match(cd, new RegExp(`filename\\*=UTF-8''${encodeURIComponent('Ταξίδι φωτό.JPG').replace(/\./g, '\\.')}`));
  assert.doesNotMatch(cd, /[^\x20-\x7e]/, 'the header contains only printable ASCII');
});

test('original download: filenames with emoji, quotes and control characters work', async () => {
  const bytes = randomBytes(300);
  const name = 'party 🎉 "a\\b"\t(1).heic';
  const ref = await uploadPhoto(bytes, name);
  const cd = await downloadDisposition(ref, bytes.length);
  assert.match(cd, /filename="party _ _a_b_\(1\)\.heic"/);
  assert.match(cd, /filename\*=UTF-8''party%20%F0%9F%8E%89%20%22a%5Cb%22%09%281%29\.heic/);
  assert.doesNotMatch(cd, /[^\x20-\x7e]/);
});

test('original download: the paired video of a non-ASCII live photo is named <basename>.mov', async () => {
  const photo = randomBytes(1024);
  const video = randomBytes(4096);
  const { videoHash } = await uploadLivePhoto(photo, video, 'Καλοκαίρι.HEIC');
  const cd = await downloadDisposition(videoHash, video.length);
  assert.match(cd, /filename="_\.mov"/);
  assert.match(cd, new RegExp(`filename\\*=UTF-8''${encodeURIComponent('Καλοκαίρι')}\\.mov`));
});

test('photo page: the original can be downloaded', async () => {
  const ref = await uploadPhoto(randomBytes(512), 'IMG_0005.JPG');
  const res = await get(`/photo/${ref}`, basic());
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, new RegExp(`/v1/blob/${ref}\\?download=1`));
  assert.match(html, /IMG_0005\.JPG/);
  assertEnglishOnly(html, 'photo page');
  assert.match(html, /Download original/);
  assert.match(html, /Taken Jul 22, 2023 at 04:26 UTC/);
  assert.match(html, /<dt>Uploaded<\/dt><dd>Sep 4, 2025 at \d\d:\d\d UTC<\/dd>/);
  assert.match(html, new RegExp(`<span class="mono">${ref}</span>`), 'checksum');
  assert.match(html, /No preview for JPG/, 'placeholder when the browser cannot preview');
});

test('missing photo: 404 page', async () => {
  const res = await get(`/photo/${'0'.repeat(64)}`, basic());
  assert.equal(res.status, 404);
  const html = await res.text();
  assertEnglishOnly(html, '404 page');
  assert.match(html, /Photo not found/);
});

test('live photo: the grid marks it and the paired video downloads', async () => {
  const { ref, videoHash } = await uploadLivePhoto(randomBytes(2048), randomBytes(8192), 'IMG_0006.HEIC');

  const grid = await (await get('/', basic())).text();
  assert.match(grid, /class="live"[^>]*>.*?LIVE<\/span>/, 'live photos carry a LIVE badge');

  const single = await (await get(`/photo/${ref}`, basic())).text();
  assert.match(single, new RegExp(`/v1/blob/${videoHash}\\?download=1`), 'the photo page links the paired video');
  assert.match(single, /Download Live Photo video/);
  assert.match(single, new RegExp(`Live video</dt><dd>[^<]+<span class="mono">${videoHash}</span>`));

  const video = await get(`/v1/blob/${videoHash}?download=1`, basic());
  assert.equal(video.status, 200);
  assert.equal(video.headers.get('content-type'), 'video/quicktime');
  assert.match(video.headers.get('content-disposition') ?? '', /\.mov/);
});

test('unknown ref: 404, no arbitrary bytes', async () => {
  const res = await get(`/v1/blob/${'0'.repeat(64)}`, basic());
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.match(html, /File not found/, 'a dead download link gets a 404 page, not a bare status');
  assertEnglishOnly(html, '404 page');
});
