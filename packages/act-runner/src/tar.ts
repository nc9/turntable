// A small tar reader and writer, in process, so the control plane needs no `tar` binary. It
// handles what the archives here are: ustar headers, pax extended headers (long paths and sizes),
// GNU long names, regular files, directories, symlinks and hard links (read as links). Reading is
// for untrusted archives (a source tarball from GitHub): every size is capped, a path is returned
// as written and the CALLER decides what is safe to do with it.
import { Buffer } from "node:buffer";
import {
  createWriteStream,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip, gunzipSync, gzipSync } from "node:zlib";

export interface TarEntry {
  path: string;
  type: "file" | "dir" | "symlink" | "link";
  mode: number;
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
  /** For a symlink or hard link. */
  linkTarget?: string;
  /** File contents (empty for anything else). */
  data: Uint8Array;
}

export interface TarLimits {
  /** Most bytes of archive content (after gunzip). Default 1 GiB. */
  maxBytes?: number;
  /** Most entries. Default 200 000. */
  maxEntries?: number;
}

const BLOCK = 512;
const dec = new TextDecoder();

function cstr(b: Uint8Array, off: number, len: number): string {
  let end = off;
  const stop = off + len;
  while (end < stop && b[end] !== 0) end += 1;
  return dec.decode(b.subarray(off, end));
}

function octal(b: Uint8Array, off: number, len: number): number {
  // GNU base-256 for sizes over 8 GiB is not accepted: nothing here is that large.
  if ((b[off]! & 0x80) !== 0) throw new Error("tar: base-256 numbers are not supported");
  const s = cstr(b, off, len).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error("tar: bad number in header");
  return Number.parseInt(s, 8);
}

function checksumOk(h: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return sum === octal(h, 148, 8);
}

/** Pax records `<len> <key>=<value>\n`, as a Map (no object keys an archive could name, such as `__proto__`). */
function paxRecords(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    let sp = i;
    while (sp < data.length && data[sp] !== 0x20) sp += 1;
    const len = Number.parseInt(dec.decode(data.subarray(i, sp)), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > data.length)
      throw new Error("tar: bad pax record");
    const rec = dec.decode(data.subarray(sp + 1, i + len - 1));
    const eq = rec.indexOf("=");
    if (eq > 0) out.set(rec.slice(0, eq), rec.slice(eq + 1));
    i += len;
  }
  return out;
}

/** The entries of an uncompressed tar archive. */
export function readTar(tar: Uint8Array, limits: TarLimits = {}): TarEntry[] {
  const maxBytes = limits.maxBytes ?? 1024 * 1024 * 1024;
  const maxEntries = limits.maxEntries ?? 200_000;
  if (tar.length > maxBytes) throw new Error("tar: archive is too large");
  const out: TarEntry[] = [];
  let off = 0;
  let pax = new Map<string, string>();
  let longName: string | undefined;
  let longLink: string | undefined;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((x) => x === 0)) break;
    if (!checksumOk(h)) throw new Error("tar: bad header checksum");
    const type = String.fromCharCode(h[156] === 0 ? 0x30 : h[156]!);
    const size = octal(h, 124, 12);
    const start = off + BLOCK;
    const end = start + size;
    if (end > tar.length) throw new Error("tar: truncated archive");
    const data = tar.subarray(start, end);
    off = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      for (const [k, v] of paxRecords(data)) pax.set(k, v);
      continue;
    }
    if (type === "g") continue; // global pax header: ignored
    if (type === "L") {
      longName = cstr(data, 0, data.length);
      continue;
    }
    if (type === "K") {
      longLink = cstr(data, 0, data.length);
      continue;
    }
    const prefix = cstr(h, 345, 155);
    const name =
      pax.get("path") ?? longName ?? (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100));
    const target = pax.get("linkpath") ?? longLink ?? cstr(h, 157, 100);
    const paxSize = pax.get("size");
    const realSize = paxSize !== undefined ? Number(paxSize) : size;
    const paxMtime = pax.get("mtime");
    const mtime = paxMtime !== undefined ? Math.floor(Number(paxMtime)) : octal(h, 136, 12);
    pax = new Map();
    longName = undefined;
    longLink = undefined;
    if (out.length >= maxEntries) throw new Error("tar: too many entries");
    const base = {
      path: type === "5" ? name.replace(/\/+$/, "") : name,
      mode: octal(h, 100, 8) & 0o7777,
      mtime,
    };
    if (type === "0" || type === "7") {
      out.push({ ...base, type: "file", size: realSize, data });
    } else if (type === "5") {
      out.push({ ...base, type: "dir", size: 0, data: new Uint8Array() });
    } else if (type === "2") {
      out.push({ ...base, type: "symlink", size: 0, linkTarget: target, data: new Uint8Array() });
    } else if (type === "1") {
      out.push({ ...base, type: "link", size: 0, linkTarget: target, data: new Uint8Array() });
    }
    // Devices, fifos and anything else are not archive content here: skipped.
  }
  return out;
}

/** The entries of a gzip-compressed tar archive. The decompressed size is capped. */
export function readTarGz(tgz: Uint8Array, limits: TarLimits = {}): TarEntry[] {
  const maxBytes = limits.maxBytes ?? 1024 * 1024 * 1024;
  let tar: Uint8Array;
  try {
    tar = gunzipSync(tgz, { maxOutputLength: maxBytes });
  } catch (e) {
    throw new Error(`tar: cannot decompress: ${e instanceof Error ? e.message : String(e)}`);
  }
  return readTar(tar, limits);
}

// ---- writing ----

export interface TarWriteEntry {
  path: string;
  type: "file" | "dir" | "symlink";
  mode: number;
  mtime?: number;
  data?: Uint8Array;
  /** A symlink's target: bytes are kept as they are (a target need not be valid UTF-8). */
  linkTarget?: string | Uint8Array;
}

const enc = new TextEncoder();

function field(h: Uint8Array, off: number, len: number, value: string): void {
  const b = enc.encode(value);
  h.set(b.subarray(0, len), off);
}

function num(h: Uint8Array, off: number, len: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("tar: a header number is not a non-negative integer");
  const s = value.toString(8);
  // An octal field of `len` bytes holds `len - 1` digits and a NUL. A larger value is an error,
  // never silently truncated into a different (smaller) number.
  if (s.length > len - 1) throw new Error("tar: a header number does not fit its field");
  field(h, off, len, `${s.padStart(len - 1, "0")}\0`);
}

function header(
  path: Uint8Array,
  type: string,
  mode: number,
  size: number,
  mtime: number,
  link: Uint8Array,
): Uint8Array {
  const h = new Uint8Array(BLOCK);
  h.set(path.subarray(0, 100), 0);
  num(h, 100, 8, mode);
  num(h, 108, 8, 0);
  num(h, 116, 8, 0);
  num(h, 124, 12, size);
  num(h, 136, 12, mtime);
  field(h, 148, 8, "        ");
  h[156] = type.charCodeAt(0);
  h.set(link.subarray(0, 100), 157);
  field(h, 257, 6, "ustar\0");
  field(h, 263, 2, "00");
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += h[i]!;
  field(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

function paxBlock(records: Record<string, string>): Uint8Array[] {
  let body = "";
  for (const [k, v] of Object.entries(records)) {
    const rest = ` ${k}=${v}\n`;
    let len = enc.encode(rest).length + 1;
    while (enc.encode(`${len}${rest}`).length !== len) len = enc.encode(`${len}${rest}`).length;
    body += `${len}${rest}`;
  }
  const data = enc.encode(body);
  const pad = new Uint8Array((BLOCK - (data.length % BLOCK)) % BLOCK);
  return [header(enc.encode("PaxHeader"), "x", 0o644, data.length, 0, new Uint8Array()), data, pad];
}

function entryChunks(e: TarWriteEntry): Uint8Array[] {
  const parts: Uint8Array[] = [];
  const isDir = e.type === "dir";
  const path = isDir && !e.path.endsWith("/") ? `${e.path}/` : e.path;
  const link =
    typeof e.linkTarget === "string"
      ? enc.encode(e.linkTarget)
      : (e.linkTarget ?? new Uint8Array());
  const data = e.type === "file" ? (e.data ?? new Uint8Array()) : new Uint8Array();
  const long: Record<string, string> = {};
  if (enc.encode(path).length > 100) long.path = path;
  if (link.length > 100) {
    // A long target goes in a pax record, which is UTF-8 text: a target that is not cannot be kept.
    try {
      long.linkpath = new TextDecoder("utf-8", { fatal: true }).decode(link);
    } catch {
      throw new Error("tar: a link target longer than 100 bytes must be valid UTF-8");
    }
  }
  if (Object.keys(long).length > 0) parts.push(...paxBlock(long));
  const t = e.type === "file" ? "0" : e.type === "dir" ? "5" : "2";
  parts.push(
    header(
      long.path ? enc.encode(path).subarray(0, 100) : enc.encode(path),
      t,
      e.mode & 0o777,
      data.length,
      Math.max(0, e.mtime ?? 0),
      link,
    ),
  );
  if (data.length > 0) parts.push(data, new Uint8Array((BLOCK - (data.length % BLOCK)) % BLOCK));
  return parts;
}

/** An uncompressed tar archive (ustar, with pax headers for long paths and link targets). */
export function writeTar(entries: Iterable<TarWriteEntry>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) parts.push(...entryChunks(e));
  parts.push(new Uint8Array(BLOCK * 2));
  return Buffer.concat(parts);
}

/** Packs entries from a directory (default: all of it), the way `tar czf - -C dir entries...` does. */
export function tarDirectorySync(dir: string, entries: string[] = ["."]): Uint8Array {
  const out: TarWriteEntry[] = [];
  const add = (rel: string): void => {
    const full = rel === "." ? dir : join(dir, rel);
    const st = lstatSync(full);
    const name = rel === "." ? "." : rel;
    const mtime = Math.floor(st.mtimeMs / 1000);
    if (st.isDirectory()) {
      out.push({ path: name, type: "dir", mode: st.mode & 0o7777, mtime });
      for (const child of readdirSync(full).toSorted())
        add(rel === "." ? child : `${rel}/${child}`);
    } else if (st.isSymbolicLink()) {
      out.push({
        path: name,
        type: "symlink",
        mode: 0o777,
        mtime,
        linkTarget: readlinkSync(full, { encoding: "buffer" }),
      });
    } else if (st.isFile()) {
      out.push({
        path: name,
        type: "file",
        mode: st.mode & 0o7777,
        mtime,
        data: readFileSync(full),
      });
    }
  };
  for (const e of entries) add(e.replace(/^\.\//, "").replace(/\/+$/, "") || ".");
  return writeTar(out);
}

/** A gzip tarball of `tarDirectorySync`. */
export function tarGzDirectory(dir: string, entries: string[] = ["."]): Uint8Array {
  return gzipSync(tarDirectorySync(dir, entries));
}

/** The entries of a directory, depth first and in name order, reading each file only as it is yielded. */
function* walkDirectory(dir: string, entries: string[] = ["."]): Generator<TarWriteEntry> {
  function* add(rel: string): Generator<TarWriteEntry> {
    const full = rel === "." ? dir : join(dir, rel);
    const st = lstatSync(full);
    const mtime = Math.max(0, Math.floor(st.mtimeMs / 1000));
    if (st.isDirectory()) {
      yield { path: rel, type: "dir", mode: st.mode & 0o777, mtime };
      for (const child of readdirSync(full).toSorted())
        yield* add(rel === "." ? child : `${rel}/${child}`);
    } else if (st.isSymbolicLink()) {
      yield {
        path: rel,
        type: "symlink",
        mode: 0o777,
        mtime,
        linkTarget: readlinkSync(full, { encoding: "buffer" }),
      };
    } else if (st.isFile()) {
      yield { path: rel, type: "file", mode: st.mode & 0o777, mtime, data: readFileSync(full) };
    }
  }
  for (const e of entries) yield* add(e.replace(/^\.\//, "").replace(/\/+$/, "") || ".");
}

/**
 * Packs a directory into a gzip tarball ON DISK, streaming: entries are read one at a time and
 * flow through ONE gzip stream into the file, so memory stays at one file plus the stream's buffers
 * and the result is a single ordinary gzip member that every reader accepts. The file is created
 * exclusively (`wx`: an existing file or link at that path is an error). `maxBytes` caps the
 * compressed size written; past it the stream fails and the file is removed. `checkpoint` is called
 * between entries.
 */
export async function tarGzDirectoryToFile(
  dir: string,
  outPath: string,
  opts: { maxBytes: number; entries?: string[]; checkpoint?: () => void } = {
    maxBytes: 512 * 1024 * 1024,
  },
): Promise<{ bytes: number; entries: number }> {
  let count = 0;
  let written = 0;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (const e of walkDirectory(dir, opts.entries)) {
      opts.checkpoint?.();
      count += 1;
      for (const c of entryChunks(e)) yield c;
    }
    yield new Uint8Array(BLOCK * 2);
  }
  const cap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > opts.maxBytes) cb(new Error("tar: the tarball is larger than the cap"));
      else cb(null, chunk);
    },
  });
  // Created exclusively and BEFORE anything else: if the path is taken, that is an error and what
  // is there is left alone. Only a file this call made is removed when it fails.
  const fd = openSync(outPath, "wx", 0o600);
  try {
    await pipeline(Readable.from(chunks()), createGzip(), cap, createWriteStream(outPath, { fd }));
  } catch (e) {
    rmSync(outPath, { force: true });
    throw e;
  }
  return { bytes: written, entries: count };
}

// ---- scanning a tarball without unpacking it ----

export interface ScannedEntry {
  type: TarEntry["type"];
  size: number;
  linkTarget?: string;
  /** The contents, only for a file small enough and while the capture budget lasts. */
  data?: Uint8Array;
}

export interface ScanOptions {
  /** Most bytes of archive content after gunzip. */
  maxUnpackedBytes: number;
  maxEntries: number;
  /** A file up to this size is captured. */
  captureUpTo: number;
  /** Most bytes captured in all; past it files are listed but not captured. */
  captureTotal: number;
}

/**
 * Reads a gzip tarball as a stream and keeps the LIST of entries and the contents of small files
 * only, so memory is bounded by `captureTotal` however large the repository, and the inflate
 * runs off the event loop. This is how the server reads what it plans from: the same bytes it
 * will deliver, not a directory a child process also wrote.
 */
export async function scanTarGz(
  tgz: Uint8Array,
  o: ScanOptions,
): Promise<Map<string, ScannedEntry>> {
  const out = new Map<string, ScannedEntry>();
  const gz = createGunzip();
  const input = Readable.from([Buffer.from(tgz.buffer, tgz.byteOffset, tgz.byteLength)]);
  input.on("error", (e) => gz.destroy(e));
  input.pipe(gz);
  let total = 0;
  let captured = 0;
  let pending: Buffer = Buffer.alloc(0);
  let pax = new Map<string, string>();
  let longName: string | undefined;
  let longLink: string | undefined;
  // What the stream is in the middle of: a header to read, or `left` bytes of an entry's data.
  let cur:
    | {
        meta: "x" | "g" | "L" | "K" | undefined;
        name: string;
        type: TarEntry["type"] | "other";
        size: number;
        left: number;
        pad: number;
        link: string;
        keep: Buffer[] | undefined;
      }
    | undefined;
  const take = (n: number): Buffer => {
    const b = pending.subarray(0, n);
    pending = pending.subarray(n);
    return b;
  };
  const finish = (): void => {
    const c = cur!;
    cur = undefined;
    const data = c.keep ? Buffer.concat(c.keep) : undefined;
    if (c.meta === "x") {
      for (const [k, v] of paxRecords(data ?? new Uint8Array())) pax.set(k, v);
      return;
    }
    if (c.meta === "L") longName = cstr(data ?? new Uint8Array(), 0, data?.length ?? 0);
    else if (c.meta === "K") longLink = cstr(data ?? new Uint8Array(), 0, data?.length ?? 0);
    if (c.meta !== undefined) return;
    if (c.type === "other") return;
    if (out.size >= o.maxEntries) throw new Error("tar: too many entries");
    const name = (c.type === "dir" ? c.name.replace(/\/+$/, "") : c.name).replace(/^\.\//, "");
    out.set(name, {
      type: c.type,
      size: c.size,
      ...(c.type === "symlink" || c.type === "link" ? { linkTarget: c.link } : {}),
      ...(c.type === "file" && data ? { data } : {}),
    });
  };
  for await (const chunk of gz) {
    total += chunk.length;
    if (total > o.maxUnpackedBytes) throw new Error("tar: archive is too large");
    pending = pending.length === 0 ? (chunk as Buffer) : Buffer.concat([pending, chunk as Buffer]);
    for (;;) {
      if (cur === undefined) {
        if (pending.length < BLOCK) break;
        const h = take(BLOCK);
        if (h.every((x) => x === 0)) {
          cur = undefined;
          pending = Buffer.alloc(0);
          break;
        }
        if (!checksumOk(h)) throw new Error("tar: bad header checksum");
        const ch = String.fromCharCode(h[156] === 0 ? 0x30 : h[156]!);
        const size = octal(h, 124, 12);
        const prefix = cstr(h, 345, 155);
        const name =
          pax.get("path") ??
          longName ??
          (prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100));
        const link = pax.get("linkpath") ?? longLink ?? cstr(h, 157, 100);
        const paxSize = pax.get("size");
        const real = paxSize !== undefined ? Number(paxSize) : size;
        const meta = ch === "x" || ch === "g" || ch === "L" || ch === "K" ? ch : undefined;
        const type: TarEntry["type"] | "other" =
          ch === "0" || ch === "7"
            ? "file"
            : ch === "5"
              ? "dir"
              : ch === "2"
                ? "symlink"
                : ch === "1"
                  ? "link"
                  : "other";
        if (meta === undefined) {
          pax = new Map();
          longName = undefined;
          longLink = undefined;
        }
        const wantData =
          meta !== undefined ||
          (type === "file" && real <= o.captureUpTo && captured + real <= o.captureTotal);
        const left = meta === undefined ? real : size;
        cur = {
          meta: meta as "x" | "g" | "L" | "K" | undefined,
          name,
          type,
          size: real,
          left,
          pad: (BLOCK - (left % BLOCK)) % BLOCK,
          link,
          keep: wantData ? [] : undefined,
        };
        if (meta === undefined && type === "file" && wantData) captured += real;
        if (left === 0 && cur.pad === 0) finish();
        continue;
      }
      // data of the current entry
      if (cur.left > 0) {
        if (pending.length === 0) break;
        const n = Math.min(cur.left, pending.length);
        const piece = take(n);
        cur.keep?.push(Buffer.from(piece));
        cur.left -= n;
        if (cur.left > 0) break;
      }
      if (cur.pad > 0) {
        if (pending.length < cur.pad) break;
        take(cur.pad);
        cur.pad = 0;
      }
      finish();
    }
  }
  return out;
}
