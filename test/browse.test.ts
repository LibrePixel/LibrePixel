import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { startServer } from './support.ts';
import type { TestServer } from './support.ts';
import { Writer, looksLikeUploadResponse } from '../src/protobuf.ts';
import { handleBrowse } from '../src/browse.ts';
import type { AlbumSource, BrowseContext, BrowseRequest, BrowseResponse } from '../src/browse.ts';

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
    const headerHtml = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    assert.doesNotMatch(headerHtml, new RegExp(new URL(fresh.origin).host.replaceAll('.', '\\.')), 'the header does not show the server address');
    assert.match(html, new RegExp(`<b>LibrePixel</b><div><span>Server</span><code>${fresh.origin}</code>`), 'server address for the app');
    assert.match(html, /Password: the one you signed in with\./);
  } finally {
    await fresh.stop();
  }
});

async function render(req: BrowseRequest, url: string, ctx: Partial<BrowseContext> = {}) {
  let status = 0;
  let headers: Record<string, unknown> = {};
  let body = '';
  const res = {
    writeHead(code: number, h: Record<string, unknown> = {}) {
      status = code;
      headers = h;
      return this;
    },
    end(chunk?: string) {
      body = String(chunk ?? '');
    },
  } as unknown as BrowseResponse;
  await handleBrowse(req, res, new URL(url, running.origin), { ...running, ...ctx });
  return { status, headers, body };
}

function formRequest(fields: Record<string, string>, headers: Record<string, string> = {}): BrowseRequest {
  const body = new URLSearchParams(fields).toString();
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    async *[Symbol.asyncIterator]() {
      yield new TextEncoder().encode(body);
    },
  };
}

const signIn = (origin: string, password: string, next = '/') =>
  fetch(`${origin}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password, next }),
  });

const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0];

test('no credentials: pages redirect to the sign-in form, with no Basic auth prompt', async () => {
  const res = await fetch(`${running.origin}/photo/${'a'.repeat(64)}`, { redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/login?next=${encodeURIComponent(`/photo/${'a'.repeat(64)}`)}`);
  assert.equal(res.headers.get('www-authenticate'), null);

  const page = await get('/login');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('www-authenticate'), null);
  const html = await page.text();
  assertEnglishOnly(html, 'sign-in page');
  assert.match(html, /<form method="post" action="\/login">/);
  assert.match(html, /<input id="password" name="password" type="password" autocomplete="current-password"/);
  assert.match(html, />Sign in<\/button>/);
  assert.match(html, /The same password connects the app\./);
  assert.doesNotMatch(html, /isn't right/, 'no error before a password is tried');
});

test('sign in: the right password sets a session cookie and returns to the page', async () => {
  const res = await signIn(running.origin, running.token, '/photo/abc?x=1');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/photo/abc?x=1');
  const setCookie = res.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /^librepixel_session=\d+\.[\w-]{43}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax$/);
  assert.doesNotMatch(setCookie, /Secure/, 'plain-http servers cannot keep a Secure cookie');
  assert.ok(!setCookie.includes(running.token), 'the cookie never contains the password');

  const cookie = { cookie: cookieOf(res) };
  const grid = await get('/', cookie);
  assert.equal(grid.status, 200);
  assert.match(await grid.text(), /<form class="signout" method="post" action="\/logout">/);
  const ref = await uploadPhoto(randomBytes(256), 'IMG_COOKIE.JPG');
  assert.equal((await get(`/v1/blob/${ref}`, cookie)).status, 200, 'images load with the cookie');

  const signedIn = await fetch(`${running.origin}/login?next=/photo/x`, { headers: cookie, redirect: 'manual' });
  assert.equal(signedIn.status, 303, 'an open sign-in page goes straight back when already signed in');
  assert.equal(signedIn.headers.get('location'), '/photo/x');
});

test('sign in: tampered, expired or foreign cookies are refused', async () => {
  const good = cookieOf(await signIn(running.origin, running.token));
  const [, value] = good.split('=');
  const [expires, mac] = value.split('.');
  const flip = (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1);
  for (const cookie of [
    `librepixel_session=${expires}.${flip}`,
    `librepixel_session=${Number(expires) + 1}.${mac}`,
    `librepixel_session=1.${mac}`,
    'librepixel_session=garbage',
  ]) {
    const res = await fetch(`${running.origin}/`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(res.status, 303, cookie);
  }
  const other = await startServer();
  try {
    const res = await fetch(`${other.origin}/`, { headers: { cookie: good }, redirect: 'manual' });
    assert.equal(res.status, 303, "another server's cookie does not work here");
  } finally {
    await other.stop();
  }
});

test('sign in: a wrong password shows an error and the operator hint', async () => {
  const res = await signIn(running.origin, 'not-the-token');
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
  const html = await res.text();
  assert.match(html, /That password isn't right\./);
  assert.match(html, /<code>token<\/code> file in the data directory/);
});

test('sign in: the wrong-password hint can be replaced or removed, and is escaped', async () => {
  const replaced = await render(formRequest({ password: 'nope' }), '/login', {
    passwordHint: 'the one in the <private> notes.',
  });
  assert.equal(replaced.status, 401);
  assert.match(replaced.body, /<p class="help">the one in the &lt;private&gt; notes\.<\/p>/);
  assert.doesNotMatch(replaced.body, /data directory/);
  const none = await render(formRequest({ password: 'nope' }), '/login', { passwordHint: '' });
  assert.match(none.body, /That password isn't right\./);
  assert.doesNotMatch(none.body, /class="help"/);
});

test('sign in: only same-site paths are followed after signing in', async () => {
  for (const next of ['//evil.example/', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)']) {
    const res = await signIn(running.origin, running.token, next);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/', next);
  }
});

test('sign in: Secure cookie on https, and the cookie key can be separate from the token', async () => {
  const https = await render(formRequest({ password: running.token }), '/login', { origin: 'https://photos.example' });
  assert.match(String(https.headers['set-cookie']), /; Secure$/);
  const forced = await render(formRequest({ password: running.token }), '/login', { secureCookie: true });
  assert.match(String(forced.headers['set-cookie']), /; Secure$/);

  const keyed = await render(formRequest({ password: running.token }), '/login', { sessionSecret: 'separate-key' });
  const cookie = String(keyed.headers['set-cookie']).split(';')[0];
  assert.equal((await render({ headers: { cookie } }, '/', { sessionSecret: 'separate-key' })).status, 200);
  assert.equal((await render({ headers: { cookie } }, '/')).status, 303, 'a different key refuses it');
});

test('sign out clears the session cookie', async () => {
  const res = await fetch(`${running.origin}/logout`, { method: 'POST', redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/login');
  assert.match(res.headers.get('set-cookie') ?? '', /^librepixel_session=; Path=\/; Max-Age=0; HttpOnly; SameSite=Lax/);
});

test('sign in: wrong passwords are rate limited per client', async () => {
  const fresh = await startServer();
  try {
    for (let i = 0; i < 30; i++) assert.equal((await signIn(fresh.origin, `wrong-${i}`)).status, 401);
    const blocked = await signIn(fresh.origin, fresh.token);
    assert.equal(blocked.status, 429, 'even the right password waits once the limit is hit');
    assert.equal(blocked.headers.get('retry-after'), '60');
    assert.equal(blocked.headers.get('set-cookie'), null);
    assert.match(await blocked.text(), /Too many attempts/);
  } finally {
    await fresh.stop();
  }
});

test('other sources: their files join the library with source labels, tabs and connection rows', async () => {
  const fresh = await startServer();
  try {
    const bytes = randomBytes(300);
    const digest = sha256(bytes);
    const ticket = await fetch(`${fresh.origin}/v1/upload-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fresh.token}`, 'x-content-hash': `sha256=${digest.toString('base64')}` },
      body: new Writer().varint(7, bytes.length).buffer,
    });
    const put = await fetch(`${fresh.origin}/v1/upload?upload_id=${ticket.headers.get('x-upload-id')}`, { method: 'PUT', body: bytes });
    const echoed = new Uint8Array(await put.arrayBuffer());
    const main = new Writer().bytes(1, echoed).string(2, 'OWN.JPG').bytes(3, digest)
      .message(4, new Writer().varint(1, 1_757_000_000).varint(3, 1_690_000_000));
    await fetch(`${fresh.origin}/v1/commit`, {
      method: 'POST', headers: { authorization: `Bearer ${fresh.token}` }, body: new Writer().message(1, main).buffer,
    });

    const asked: number[] = [];
    const dav: AlbumSource = {
      id: 'webdav',
      name: 'WebDAV',
      connect: [['URL', 'https://photos.example/webdav/'], ['Username', 'any']],
      async files(limit) {
        asked.push(limit);
        return {
          total: 2,
          files: [
            { name: 'a<b>.jpg', size: 10, uploadedAt: 1_760_000_000, url: '/file/dav/a.jpg', download: '/file/dav/a.jpg?download=1', kind: 'image' },
            { name: 'clip.mov', size: 2048, uploadedAt: 1_750_000_000, url: '/file/dav/clip.mov', download: '/file/dav/clip.mov?download=1', kind: 'video' },
          ],
        };
      },
    };
    const s3: AlbumSource = {
      id: 's3', name: 'S3', connect: [['Endpoint', 'https://photos.example/s3'], ['Bucket', 'photos']],
      async files() { return { total: 0, files: [] }; },
    };
    const ctx = { ...fresh, sources: [dav, s3] };
    const auth = { headers: { authorization: `Bearer ${fresh.token}` } };
    const all = await render(auth, '/', ctx);
    assert.equal(all.status, 200);
    assertEnglishOnly(all.body, 'library with sources');
    assert.deepEqual(asked, [200]);
    assert.match(all.body, /<span class="count">3 items<\/span>/);
    assert.match(all.body, /<a class="tab" href="\/" aria-current="page">All<span>3<\/span><\/a>/);
    assert.match(all.body, /href="\/\?source=librepixel">LibrePixel<span>1<\/span>/);
    assert.match(all.body, /href="\/\?source=webdav">WebDAV<span>2<\/span>/);
    assert.match(all.body, /href="\/\?source=s3">S3<span>0<\/span>/);
    assert.match(all.body, /<img loading="lazy" src="\/file\/dav\/a\.jpg" alt="a&lt;b&gt;\.jpg"/);
    assert.match(all.body, /href="\/file\/dav\/clip\.mov\?download=1"[^>]*download>.*?Video · 2\.0 KB · Download.*?<span class="src">WebDAV<\/span>/);
    assert.match(all.body, /OWN\.JPG.*?<span class="src">LibrePixel<\/span>/);
    assert.ok(all.body.indexOf('a&lt;b&gt;.jpg') < all.body.indexOf('clip.mov'), 'newest first');
    assert.ok(all.body.indexOf('clip.mov') < all.body.indexOf('OWN.JPG'), 'merged by time');
    assert.match(all.body, /<b>LibrePixel<\/b><div><span>Server<\/span><code>[^<]+<\/code><\/div><\/div>/);
    assert.match(all.body, /<b>WebDAV<\/b><div><span>URL<\/span><code>https:\/\/photos\.example\/webdav\/<\/code><\/div><div><span>Username<\/span><code>any<\/code>/);
    assert.match(all.body, /<b>S3<\/b><div><span>Endpoint<\/span>/);
    assert.match(all.body, /Password everywhere: the one you signed in with\./);
    assert.match(all.body, /id="connection-info"[^>]*value="lp1z?\./, 'the connection info is still offered');

    const onlyDav = await render(auth, '/?source=webdav', ctx);
    assert.match(onlyDav.body, /href="\/\?source=webdav" aria-current="page"/);
    assert.match(onlyDav.body, /clip\.mov/);
    assert.doesNotMatch(onlyDav.body, /OWN\.JPG/);
    const empty = await render(auth, '/?source=s3', ctx);
    assert.match(empty.body, /Nothing from S3 yet\./);
    const unknown = await render(auth, '/?source=nope', ctx);
    assert.match(unknown.body, /<a class="tab" href="\/" aria-current="page">All/);

    const plain = await render(auth, '/', fresh);
    assert.doesNotMatch(plain.body, /class="tabs"|class="src"/, 'no tabs or labels with a single source');
  } finally {
    await fresh.stop();
  }
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
