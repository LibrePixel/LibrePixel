import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { BindingClient, FORM_HEADERS, form, parseFields, startServer } from './support.ts';
import type { TestServer } from './support.ts';
import type { BindingConfig } from '../src/auth.ts';

let running: TestServer;
let binding: BindingConfig;

before(async () => {
  running = await startServer({ mode: 'exchange' });
  binding = running.binding;
});

after(async () => {
  await running.stop();
});

const spki = async (client: BindingClient) => Buffer.from(await client.publicKeySPKI()).toString('base64url');

const register = (body: string) =>
  fetch(`${running.origin}/v1/register`, {
    method: 'POST',
    headers: { ...FORM_HEADERS, authorization: `Bearer ${running.token}` },
    body,
  });

let deviceA: BindingClient;

test('first device: with no bound keys yet, bare registration (long-term credential only) succeeds', async () => {
  deviceA = await BindingClient.create();
  const res = await register(form({ public_key: await spki(deviceA), label: 'A' }));
  assert.equal(res.status, 200);
  assert.equal(parseFields(await res.text()).Issuer, await deviceA.issuer());
});

test('once a key exists, bare registration is rejected (binding_required)', async () => {
  const stranger = await BindingClient.create();
  const res = await register(form({ public_key: await spki(stranger) }));
  assert.equal(res.status, 401);
  assert.equal(parseFields(await res.text()).Error, 'binding_required');
  assert.equal(await running.index.bindingKey(await stranger.issuer()), null);
});

test('a second device registers with an assertion signed by a registered device', async () => {
  const deviceB = await BindingClient.create();
  const approval = await deviceA.assertionJWT({ binding, keyID: 0x2001 });
  const res = await register(
    form({ public_key: await spki(deviceB), label: 'B', [binding.assertionField]: approval }),
  );
  assert.equal(res.status, 200);
  assert.equal(parseFields(await res.text()).Issuer, await deviceB.issuer());
  assert.equal((await running.index.listBindingKeys()).length, 2, 'two devices now');
});

test('an assertion signed by an unknown key is rejected (unknown_key)', async () => {
  const stranger = await BindingClient.create();
  const newDevice = await BindingClient.create();
  const approval = await stranger.assertionJWT({ binding, keyID: 0x2002 });
  const res = await register(
    form({ public_key: await spki(newDevice), [binding.assertionField]: approval }),
  );
  assert.equal(res.status, 401);
  assert.equal(parseFields(await res.text()).Error, 'unknown_key');
});

test('after unbind all, the server is back to the first-device state and bare registration works again', async () => {
  const removed = await running.index.deleteAllBindingKeys();
  assert.equal(removed, 2, 'both devices unbound');
  assert.equal((await running.index.listBindingKeys()).length, 0);

  const fresh = await BindingClient.create();
  const res = await register(form({ public_key: await spki(fresh), label: 'fresh' }));
  assert.equal(res.status, 200, 'after clearing, the first device can register bare again');
});
