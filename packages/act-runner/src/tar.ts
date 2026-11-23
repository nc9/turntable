// A small tar reader and writer, in process, so the control plane needs no `tar` binary. It
// handles what the archives here are: ustar headers, pax extended headers (long paths and sizes),
// GNU long names, regular files, directories, symlinks and hard links (read as links). Reading is
// for untrusted archives (a source tarball from GitHub): every size is capped, a path is returned
// as written and the CALLER decides what is safe to do with it.
import { foldKey } from "./fold-key";
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
  // scanTarGz takes names up to PATH_MAX and no more: the writer refuses first.
  if (enc.encode(path).length > MAX_NAME_BYTES || link.length > MAX_NAME_BYTES)
    throw new Error("tar: a name or link target is longer than 4096 bytes");
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
  type: "file" | "dir" | "symlink";
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
  /**
   * Refuse two names that fold together (case, normalisation, ignorable characters, trailing dots).
   * Off by default: a Linux sandbox extracts `Readme` and `README` as two files and the scanner keys
   * them exactly. Turn it on when the archive will be extracted onto a folding filesystem
   * (macOS, Windows).
   */
  refuseFoldedNames?: boolean;
}

export class TarFormatError extends Error {
  constructor(message: string) {
    super(`tar: ${message}`);
    this.name = "TarFormatError";
  }
}

const bad = (m: string): never => {
  throw new TarFormatError(m);
};
const zero = (h: Uint8Array, from: number, to: number): boolean => {
  for (let i = from; i < to; i += 1) if (h[i] !== 0) return false;
  return true;
};
/** `len - 1` octal digits and a NUL, exactly as the writer's `num` writes them. */
const OCTAL_RE = new Map<number, RegExp>([
  [8, /^[0-7]{7}$/],
  [12, /^[0-7]{11}$/],
]);
function strictOctal(h: Uint8Array, off: number, len: number, what: string): number {
  const s = Buffer.from(h.subarray(off, off + len - 1)).toString("latin1");
  const re = OCTAL_RE.get(len) ?? bad("an internal octal width is wrong");
  if (!re.test(s) || h[off + len - 1] !== 0) bad(`the ${what} field is not canonical`);
  return Number.parseInt(s, 8);
}
// `ignoreBOM: true` keeps a leading U+FEFF: without it the decoder drops it and the planner's name
// would differ from the bytes tar sees.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** Text that is valid UTF-8 and encodes back to exactly the same bytes, or the archive is refused. */
function exactUtf8(bytes: Uint8Array, what: string): string {
  let s: string;
  try {
    s = utf8.decode(bytes);
  } catch {
    return bad(`${what} is not valid UTF-8`);
  }
  if (!Buffer.from(s).equals(bytes)) bad(`${what} does not survive a decode and encode`);
  return s;
}
const GIT_NAMES = new Set([".git", ".gitmodules", "git~1", "gitmod~1"]);
const PAX_VALUE_CAP = 1024 * 1024;
/** A path (or link target) over this many bytes is not one a filesystem takes (PATH_MAX). */
const MAX_NAME_BYTES = 4096;
/** All names and link targets together: a listing of millions of entries cannot be used to exhaust memory. */
const MAX_TOTAL_NAME_BYTES = 64 * 1024 * 1024;

/** A path as our writer writes it: no absolute path, no empty, `.` or `..` segment, no `./` prefix, no doubled slash. */
function canonical(path: string, dir: boolean): string[] {
  if (Buffer.byteLength(path) > MAX_NAME_BYTES) bad("an entry name is longer than 4096 bytes");
  let p = path;
  if (dir) {
    if (!p.endsWith("/") || p.endsWith("//"))
      bad("a directory name does not end in exactly one slash");
    p = p.slice(0, -1);
  } else if (p.endsWith("/")) {
    bad("a file name ends in a slash");
  }
  if (p === "") bad("an entry has an empty name");
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "") bad("an entry name has an empty segment (absolute path or doubled slash)");
    if (s === "." || s === "..") bad("an entry name has a . or .. segment");
    if (s.includes("\0")) bad("an entry name has a NUL");
  }
  return segs;
}

/** The records our writer emits, and only those: `path` and `linkpath`, each over 100 bytes, each once. */
function strictPax(data: Uint8Array): { path?: string; linkpath?: string } {
  const out: Record<string, string | undefined> = {};
  let i = 0;
  if (data.length === 0 || data.length > PAX_VALUE_CAP) bad("a pax header has a bad size");
  while (i < data.length) {
    let sp = i;
    while (sp < data.length && data[sp] !== 0x20) sp += 1;
    const lenText = Buffer.from(data.subarray(i, sp)).toString("latin1");
    if (!/^[1-9][0-9]{0,5}$/.test(lenText)) bad("a pax record has a bad length");
    const len = Number(lenText);
    if (i + len > data.length || data[i + len - 1] !== 0x0a || sp >= i + len)
      bad("a pax record is not framed by its length");
    const rec = exactUtf8(data.subarray(sp + 1, i + len - 1), "a pax record");
    const eq = rec.indexOf("=");
    if (eq <= 0) bad("a pax record has no key");
    const key = rec.slice(0, eq);
    const value = rec.slice(eq + 1);
    if (key !== "path" && key !== "linkpath")
      bad(
        `a pax record names ${JSON.stringify(key.slice(0, 20))}, which this archive never carries`,
      );
    if (out[key] !== undefined) bad("a pax record is repeated");
    if (value.includes("\0")) bad("a pax value has a NUL");
    if (Buffer.byteLength(value) <= 100) bad("a pax value is short enough to need no pax record");
    out[key] = value;
    i += len;
  }
  return {
    ...(out.path !== undefined ? { path: out.path } : {}),
    ...(out.linkpath !== undefined ? { linkpath: out.linkpath } : {}),
  };
}

/**
 * Reads a gzip tarball as a stream and keeps the LIST of entries and the contents of small files
 * only, so memory is bounded by `captureTotal` however large the repository, and the inflate
 * runs off the event loop. This is how the server reads what it plans from: the same bytes it
 * will deliver, not a directory a child process also wrote.
 *
 * It is STRICT. The archive comes from a child process that could be compromised, and what the
 * server plans from must be exactly what GNU tar, in the sandbox, will extract. So it accepts only
 * what `tarGzDirectoryToFile` writes and refuses everything else, never normalising and accepting:
 * canonical names only (no absolute, empty, `.` or `..` segments, `./` prefixes, doubled or
 * trailing slashes on files); every entry's parent a directory entry before it (so nothing is
 * under a symlink, and nothing is implied); no duplicate names; no hard links, devices or any
 * type but file, directory, symlink; only `path` and `linkpath` pax records, each framed exactly
 * and consistent with its header; canonical header fields and checksums; and exactly two zero
 * blocks at the end with nothing after them.
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
  let zeroBlocks = 0;
  let nameBytes_ = 0;
  const foldedKeys = new Set<string>();
  let pax: { path?: string; linkpath?: string } | undefined;
  let first = true;
  type Cur = {
    kind: "pax" | "entry";
    type: ScannedEntry["type"];
    key: string;
    segs: string[];
    size: number;
    left: number;
    pad: number;
    link: Uint8Array;
    keep: Buffer[] | undefined;
  };
  let cur: Cur | undefined;
  const take = (n: number): Buffer => {
    const b = pending.subarray(0, n);
    pending = pending.subarray(n);
    return b;
  };
  const header = (h: Buffer): void => {
    let sumOk = false;
    try {
      sumOk = checksumOk(h);
    } catch {
      // the lenient reader throws on a checksum field that is not octal: here that is a refusal
    }
    if (!sumOk) bad("a header checksum does not match");
    if (h.subarray(148, 156).toString("latin1") !== `${octalOf(h, 148)}\0 `)
      bad("the checksum field is not canonical");
    if (
      h.subarray(257, 263).toString("latin1") !== "ustar\0" ||
      h.subarray(263, 265).toString("latin1") !== "00"
    )
      bad("a header is not ustar");
    if (!zero(h, 265, 329) || !zero(h, 329, 345) || !zero(h, 345, 500) || !zero(h, 500, 512))
      bad("a header has fields this archive never sets");
    if (strictOctal(h, 108, 8, "uid") !== 0 || strictOctal(h, 116, 8, "gid") !== 0)
      bad("a header has an owner");
    const mode = strictOctal(h, 100, 8, "mode");
    if (mode > 0o777) bad("a header has mode bits beyond the permissions");
    const size = strictOctal(h, 124, 12, "size");
    strictOctal(h, 136, 12, "mtime");
    const ch = String.fromCharCode(h[156]!);
    const nameField = h.subarray(0, 100);
    const nul = nameField.indexOf(0);
    const nameBytes = nul < 0 ? nameField : nameField.subarray(0, nul);
    if (nul >= 0 && !zero(nameField, nul, 100)) bad("a name field has bytes after its end");
    const linkField = h.subarray(157, 257);
    const lnul = linkField.indexOf(0);
    const linkBytes = lnul < 0 ? linkField : linkField.subarray(0, lnul);
    if (lnul >= 0 && !zero(linkField, lnul, 100)) bad("a link field has bytes after its end");
    if (ch === "x") {
      if (pax) bad("two pax headers in a row");
      if (
        Buffer.from(nameBytes).toString("latin1") !== "PaxHeader" ||
        mode !== 0o644 ||
        linkBytes.length !== 0
      )
        bad("a pax header is not the one this archive writes");
      // Checked before a byte of the body is buffered, and counted against what the scan may keep.
      if (size === 0 || size > PAX_VALUE_CAP) bad("a pax header has a bad size");
      if (captured + size > o.captureTotal) bad("the pax headers are larger than the scan keeps");
      captured += size;
      cur = {
        kind: "pax",
        type: "file",
        key: "",
        segs: [],
        size,
        left: size,
        pad: (BLOCK - (size % BLOCK)) % BLOCK,
        link: linkBytes,
        keep: [],
      };
      return;
    }
    if (ch !== "0" && ch !== "5" && ch !== "2")
      bad(`an entry has the type ${JSON.stringify(ch)}, which this archive never carries`);
    const type: ScannedEntry["type"] = ch === "0" ? "file" : ch === "5" ? "dir" : "symlink";
    if (type !== "file" && size !== 0) bad("a directory or symlink has a size");
    if (type !== "symlink" && linkBytes.length !== 0)
      bad("an entry that is no symlink has a link target");
    // The name: the header's, or the pax path it must be the first 100 bytes of.
    let name: string;
    if (pax?.path !== undefined) {
      const full = Buffer.from(pax.path);
      if (!full.subarray(0, 100).equals(Buffer.from(nameBytes)) || nameBytes.length !== 100)
        bad("a header name does not match its pax path");
      name = pax.path;
    } else {
      name = exactUtf8(nameBytes, "an entry name");
    }
    if (pax?.linkpath !== undefined) {
      if (type !== "symlink") bad("a pax linkpath on something that is not a symlink");
      if (
        !Buffer.from(pax.linkpath).subarray(0, 100).equals(Buffer.from(linkBytes)) ||
        linkBytes.length !== 100
      )
        bad("a header link target does not match its pax linkpath");
    }
    const link = pax?.linkpath !== undefined ? Buffer.from(pax.linkpath) : linkBytes;
    pax = undefined;
    let key: string;
    let segs: string[];
    if (first && type === "dir" && name === "./") {
      key = ".";
      segs = [];
    } else {
      segs = canonical(name, type === "dir");
      key = segs.join("/");
      if (!out.has(".") && !first) bad("an entry comes before the root directory");
    }
    if (first && key !== ".") bad("the archive does not start with its root directory");
    first = false;
    if (out.has(key)) bad("an entry name is repeated");
    // A disguised `.git` or `.gitmodules` (case, NFC, ignorable characters, trailing dots, 8.3
    // names) is refused everywhere: it is about git's safety, not about how the archive extracts.
    for (const seg of segs) {
      const f = foldKey(seg).split(":", 1)[0]!;
      if (GIT_NAMES.has(f) && seg !== f) bad("an entry name is a disguised spelling of a git name");
    }
    if (o.refuseFoldedNames) {
      const folded = foldKey(key);
      if (foldedKeys.has(folded))
        bad("two entry names are the same name on a filesystem that folds names");
      foldedKeys.add(folded);
    }
    if (key !== ".") {
      const parent = segs.length === 1 ? "." : segs.slice(0, -1).join("/");
      const p = out.get(parent);
      if (!p) bad("an entry has no directory entry before it for its parent");
      else if (p.type !== "dir") bad("an entry is under a symlink or a file");
    }
    if (out.size >= o.maxEntries) bad("too many entries");
    if (link.length > MAX_NAME_BYTES) bad("a link target is longer than 4096 bytes");
    nameBytes_ += Buffer.byteLength(key) + link.length;
    if (nameBytes_ > MAX_TOTAL_NAME_BYTES) bad("the names in the archive add up to too much");
    const wantData = type === "file" && size <= o.captureUpTo && captured + size <= o.captureTotal;
    if (wantData) captured += size;
    cur = {
      kind: "entry",
      type,
      key,
      segs,
      size,
      left: size,
      pad: (BLOCK - (size % BLOCK)) % BLOCK,
      link,
      keep: wantData ? [] : undefined,
    };
  };
  const finish = (): void => {
    const c = cur!;
    cur = undefined;
    const data = c.keep ? Buffer.concat(c.keep) : undefined;
    if (c.kind === "pax") {
      if (c.size !== data!.length) bad("a pax header is not as long as it says");
      pax = strictPax(data!);
      return;
    }
    out.set(c.key, {
      type: c.type,
      size: c.size,
      ...(c.type === "symlink" ? { linkTarget: Buffer.from(c.link).toString("utf8") } : {}),
      ...(c.type === "file" && data ? { data } : {}),
    });
  };
  for await (const chunk of gz) {
    total += chunk.length;
    if (total > o.maxUnpackedBytes) bad("archive is too large");
    pending = pending.length === 0 ? (chunk as Buffer) : Buffer.concat([pending, chunk as Buffer]);
    for (;;) {
      if (zeroBlocks >= 2) {
        // The two zero blocks END the archive: whatever follows, even zeros, is refused.
        if (pending.length > 0) bad("there is data after the end of the archive");
        break;
      }
      if (cur === undefined) {
        if (pending.length < BLOCK) break;
        const h = take(BLOCK);
        if (zero(h, 0, BLOCK)) {
          zeroBlocks += 1;
          continue;
        }
        if (zeroBlocks !== 0) bad("a zero block is followed by data");
        header(h);
        if (cur!.left === 0 && cur!.pad === 0) finish();
        continue;
      }
      const c: Cur = cur;
      if (c.left > 0) {
        if (pending.length === 0) break;
        const n = Math.min(c.left, pending.length);
        const piece = take(n);
        c.keep?.push(Buffer.from(piece));
        c.left -= n;
        if (c.left > 0) break;
      }
      if (c.pad > 0) {
        if (pending.length < c.pad) break;
        if (!zero(take(c.pad), 0, c.pad)) bad("padding after file data is not zero");
        c.pad = 0;
      }
      finish();
    }
  }
  if (zeroBlocks !== 2 || cur !== undefined || pending.length > 0)
    bad("the archive is cut short or has no end");
  if (pax) bad("a pax header is not followed by an entry");
  return out;
}

/** The checksum a header should carry, as the six octal digits the field holds. */
function octalOf(h: Uint8Array, _off: number): string {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return sum.toString(8).padStart(6, "0");
}
