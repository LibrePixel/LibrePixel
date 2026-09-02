import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { BindingClient, FORM_HEADERS, form, parseFields, startServer } from './support.ts';
import type { TestServer } from './support.ts';
import type { BindingConfig } from '../src/auth.ts';
import { Writer } from '../src/protobuf.ts';

let running: TestServer;
let binding: BindingConfig;

before(async () => {
  running = await startServer({ mode: 'exchange' });
  binding = running.binding;
});

after(async () => {
  await running.stop();
});

const post = (path: string, body: string) =>
  fetch(`${running.origin}${path}`, { method: 'POST', headers: FORM_HEADERS, body });

const authed = (path: string, body: string, token: string) =>
  fetch(`${running.origin}${path}`, {
    method: 'POST',
    headers: { ...FORM_HEADERS, authorization: `Bearer ${token}` },
    body,
  });

async function useToken(token: string): Promise<number> {
  const body = new Writer()
    .message(1, new Writer().message(1, new Writer().bytes(1, new Uint8Array(32))).empty(2)).buffer;
  const response = await fetch(`${running.origin}/v1/find`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-protobuf' },
    body,
  });
  return response.status;
}

async function exchange(fields: Record<string, string>) {
  const response = await post('/v1/auth', form(fields));
  return { status: response.status, fields: parseFields(await response.text()) };
}

let owner: BindingClient;
let nextKeyID = 0x1000;
const spki = async (client: BindingClient) => Buffer.from(await client.publicKeySPKI()).toString('base64url');

async function registerFirst(client: BindingClient, label: string) {
  const res = await authed('/v1/register', form({ public_key: await spki(client), label }), running.token);
  if (res.status === 200) owner = client;
  return res;
}

async function registerWith(client: BindingClient, label = '') {
  const jwt = await owner.assertionJWT({ binding, keyID: nextKeyID++ });
  return authed(
    '/v1/register',
    form({ public_key: await spki(client), label, [binding.assertionField]: jwt }),
    running.token,
  );
}

test('the long-term credential cannot be used directly as a bearer token', async () => {
  assert.equal(await useToken(running.token), 401);
});

test('a wrong credential gets no token', async () => {
  const wrong = await exchange({ Token: 'not-the-token' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.fields.Error, 'bad_credential');
});

test('before any public key is registered, the exchange returns a plaintext token that works', async () => {
  const got = await exchange({ Token: running.token });
  assert.equal(got.status, 200);
  assert.ok(got.fields.Auth);
  assert.equal(got.fields.TokenEncrypted, undefined, 'no binding means no encryption');
  assert.ok(Number(got.fields.Expiry) > Math.floor(Date.now() / 1000));
  assert.equal(await useToken(got.fields.Auth), 200);
});

test('register a public key, exchange with an assertion, decrypt the token', async () => {
  const client = await BindingClient.create();
  const keyID = 0x7f3a21c4;

  const registered = await registerFirst(client, 'test');
  assert.equal(registered.status, 200);
  const issuer = parseFields(await registered.text()).Issuer;
  assert.equal(issuer, await client.issuer(), 'the server-computed iss matches the client');

  const jwt = await client.assertionJWT({ binding, keyID });
  const got = await exchange({ Token: running.token, [binding.assertionField]: jwt });
  assert.equal(got.status, 200);
  assert.equal(got.fields.TokenEncrypted, '1', 'a bound device must get an encrypted token');

  const { token, hasPrefix } = await client.unseal(got.fields.Auth, keyID);
  assert.equal(hasPrefix, true, 'the ciphertext starts with 0x01 || key id');
  assert.equal(await useToken(token), 200, 'the decrypted token works');
});

test('after registration, requests without an assertion are rejected', async () => {
  const got = await exchange({ Token: running.token });
  assert.equal(got.status, 401);
  assert.equal(got.fields.Error, 'binding_required');
});

test('an assertion signed by an unregistered key is rejected', async () => {
  const stranger = await BindingClient.create();
  const jwt = await stranger.assertionJWT({ binding, keyID: 1 });
  const got = await exchange({ Token: running.token, [binding.assertionField]: jwt });
  assert.equal(got.status, 401);
  assert.equal(got.fields.Error, 'unknown_key');
});

test('a tampered signature is rejected', async () => {
  const client = await BindingClient.create();
  await registerWith(client);

  const jwt = await client.assertionJWT({ binding, keyID: 2 });
  const [header, payload, signature] = jwt.split('.');
  const flipped = `${signature.slice(0, -2)}${signature.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
  const got = await exchange({
    Token: running.token,
    [binding.assertionField]: `${header}.${payload}.${flipped}`,
  });
  assert.equal(got.status, 401);
  assert.equal(got.fields.Error, 'bad_assertion');
});

test('an assertion meant for another server is rejected', async () => {
  const client = await BindingClient.create();
  await registerWith(client);

  const jwt = await client.assertionJWT({
    binding,
    keyID: 3,
    overrides: { aud: 'http://somewhere.else/v1/auth' },
  });
  const got = await exchange({ Token: running.token, [binding.assertionField]: jwt });
  assert.equal(got.status, 401);
  assert.equal(got.fields.Error, 'bad_assertion');
});

test('a stale assertion is rejected', async () => {
  const client = await BindingClient.create();
  await registerWith(client);

  const jwt = await client.assertionJWT({
    binding,
    keyID: 4,
    now: Math.floor(Date.now() / 1000) - 3600,
  });
  const got = await exchange({ Token: running.token, [binding.assertionField]: jwt });
  assert.equal(got.status, 401);
  assert.equal(got.fields.Error, 'stale_assertion');
});

test('registration needs the long-term credential and a real public key', async () => {
  const client = await BindingClient.create();
  const publicKey = Buffer.from(await client.publicKeySPKI()).toString('base64url');

  const anonymous = await post('/v1/register', form({ public_key: publicKey }));
  assert.equal(anonymous.status, 401);

  const garbage = await authed('/v1/register', form({ public_key: 'bm90LWEta2V5' }), running.token);
  assert.equal(garbage.status, 400);
  assert.equal(parseFields(await garbage.text()).Error, 'bad_public_key');
});

test('short-lived tokens expire and expired ones are purged', async () => {
  const client = await BindingClient.create();
  await registerWith(client);
  const keyID = 5;
  const got = await exchange({
    Token: running.token,
    [binding.assertionField]: await client.assertionJWT({ binding, keyID }),
  });
  assert.equal(got.status, 200);

  const { token } = await client.unseal(got.fields.Auth, keyID);
  assert.equal(await useToken(token), 200);

  await running.db.run('UPDATE sessions SET expires_at = ? WHERE token = ?', [
    Date.now() - 1000,
    token,
  ]);
  assert.equal(await useToken(token), 401);

  await running.sweep();
  const left = await running.db.all('SELECT COUNT(*) AS n FROM sessions WHERE token = ?', [token]);
  assert.equal(left[0].n, 0, 'expired short-lived tokens are purged');
});
