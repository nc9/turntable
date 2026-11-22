// Canonicalisation of a cache archive on commit. Validating the client's bytes is not enough: a
// validator and an extractor that read one archive differently (header quirks, link chains, format
// variants) is a bypass, and each fix invites the next. So the client never gets its own bytes
// back. We parse the staged archive with our parser, and every entry that passes every rule is
// re-emitted by our own writer as plain POSIX ustar (PAX only for paths that do not fit), then
// recompressed in the same format. The blob that is stored and served is that new archive.
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { PassThrough, Transform } from "node:stream";
import { createGzip, createZstdCompress } from "node:zlib";
import {
  ArchiveTooLargeError,
  DEFAULT_RULES,
  walkArchive,
  type ArchiveRules,
  type CanonEntry,
} from "./tar";

function paxRecord(k: string, v: string): Buffer {
  const body = ` ${k}=${v}\n`;
  const bodyLen = Buffer.byteLength(body);
  let len = bodyLen + 1;
  while (String(len).length + bodyLen !== len) len = String(len).length + bodyLen;
  return Buffer.from(`${len}${body}`);
}

function header(o: {
  name: string;
  link?: string;
  type: string;
  mode: number;
  mtime: number;
  size: number;
}): Buffer {
  const h = Buffer.alloc(512);
  h.write(o.name, 0, 100, "utf8");
  h.write(`${o.mode.toString(8).padStart(7, "0")}\0`, 100);
  h.write("0000000\0", 108); // uid 0
  h.write("0000000\0", 116); // gid 0
  h.write(`${o.size.toString(8).padStart(11, "0")}\0`, 124);
  h.write(`${Math.max(0, o.mtime).toString(8).padStart(11, "0")}\0`, 136);
  h.write("        ", 148);
  h.write(o.type, 156);
  if (o.link) h.write(o.link, 157, 100, "utf8");
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

const pad = (n: number): Buffer => Buffer.alloc((512 - (n % 512)) % 512);

/**
 * The header blocks for one entry, with a PAX record first when a path or link target does not
 * fit ustar. The ustar fields then hold a fixed placeholder (never a truncated or split real
 * path), so a reader that ignores PAX sees a harmless name, not a different real one.
 */
function blocks(e: CanonEntry, seq: { n: number }): Buffer[] {
  const type = { file: "0", dir: "5", symlink: "2", hardlink: "1" }[e.type];
  const name = e.type === "dir" && !e.name.endsWith("/") ? `${e.name}/` : e.name;
  const out: Buffer[] = [];
  const records: Buffer[] = [];
  let useName = name;
  if (Buffer.byteLength(name) > 100) {
    records.push(paxRecord("path", name));
    useName = `pax-long-name-${seq.n++}`;
  }
  let link = e.type === "symlink" || e.type === "hardlink" ? e.link : undefined;
  if (link !== undefined && Buffer.byteLength(link) > 100) {
    records.push(paxRecord("linkpath", link));
    link = "";
  }
  if (records.length > 0) {
    const data = Buffer.concat(records);
    out.push(
      header({ name: "PaxHeader", type: "x", mode: 0o644, mtime: e.mtime, size: data.length }),
      data,
      pad(data.length),
    );
  }
  out.push(
    header({
      name: useName,
      type,
      mode: e.mode,
      mtime: e.mtime,
      size: e.type === "file" ? e.size : 0,
      ...(link === undefined ? {} : { link }),
    }),
  );
  return out;
}

/**
 * Parses `src` with every rule enforced and writes the re-emitted archive to `dest`, in the same
 * compression format. Throws ArchiveError when the source is unsafe. Returns the entry count.
 */
export async function canonicalizeArchive(
  src: string,
  dest: string,
  rules: ArchiveRules = DEFAULT_RULES,
  o: { maxOutputBytes?: number } = {},
): Promise<{ entries: number; bytes: number }> {
  const head = Buffer.from(await Bun.file(src).slice(0, 8).arrayBuffer());
  const out = createWriteStream(dest, { mode: 0o600 });
  const comp: Transform =
    head[0] === 0x1f && head[1] === 0x8b
      ? createGzip()
      : head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd
        ? createZstdCompress()
        : new PassThrough();
  // Count what is written as it is written, so an oversized result is stopped early, not after
  // the whole thing is on disk.
  const max = o.maxOutputBytes ?? Number.POSITIVE_INFINITY;
  let written = 0;
  let failure: Error | undefined;
  let fail!: (e: Error) => void;
  const failed = new Promise<never>((_, rej) => (fail = rej));
  failed.catch(() => {});
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > max) return cb(new ArchiveTooLargeError("the cache entry is too large"));
      cb(null, chunk);
    },
  });
  const onErr = (e: Error) => {
    failure ??= e;
    fail(e);
    comp.destroy();
    out.destroy();
  };
  comp.on("error", onErr);
  counter.on("error", onErr);
  out.on("error", onErr);
  comp.pipe(counter).pipe(out);
  const done = once(out, "close");
  const write = async (b: Buffer) => {
    if (failure) throw failure;
    if (b.length > 0 && !comp.write(b)) await Promise.race([once(comp, "drain"), failed]);
    if (failure) throw failure;
  };
  let cur = 0; // data bytes of the entry being written, for its block padding
  const seq = { n: 0 };
  let result: { entries: number; bytes: number } | undefined;
  let walkError: unknown;
  try {
    result = await walkArchive(src, rules, {
      async entry(e) {
        await write(pad(cur));
        cur = e.type === "file" ? e.size : 0;
        for (const b of blocks(e, seq)) await write(b);
      },
      async data(b) {
        await write(Buffer.from(b));
      },
    });
    await write(pad(cur));
    await write(Buffer.alloc(1024)); // end of archive
  } catch (e) {
    walkError = e;
  }
  if (!failure) comp.end();
  await done.catch(() => {});
  if (failure) throw failure;
  if (walkError) throw walkError;
  return result!;
}
