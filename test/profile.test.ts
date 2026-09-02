import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import { buildProfile, decodeProfile, encodeProfile, setupLink } from '../src/profile.ts';

const ORIGIN = 'http://192.168.1.10:8788';
const TOKEN = 'a'.repeat(43);

test('encode then decode keeps every field', () => {
  const profile = buildProfile(ORIGIN, TOKEN);
  const decoded = decodeProfile(encodeProfile(profile));
  assert.deepEqual(decoded, profile);
});

test('both compressed and uncompressed codes decode', () => {
  const profile = buildProfile(ORIGIN, TOKEN);
  const raw = Buffer.from(JSON.stringify(profile));

  const plain = `lp1.${raw.toString('base64url')}`;
  const packed = `lp1z.${deflateRawSync(raw, { level: 9 }).toString('base64url')}`;
  assert.deepEqual(decodeProfile(plain), profile);
  assert.deepEqual(decodeProfile(packed), profile);

  assert.ok(encodeProfile(profile).startsWith('lp1z.'), 'uses the compressed form when it is shorter');
});

test('the link form from the QR code is accepted', () => {
  const profile = buildProfile(ORIGIN, TOKEN);
  const link = setupLink(encodeProfile(profile));
  assert.ok(link.startsWith('librepixel://setup?code='));
  assert.deepEqual(decodeProfile(link), profile);

  assert.deepEqual(decodeProfile(`${link.slice(0, 40)}\n  ${link.slice(40)}`), profile);
});

test('rejects anything that is not connection info', () => {
  assert.throws(() => decodeProfile('https://example.com'), /connection info/);
});

test('bearer mode: the token is used directly as a bearer token, no exchange step', () => {
  const profile = buildProfile(ORIGIN, TOKEN);
  assert.equal(profile.auth.mode, 'bearer');
  assert.equal('binding' in profile.auth, false);
  assert.equal(profile.credential.Token, TOKEN);
  assert.equal(profile.endpoints.uploadBytes, `${ORIGIN}/v1/upload?upload_id={token}`);
  assert.equal(profile.headers.hashFormat, 'sha256={base64}');
});

test('limits: the cap matches --max-upload and no types are restricted', () => {
  const profile = buildProfile(ORIGIN, TOKEN, { maxUploadBytes: 64 * 1024 * 1024 });
  assert.deepEqual(profile.limits, {
    photoMaxBytes: 64 * 1024 * 1024,
    videoMaxBytes: 64 * 1024 * 1024,
  });

  assert.equal('photoTypes' in profile.limits, false);
  assert.equal('videoTypes' in profile.limits, false);

  assert.deepEqual(decodeProfile(encodeProfile(profile)).limits, profile.limits);
});

test('exchange mode: every binding name is present', () => {
  const profile = buildProfile(ORIGIN, TOKEN, { mode: 'exchange' });
  const { auth } = profile;

  assert.equal(auth.mode, 'exchange');
  assert.equal(auth.url, `${ORIGIN}/v1/auth`);
  assert.deepEqual(auth.form, [['Token', 'cred:Token']]);
  assert.deepEqual(auth.response, {
    token: 'Auth',
    expiry: 'Expiry',
    encrypted: 'TokenEncrypted',
    error: 'Error',
  });

  assert.ok(auth.binding.keysetTypeUrl, 'binding.keysetTypeUrl is sent');
  assert.ok(auth.binding.assertionField, 'binding.assertionField is sent');
  assert.equal(auth.binding.audience, `${ORIGIN}/v1/auth`);
  assert.equal(auth.binding.register, `${ORIGIN}/v1/register`);
  assert.ok(auth.binding.aliasPrefix && auth.binding.namespace);
  assert.ok(auth.binding.publicKeyType && auth.binding.aeadType);

  assert.deepEqual(decodeProfile(encodeProfile(profile)), profile);
});
