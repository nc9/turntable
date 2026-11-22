// A small CBOR decoder: only what a WebAuthn attestation object and a COSE key use (unsigned and
// negative integers, byte and text strings, arrays, maps with integer or text keys, booleans,
// null). Anything else, indefinite lengths included, is refused.
export type Cbor =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | Cbor[]
  | Map<Cbor, Cbor>;

export class CborError extends Error {}

const MAX_DEPTH = 8;
const MAX_ITEMS = 256;

export function decodeCbor(input: Uint8Array): { value: Cbor; length: number } {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let pos = 0;

  const need = (n: number) => {
    if (pos + n > input.length) throw new CborError("truncated");
  };
  const uint = (info: number): number => {
    if (info < 24) return info;
    const size = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
    if (size === undefined) throw new CborError("unsupported length encoding");
    need(size);
    let v: number;
    if (size === 1) v = view.getUint8(pos);
    else if (size === 2) v = view.getUint16(pos);
    else if (size === 4) v = view.getUint32(pos);
    else {
      const big = view.getBigUint64(pos);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError("integer too large");
      v = Number(big);
    }
    pos += size;
    return v;
  };

  const item = (depth: number): Cbor => {
    if (depth > MAX_DEPTH) throw new CborError("too deep");
    need(1);
    const first = view.getUint8(pos++);
    const major = first >> 5;
    const info = first & 31;
    switch (major) {
      case 0:
        return uint(info);
      case 1:
        return -1 - uint(info);
      case 2: {
        const n = uint(info);
        need(n);
        const out = input.slice(pos, pos + n);
        pos += n;
        return out;
      }
      case 3: {
        const n = uint(info);
        need(n);
        const out = new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(pos, pos + n));
        pos += n;
        return out;
      }
      case 4: {
        const n = uint(info);
        if (n > MAX_ITEMS) throw new CborError("array too long");
        return Array.from({ length: n }, () => item(depth + 1));
      }
      case 5: {
        const n = uint(info);
        if (n > MAX_ITEMS) throw new CborError("map too large");
        const m = new Map<Cbor, Cbor>();
        for (let i = 0; i < n; i++) m.set(item(depth + 1), item(depth + 1));
        return m;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new CborError("unsupported simple value");
      default:
        throw new CborError("unsupported type");
    }
  };

  const value = item(0);
  return { value, length: pos };
}
