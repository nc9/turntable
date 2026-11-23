// A small zip writer for tests, with the knobs a hostile archive turns: the Unix mode, the host
// that wrote it, the name in the local header, the declared sizes and the compression method.
import { crc32, deflateRawSync } from "node:zlib";

export type ZipEntry = {
  name: string;
  data?: string | Uint8Array;
  /** Unix file mode bits including the type, such as 0o100644 or 0o120777. */
  mode?: number;
  /** Version-made-by host (3 is Unix, 0 is DOS). Default 3. */
  host?: number;
  method?: 0 | 8;
  /** The name written in the local header, when it should differ from the central one. */
  localName?: string;
  /** Overrides what the central directory declares as the uncompressed size. */
  declaredSize?: number;
  /** Overrides the declared CRC. */
  crc?: number;
  flags?: number;
  /** Extra DOS attribute bits (the low 16 bits of the external attributes). */
  dosAttrs?: number;
};

export function buildZip(
  entries: readonly ZipEntry[],
  opts: { comment?: string } = {},
): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data ?? "");
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = e.crc ?? crc32(raw);
    const name = Buffer.from(e.name);
    const local = Buffer.from(e.localName ?? e.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.flags ?? 0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(local.length, 26);
    parts.push(lh, local, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(((e.host ?? 3) << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.flags ?? 0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.declaredSize ?? raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    const mode = e.mode ?? (e.name.endsWith("/") ? 0o040755 : 0o100644);
    ch.writeUInt32LE(((mode << 16) | (e.dosAttrs ?? 0)) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + local.length + body.length;
  }
  const cd = Buffer.concat(central);
  const comment = Buffer.from(opts.comment ?? "");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return new Uint8Array(Buffer.concat([...parts, cd, end, comment]));
}
