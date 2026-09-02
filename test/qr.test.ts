import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeQr,
  qrSvg,
  functionMap,
  blockStructure,
  maskCondition,
  gfMultiply,
  sizeForVersion,
} from '../src/qr.ts';
import type { EccName, QrCode } from '../src/qr.ts';
import { buildProfile, encodeProfile, setupLink } from '../src/profile.ts';

const EXP: number[] = new Array(512);
const LOG: number[] = new Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = gfMultiply(x, 2);
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gfPow = (base: number, exp: number): number => (base === 0 ? 0 : EXP[(LOG[base] * exp) % 255]);

function readCodewords(qr: QrCode): number[] {
  const { size, modules, version, mask } = qr;
  const isFn = functionMap(version);
  const m = modules.map((row) => row.slice());
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFn[y][x] && maskCondition(mask, x, y)) m[y][x] = !m[y][x];
    }
  }

  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const cx = right - j;
        const upward = ((right + 1) & 2) === 0;
        const cy = upward ? size - 1 - vert : vert;
        if (!isFn[cy][cx]) bits.push(m[cy][cx] ? 1 : 0);
      }
    }
  }

  const codewords: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
    codewords.push(b);
  }
  return codewords;
}

function deinterleave(codewords: number[], version: number, ecc: EccName) {
  const { numBlocks, blockEccLen, numShortBlocks, shortBlockLen } = blockStructure(version, ecc);
  const dataLens: number[] = [];
  for (let i = 0; i < numBlocks; i++) {
    dataLens.push(shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
  }
  const data = dataLens.map((): number[] => []);
  const ecc2 = dataLens.map((): number[] => []);

  let idx = 0;
  const maxData = Math.max(...dataLens);
  for (let i = 0; i < maxData; i++) {
    for (let j = 0; j < numBlocks; j++) if (i < dataLens[j]) data[j].push(codewords[idx++]);
  }
  for (let i = 0; i < blockEccLen; i++) {
    for (let j = 0; j < numBlocks; j++) ecc2[j].push(codewords[idx++]);
  }
  return { data, ecc2, blockEccLen };
}

function syndromesZero(block: number[], blockEccLen: number): boolean {
  for (let s = 0; s < blockEccLen; s++) {
    let acc = 0;
    const root = gfPow(2, s);
    for (const c of block) acc = gfMultiply(acc, root) ^ c;
    if (acc !== 0) return false;
  }
  return true;
}

function roundTrip(text: string, ecc: EccName) {
  const qr = encodeQr(text, { ecc });
  const { data, ecc2, blockEccLen } = deinterleave(readCodewords(qr), qr.version, ecc);
  for (let i = 0; i < data.length; i++) {
    assert.ok(
      syndromesZero([...data[i], ...ecc2[i]], blockEccLen),
      `block ${i} error-correction syndromes are zero (v${qr.version} ${ecc})`,
    );
  }

  const bytes = data.flat();
  const bits: number[] = [];
  for (const b of bytes) for (let k = 7; k >= 0; k--) bits.push((b >> k) & 1);
  let p = 0;
  const take = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | bits[p++];
    return v;
  };
  assert.equal(take(4), 0x4, 'the mode indicator is byte mode');
  const len = take(qr.version <= 9 ? 8 : 16);
  const out = [];
  for (let i = 0; i < len; i++) out.push(take(8));
  return { version: qr.version, text: new TextDecoder().decode(new Uint8Array(out)) };
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.';
const rnd = (n: number): string =>
  Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');

test('random text round-trips at all four error-correction levels across versions', () => {
  for (const ecc of ['L', 'M', 'Q', 'H'] as const) {
    for (const n of [1, 5, 20, 80, 160, 320, 448, 640]) {
      const text = rnd(n);
      const got = roundTrip(text, ecc);
      assert.equal(got.text, text, `ecc=${ecc} n=${n} round-trips`);
    }
  }
});

test('a real connection link encodes to QR and decodes back', () => {
  const link = setupLink(encodeProfile(buildProfile('http://192.168.1.10:8788', 'a'.repeat(43), { mode: 'exchange' })));
  const got = roundTrip(link, 'L');
  assert.equal(got.text, link);
});

test('matrix size and finder patterns match the version', () => {
  const qr = encodeQr('hello', { ecc: 'M' });
  assert.equal(qr.size, sizeForVersion(qr.version));
  assert.equal(qr.modules.length, qr.size);
  assert.equal(qr.modules[0][0], true);
  assert.equal(qr.modules[1][1], false);
  assert.equal(qr.modules[3][3], true);
});

test('the SVG is self-contained and embeddable', () => {
  const svg = qrSvg('librepixel://setup?code=lp1.abc', { scale: 4, margin: 4 });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('</svg>'));
  assert.ok(svg.includes('<path'));
  assert.ok(/viewBox="0 0 \d+ \d+"/.test(svg));
});
