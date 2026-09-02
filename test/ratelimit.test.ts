import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, FORM_HEADERS, form } from './support.ts';
import type { TestServer } from './support.ts';
import { createRateLimiter } from '../src/ratelimit.ts';

test('rejects at the limit and allows again once the window slides', () => {
  let now = 1000;
  const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: () => now });

  assert.equal(limiter.check('ip'), true);
  assert.equal(limiter.check('ip'), true);
  assert.equal(limiter.check('ip'), true);
  assert.equal(limiter.check('ip'), false, 'the 4th request is over the limit');

  assert.equal(limiter.check('other'), true);

  now += 1001;
  assert.equal(limiter.check('ip'), true, 'allowed again after the window');
});

test('sweep removes keys that fell out of the window', () => {
  let now = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 100, now: () => now });
  limiter.check('a');
  now += 200;
  limiter.sweep();
  assert.equal(limiter.check('a'), true);
});

let running: TestServer;

before(async () => {
  running = await startServer({ mode: 'exchange' });
});

after(async () => {
  await running.stop();
});

test('/v1/auth returns 429 after the default quota (30)', async () => {
  const statuses = [];
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${running.origin}/v1/auth`, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: form({ Token: 'wrong-on-purpose' }),
    });
    statuses.push(res.status);
    await res.text();
  }
  assert.ok(
    statuses.slice(0, 30).every((s) => s === 401),
    'requests within the quota are handled normally (wrong credential here, so 401)',
  );
  assert.ok(
    statuses.slice(30).every((s) => s === 429),
    '429 once over the quota',
  );
});

test('/v1/register is rate limited too: 429 with Retry-After once over the quota', async () => {
  const fresh = await startServer({ mode: 'exchange' });
  try {
    const statuses = [];
    let retryAfter = null;
    for (let i = 0; i < 35; i++) {
      const res = await fetch(`${fresh.origin}/v1/register`, {
        method: 'POST',
        headers: { ...FORM_HEADERS, authorization: `Bearer ${fresh.token}` },
        body: form({ public_key: 'not-a-key' }),
      });
      statuses.push(res.status);
      if (res.status === 429) retryAfter = res.headers.get('retry-after');
      await res.text();
    }
    assert.ok(statuses.slice(0, 30).every((s) => s === 400), 'handled normally within the quota (bad public key, so 400)');
    assert.ok(statuses.slice(30).every((s) => s === 429), '429 once over the quota');
    assert.ok(Number(retryAfter) > 0, 'tells the client when to retry');
  } finally {
    await fresh.stop();
  }
});

test('browse pages: wrong guesses are rate limited, successful logins are not counted', async () => {
  const fresh = await startServer();
  try {
    const wrong = { authorization: `Basic ${Buffer.from(':wrong').toString('base64')}` };
    const right = { authorization: `Basic ${Buffer.from(`:${fresh.token}`).toString('base64')}` };

    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${fresh.origin}/`, { headers: right });
      assert.equal(res.status, 200);
      await res.text();
    }

    const statuses = [];
    let lastPage = '';
    for (let i = 0; i < 35; i++) {
      const res = await fetch(`${fresh.origin}/`, { headers: wrong });
      statuses.push(res.status);
      lastPage = await res.text();
    }
    assert.ok(statuses.slice(0, 30).every((s) => s === 401));
    assert.ok(statuses.slice(30).every((s) => s === 429), '429 after too many wrong guesses');
    assert.match(lastPage, /Too many attempts/, '429 returns an explanatory page, not a bare status');
  } finally {
    await fresh.stop();
  }
});

async function exhaust(origin: string, forwardedFor: string, times: number): Promise<number[]> {
  const statuses = [];
  for (let i = 0; i < times; i++) {
    const res = await fetch(`${origin}/v1/auth`, {
      method: 'POST',
      headers: { ...FORM_HEADERS, 'x-forwarded-for': forwardedFor },
      body: form({ Token: 'wrong-on-purpose' }),
    });
    statuses.push(res.status);
    await res.text();
  }
  return statuses;
}

test('forwarding headers are not trusted by default: rotating X-Forwarded-For does not dodge the limit', async () => {
  const fresh = await startServer({ mode: 'exchange' });
  try {
    const statuses = [];
    for (let i = 0; i < 35; i++) statuses.push(...(await exhaust(fresh.origin, `10.0.0.${i}`, 1)));
    assert.ok(statuses.slice(30).every((s) => s === 429), 'forwarding headers can be forged, so they are ignored by default');
  } finally {
    await fresh.stop();
  }
});

test('trustProxy: buckets by the rightmost forwarded hop, so one source does not affect others', async () => {
  const fresh = await startServer({ mode: 'exchange', trustProxy: true });
  try {
    const a = await exhaust(fresh.origin, '203.0.113.1', 31);
    assert.equal(a.at(-1), 429, 'A is over the limit');
    const spoofed = await exhaust(fresh.origin, '198.51.100.9, 203.0.113.1', 1);
    assert.equal(spoofed[0], 429, 'whatever is on the left, the rightmost hop is still A');
    const b = await exhaust(fresh.origin, '203.0.113.2', 1);
    assert.equal(b[0], 401, 'B is not affected by A (wrong credential, so 401)');
  } finally {
    await fresh.stop();
  }
});
