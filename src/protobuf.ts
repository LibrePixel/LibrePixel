const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type Bytes = Uint8Array<ArrayBuffer>;

export type FieldEntry = { wire: 0; value: bigint } | { wire: 2; value: Uint8Array };

export type Fields = Map<number, FieldEntry[]>;

export class Writer {
  #chunks: Uint8Array[] = [];
  #length = 0;

  #push(bytes: Uint8Array) {
    this.#chunks.push(bytes);
    this.#length += bytes.length;
  }

  #tag(field: number, wire: number) {
    this.#push(encodeVarint((field << 3) | wire));
  }

  varint(field: number, value: number | bigint): this {
    this.#tag(field, 0);
    this.#push(encodeVarint(value));
    return this;
  }

  lengthDelimited(field: number, payload: Uint8Array): this {
    this.#tag(field, 2);
    this.#push(encodeVarint(payload.length));
    this.#push(payload);
    return this;
  }

  bytes(field: number, value: Uint8Array): this {
    return this.lengthDelimited(field, value);
  }

  string(field: number, value: string): this {
    return this.lengthDelimited(field, textEncoder.encode(value));
  }

  message(field: number, writer: Writer): this {
    return this.lengthDelimited(field, writer.buffer);
  }

  empty(field: number): this {
    return this.lengthDelimited(field, new Uint8Array(0));
  }

  get buffer(): Bytes {
    const out = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

export function encodeVarint(value: number | bigint): Bytes {
  let v = BigInt(value);
  if (v < 0n) throw new RangeError('Negative varints are not supported');
  const bytes: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0n);
  return new Uint8Array(bytes);
}

export function readVarint(buf: Uint8Array, at: number): [bigint, number] | null {
  let value = 0n;
  let shift = 0n;
  let cursor = at;
  while (cursor < buf.length) {
    if (shift > 63n) return null;
    const byte = buf[cursor];
    value |= BigInt(byte & 0x7f) << shift;
    cursor += 1;
    if ((byte & 0x80) === 0) return [value, cursor];
    shift += 7n;
  }
  return null;
}

function readTag(buf: Uint8Array, at: number): [number, number, number] | null {
  const read = readVarint(buf, at);
  if (!read) return null;
  const [raw, next] = read;
  return [Number(raw >> 3n), Number(raw & 0x07n), next];
}

function skipValue(buf: Uint8Array, wire: number, at: number): number | null {
  switch (wire) {
    case 0: {
      const read = readVarint(buf, at);
      return read ? read[1] : null;
    }
    case 1:
      return at + 8 <= buf.length ? at + 8 : null;
    case 2: {
      const read = readVarint(buf, at);
      if (!read) return null;
      const end = read[1] + Number(read[0]);
      return end <= buf.length ? end : null;
    }
    case 5:
      return at + 4 <= buf.length ? at + 4 : null;
    default:
      return null;
  }
}

export function decode(buf: Uint8Array): Fields {
  const fields: Fields = new Map();
  let cursor = 0;
  while (cursor < buf.length) {
    const tag = readTag(buf, cursor);
    if (!tag) return fields;
    const [field, wire, afterTag] = tag;
    if (wire === 0) {
      const read = readVarint(buf, afterTag);
      if (!read) return fields;
      push(fields, field, { wire: 0, value: read[0] });
      cursor = read[1];
    } else if (wire === 2) {
      const read = readVarint(buf, afterTag);
      if (!read) return fields;
      const end = read[1] + Number(read[0]);
      if (end > buf.length) return fields;
      push(fields, field, { wire: 2, value: buf.subarray(read[1], end) });
      cursor = end;
    } else {
      const next = skipValue(buf, wire, afterTag);
      if (next === null) return fields;
      cursor = next;
    }
  }
  return fields;
}

function push(map: Fields, key: number, entry: FieldEntry) {
  const existing = map.get(key);
  if (existing) existing.push(entry);
  else map.set(key, [entry]);
}

export function payloadAt(buf: Uint8Array, path: number[]): Uint8Array | null {
  let current = buf;
  for (const field of path) {
    const entries = decode(current).get(field);
    const found = entries?.find((e) => e.wire === 2);
    if (!found) return null;
    current = found.value;
  }
  return current;
}

export function varintAt(buf: Uint8Array, path: number[]): bigint | null {
  const parent = path.length > 1 ? payloadAt(buf, path.slice(0, -1)) : buf;
  if (!parent) return null;
  const entries = decode(parent).get(path[path.length - 1]);
  const found = entries?.find((e) => e.wire === 0);
  return found ? found.value : null;
}

export function stringAt(buf: Uint8Array, path: number[]): string | null {
  const payload = payloadAt(buf, path);
  return payload ? textDecoder.decode(payload) : null;
}

export function looksLikeUploadResponse(buf: Uint8Array): boolean {
  const seen = new Map<number, number>();
  let cursor = 0;
  while (cursor < buf.length) {
    const tag = readTag(buf, cursor);
    if (!tag) return false;
    const [field, wire, afterTag] = tag;
    const next = skipValue(buf, wire, afterTag);
    if (next === null) return false;
    seen.set(field, wire);
    cursor = next;
  }
  return seen.size === 2 && seen.get(1) === 0 && seen.get(2) === 2;
}

export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const hexToBytes = (hex: string): Bytes | null => {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
};
