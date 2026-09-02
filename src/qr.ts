const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

export type EccName = 'L' | 'M' | 'Q' | 'H';

export interface EccLevel {
  ordinal: number;
  formatBits: number;
}

export interface Matrix {
  modules: boolean[][];
  isFunction: boolean[][];
}

export interface QrCode {
  size: number;
  modules: boolean[][];
  version: number;
  ecc: EccName;
  mask: number;
}

export interface BlockStructure {
  numBlocks: number;
  blockEccLen: number;
  rawCodewords: number;
  numShortBlocks: number;
  shortBlockLen: number;
}

export const ECC_LEVELS: Record<EccName, EccLevel> = {
  L: { ordinal: 0, formatBits: 1 },
  M: { ordinal: 1, formatBits: 0 },
  Q: { ordinal: 2, formatBits: 3 },
  H: { ordinal: 3, formatBits: 2 },
};

const MIN_VERSION = 1;
const MAX_VERSION = 40;

const getBit = (value: number, i: number): boolean => ((value >>> i) & 1) !== 0;

export const sizeForVersion = (version: number): number => version * 4 + 17;

export function getNumRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

export function getNumDataCodewords(version: number, ecc: EccLevel): number {
  return (
    Math.floor(getNumRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ecc.ordinal][version] * NUM_ERROR_CORRECTION_BLOCKS[ecc.ordinal][version]
  );
}

export function getAlignmentPatternPositions(version: number): number[] {
  if (version === 1) return [];
  const size = sizeForVersion(version);
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((size - 13) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

export function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result: number[] = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

export function rsRemainder(data: number[], divisor: number[]): number[] {
  const result: number[] = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() ?? 0);
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMultiply(divisor[i], factor);
  }
  return result;
}

function appendBits(value: number, length: number, bits: number[]): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

const byteModeBits = (version: number, byteLength: number): number => 4 + (version <= 9 ? 8 : 16) + 8 * byteLength;

function chooseVersion(byteLength: number, ecc: EccLevel): number {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    if (byteModeBits(version, byteLength) <= getNumDataCodewords(version, ecc) * 8) return version;
  }
  throw new RangeError('Too much content to fit in a QR code');
}

function dataCodewords(data: number[], version: number, ecc: EccLevel): number[] {
  const bits: number[] = [];
  appendBits(0x4, 4, bits);
  appendBits(data.length, version <= 9 ? 8 : 16, bits);
  for (const b of data) appendBits(b, 8, bits);

  const capacity = getNumDataCodewords(version, ecc) * 8;
  appendBits(0, Math.min(4, capacity - bits.length), bits);
  appendBits(0, (8 - (bits.length % 8)) % 8, bits);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) appendBits(pad, 8, bits);

  const codewords: number[] = new Array(bits.length >>> 3).fill(0);
  bits.forEach((bit, i) => (codewords[i >>> 3] |= bit << (7 - (i & 7))));
  return codewords;
}

export function addEccAndInterleave(data: number[], version: number, ecc: EccLevel): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecc.ordinal][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc.ordinal][version];
  const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks: number[][] = [];
  const divisor = rsDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + datLen);
    k += dat.length;
    const ecc2 = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc2));
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
    }
  }
  return result;
}

function blankMatrix(size: number): Matrix {
  const modules = Array.from({ length: size }, (): boolean[] => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, (): boolean[] => new Array(size).fill(false));
  return { modules, isFunction };
}

function setFunction(m: Matrix, x: number, y: number, dark: boolean): void {
  m.modules[y][x] = dark;
  m.isFunction[y][x] = true;
}

function drawFinder(m: Matrix, size: number, x: number, y: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const xx = x + dx;
      const yy = y + dy;
      if (xx >= 0 && xx < size && yy >= 0 && yy < size) {
        setFunction(m, xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }
}

function drawAlignment(m: Matrix, x: number, y: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFunction(m, x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFormatBits(m: Matrix, size: number, ecc: EccLevel, mask: number): void {
  const data = (ecc.formatBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  for (let i = 0; i <= 5; i++) setFunction(m, 8, i, getBit(bits, i));
  setFunction(m, 8, 7, getBit(bits, 6));
  setFunction(m, 8, 8, getBit(bits, 7));
  setFunction(m, 7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i++) setFunction(m, 14 - i, 8, getBit(bits, i));

  for (let i = 0; i < 8; i++) setFunction(m, size - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i++) setFunction(m, 8, size - 15 + i, getBit(bits, i));
  setFunction(m, 8, size - 8, true);
}

function drawVersion(m: Matrix, size: number, version: number): void {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = getBit(bits, i);
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunction(m, a, b, dark);
    setFunction(m, b, a, dark);
  }
}

function drawFunctionPatterns(m: Matrix, size: number, version: number, ecc: EccLevel): void {
  for (let i = 0; i < size; i++) {
    setFunction(m, 6, i, i % 2 === 0);
    setFunction(m, i, 6, i % 2 === 0);
  }
  drawFinder(m, size, 3, 3);
  drawFinder(m, size, size - 4, 3);
  drawFinder(m, size, 3, size - 4);

  const positions = getAlignmentPatternPositions(version);
  const n = positions.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const corner = (i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0);
      if (!corner) drawAlignment(m, positions[i], positions[j]);
    }
  }

  drawFormatBits(m, size, ecc, 0);
  drawVersion(m, size, version);
}

function drawCodewords(m: Matrix, size: number, codewords: number[]): void {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!m.isFunction[y][x] && i < codewords.length * 8) {
          m.modules[y][x] = getBit(codewords[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

export const maskCondition = (mask: number, x: number, y: number): boolean => {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return (((x * y) % 2) + ((x * y) % 3)) === 0;
    case 6:
      return ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0;
    case 7:
      return (((((x + y) % 2) + ((x * y) % 3))) % 2) === 0;
    default:
      throw new RangeError('The mask must be 0–7');
  }
};

function applyMask(m: Matrix, size: number, mask: number): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!m.isFunction[y][x] && maskCondition(mask, x, y)) m.modules[y][x] = !m.modules[y][x];
    }
  }
}

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

function finderPenaltyAddHistory(runLength: number, history: number[], size: number): void {
  if (history[0] === 0) runLength += size;
  history.pop();
  history.unshift(runLength);
}

function finderPenaltyCountPatterns(history: number[]): number {
  const n = history[1];
  const core =
    n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
  return (
    (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
    (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
  );
}

function finderPenaltyTerminate(
  runColor: boolean,
  runLength: number,
  history: number[],
  size: number,
): number {
  if (runColor) {
    finderPenaltyAddHistory(runLength, history, size);
    runLength = 0;
  }
  runLength += size;
  finderPenaltyAddHistory(runLength, history, size);
  return finderPenaltyCountPatterns(history);
}

function penaltyScore(m: Matrix, size: number): number {
  const { modules } = m;
  let result = 0;

  for (let y = 0; y < size; y++) {
    let runColor = false;
    let runLen = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let x = 0; x < size; x++) {
      if (modules[y][x] === runColor) {
        runLen++;
        if (runLen === 5) result += PENALTY_N1;
        else if (runLen > 5) result++;
      } else {
        finderPenaltyAddHistory(runLen, history, size);
        if (!runColor) result += finderPenaltyCountPatterns(history) * PENALTY_N3;
        runColor = modules[y][x];
        runLen = 1;
      }
    }
    result += finderPenaltyTerminate(runColor, runLen, history, size) * PENALTY_N3;
  }

  for (let x = 0; x < size; x++) {
    let runColor = false;
    let runLen = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let y = 0; y < size; y++) {
      if (modules[y][x] === runColor) {
        runLen++;
        if (runLen === 5) result += PENALTY_N1;
        else if (runLen > 5) result++;
      } else {
        finderPenaltyAddHistory(runLen, history, size);
        if (!runColor) result += finderPenaltyCountPatterns(history) * PENALTY_N3;
        runColor = modules[y][x];
        runLen = 1;
      }
    }
    result += finderPenaltyTerminate(runColor, runLen, history, size) * PENALTY_N3;
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        result += PENALTY_N2;
      }
    }
  }

  let dark = 0;
  for (const row of modules) for (const c of row) if (c) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * PENALTY_N4;
  return result;
}

export function functionMap(version: number): boolean[][] {
  const size = sizeForVersion(version);
  const m = blankMatrix(size);
  drawFunctionPatterns(m, size, version, ECC_LEVELS.L);
  return m.isFunction;
}

export function blockStructure(version: number, ecc: EccName): BlockStructure {
  const level = ECC_LEVELS[ecc];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[level.ordinal][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[level.ordinal][version];
  const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
  return {
    numBlocks,
    blockEccLen,
    rawCodewords,
    numShortBlocks: numBlocks - (rawCodewords % numBlocks),
    shortBlockLen: Math.floor(rawCodewords / numBlocks),
  };
}

export function encodeQr(
  text: string,
  { ecc = 'L', mask }: { ecc?: EccName; mask?: number } = {},
): QrCode {
  const level = ECC_LEVELS[ecc];
  if (!level) throw new RangeError('The error correction level must be L, M, Q, or H');

  const data = Array.from(new TextEncoder().encode(text));
  const version = chooseVersion(data.length, level);
  const size = sizeForVersion(version);

  const codewords = addEccAndInterleave(dataCodewords(data, version, level), version, level);

  const base = blankMatrix(size);
  drawFunctionPatterns(base, size, version, level);
  drawCodewords(base, size, codewords);

  const chosen = mask ?? pickMask(base, size, level);
  applyMask(base, size, chosen);
  drawFormatBits(base, size, level, chosen);

  return { size, modules: base.modules, version, ecc, mask: chosen };
}

function pickMask(m: Matrix, size: number, ecc: EccLevel): number {
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(m, size, mask);
    drawFormatBits(m, size, ecc, mask);
    const score = penaltyScore(m, size);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
    applyMask(m, size, mask);
  }
  return best;
}

export interface QrSvgOptions {
  ecc?: EccName;
  scale?: number;
  margin?: number;
  dark?: string;
  light?: string;
}

export function qrSvg(
  text: string,
  { ecc = 'L', scale = 4, margin = 4, dark = '#000', light = '#fff' }: QrSvgOptions = {},
): string {
  const { size, modules } = encodeQr(text, { ecc });
  const dim = size + margin * 2;

  let path = '';
  for (let y = 0; y < size; y++) {
    let run = 0;
    for (let x = 0; x <= size; x++) {
      const on = x < size && modules[y][x];
      if (on) {
        run++;
      } else if (run > 0) {
        path += `M${x - run + margin} ${y + margin}h${run}v1h-${run}z`;
        run = 0;
      }
    }
  }

  const px = dim * scale;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" ` +
    `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/>` +
    `</svg>`
  );
}

export function qrTerminal(
  text: string,
  { ecc = 'L', margin = 2 }: { ecc?: EccName; margin?: number } = {},
): string {
  const { size, modules } = encodeQr(text, { ecc });
  const dim = size + margin * 2;
  const at = (x: number, y: number): boolean => {
    const mx = x - margin;
    const my = y - margin;
    return mx >= 0 && mx < size && my >= 0 && my < size ? modules[my][mx] : false;
  };
  const paint = (dark: boolean): string => (dark ? '0;0;0' : '255;255;255');

  const lines: string[] = [];
  for (let y = 0; y < dim; y += 2) {
    let line = '';
    for (let x = 0; x < dim; x++) {
      const top = at(x, y);
      const bottom = at(x, y + 1);
      line += `\x1b[38;2;${paint(top)}m\x1b[48;2;${paint(bottom)}m▀`;
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join('\n');
}
