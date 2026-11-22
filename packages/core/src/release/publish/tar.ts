// Reads one file out of a gzipped tarball (an `npm pack` result) without extracting anything.
import { gunzipSync } from "node:zlib";

const MAX_TAR_BYTES = 512 * 1024 * 1024;

const text = (b: Uint8Array): string => new TextDecoder().decode(b).replace(/\0.*$/s, "");
const octal = (b: Uint8Array): number => {
  const n = Number.parseInt(text(b).trim(), 8);
  return Number.isFinite(n) ? n : -1;
};

/**
 * The content of `wanted` in the tarball, or undefined if it is not there. A name that appears
 * twice is ambiguous and is also undefined. Entries larger than `maxEntry` are not read.
 */
export function tarEntry(
  tgz: Uint8Array,
  wanted: string,
  maxEntry = 5 * 1024 * 1024,
): Uint8Array | undefined {
  let tar: Uint8Array;
  try {
    tar = gunzipSync(tgz, { maxOutputLength: MAX_TAR_BYTES });
  } catch {
    return undefined;
  }
  let found: Uint8Array | undefined;
  let hits = 0;
  let longName: string | undefined;
  let pos = 0;
  while (pos + 512 <= tar.length) {
    const h = tar.subarray(pos, pos + 512);
    if (h.every((x) => x === 0)) break;
    const size = octal(h.subarray(124, 136));
    if (size < 0) return undefined;
    const type = String.fromCharCode(h[156] ?? 0);
    const prefix = text(h.subarray(257, 262)) === "ustar" ? text(h.subarray(345, 500)) : "";
    const base = text(h.subarray(0, 100));
    const name = longName ?? (prefix ? `${prefix}/${base}` : base);
    const body = tar.subarray(pos + 512, pos + 512 + size);
    pos += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = text(body);
      continue;
    }
    longName = undefined;
    // Extended headers and the global one describe the next entry; none of them is a file.
    if (type === "x" || type === "g") continue;
    if ((type === "0" || type === "\0") && name === wanted) {
      hits += 1;
      if (size > maxEntry) return undefined;
      found = new Uint8Array(body);
    }
  }
  return hits === 1 ? found : undefined;
}
