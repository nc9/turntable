// Safe unpacking of an artifact zip, for the release lane. The zip is only transport: what gets
// signed is the files inside it, by name and sha256 of their bytes. Everything in the archive is
// untrusted, so this reads the central directory itself (no dependency, no library that extracts
// on its own) and refuses anything that is not a plain file or directory with a plain name:
//
// - an absolute path, a drive letter, a backslash, a NUL, an empty, `.` or `..` segment, or a name
//   outside `A-Za-z0-9._/+-` (the alphabet the store and the lane read names by, and up to 190 characters);
// - a symlink, a device, a fifo, a socket or a Windows reparse point (a zip cannot say "hardlink",
//   so there is nothing to follow, but an entry that claims any link type is refused all the same);
// - a duplicate name (compared case-insensitively too), or a name that is both a file and a
//   directory;
// - more than MAX_FILES entries or more than MAX_TOTAL_BYTES of uncompressed data, counted from
//   the declared sizes before anything is inflated and enforced again while inflating;
// - encryption, zip64, split archives, any method but stored and deflate, a local header that
//   disagrees with the central directory, overlapping entries, a bad CRC.
//
// Files are written into a directory the caller just created and nothing else writes to, with
// `wx` (never overwriting) and mode 0600, so a path can only ever land inside it.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

/** Most entries (files and directories) an artifact zip may hold. */
export const MAX_FILES = 10_000;
/** Most uncompressed bytes all of an artifact zip's files may add up to (2 GiB). */
export const MAX_TOTAL_BYTES = 2 * 1024 ** 3;

export type UnpackLimits = { maxFiles?: number; maxTotalBytes?: number };

export type UnpackCode =
  | "corrupt"
  | "unsupported"
  | "unsafe_path"
  | "link"
  | "special_file"
  | "duplicate"
  | "path_conflict"
  | "too_many_files"
  | "too_large";

export class UnpackError extends Error {
  readonly code: UnpackCode;
  constructor(code: UnpackCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

export type UnpackedFile = { name: string; size: number; sha256: string };

/** The alphabet the artifact store and the lane read names by (release/artifacts.ts), a little shorter. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,189}$/;

/** Whether the bytes start like a zip: a local file header, or the end record of an empty one. */
export function looksLikeZip(b: Uint8Array): boolean {
  return (
    b.length >= 4 &&
    b[0] === 0x50 &&
    b[1] === 0x4b &&
    ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6))
  );
}

type Entry = {
  name: string;
  dir: boolean;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
};

const bad = (code: UnpackCode, detail: string): never => {
  throw new UnpackError(code, detail);
};

function checkName(raw: string, dir: boolean): string {
  const name = dir ? raw.slice(0, -1) : raw;
  if (name === "" || raw.includes("\0") || raw.includes("\\") || name.startsWith("/"))
    return bad("unsafe_path", JSON.stringify(raw.slice(0, 80)));
  if (/^[A-Za-z]:/.test(name)) return bad("unsafe_path", "drive letter");
  for (const seg of name.split("/"))
    if (seg === "" || seg === "." || seg === "..")
      return bad("unsafe_path", JSON.stringify(raw.slice(0, 80)));
  if (!NAME.test(name)) return bad("unsafe_path", `name ${JSON.stringify(raw.slice(0, 80))}`);
  return name;
}

function readDirectory(b: Buffer, limits: Required<UnpackLimits>): Entry[] {
  // The end record must be the last thing in the file: a comment is allowed, trailing bytes are not.
  let eocd = -1;
  for (let p = b.length - 22; p >= Math.max(0, b.length - 22 - 0xffff); p--) {
    if (b.readUInt32LE(p) === 0x06054b50 && p + 22 + b.readUInt16LE(p + 20) === b.length) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) return bad("corrupt", "no end of central directory");
  const disk = b.readUInt16LE(eocd + 4);
  const cdDisk = b.readUInt16LE(eocd + 6);
  const here = b.readUInt16LE(eocd + 8);
  const total = b.readUInt16LE(eocd + 10);
  const cdSize = b.readUInt32LE(eocd + 12);
  const cdOffset = b.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || here !== total) return bad("unsupported", "split archive");
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    return bad("unsupported", "zip64");
  if (total > limits.maxFiles) return bad("too_many_files", `${total} entries`);
  if (cdOffset + cdSize !== eocd) return bad("corrupt", "central directory is not where it says");

  const entries: Entry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > eocd || b.readUInt32LE(p) !== 0x02014b50) return bad("corrupt", "central entry");
    const madeBy = b.readUInt16LE(p + 4);
    const flags = b.readUInt16LE(p + 8);
    const method = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    const csize = b.readUInt32LE(p + 20);
    const usize = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const diskStart = b.readUInt16LE(p + 34);
    const external = b.readUInt32LE(p + 38);
    const offset = b.readUInt32LE(p + 42);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > eocd) return bad("corrupt", "central entry runs past the directory");
    if (flags & 0x41) return bad("unsupported", "encrypted entry");
    if (diskStart !== 0) return bad("unsupported", "split archive");
    if (method !== 0 && method !== 8) return bad("unsupported", `method ${method}`);
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff)
      return bad("unsupported", "zip64");
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(p + 46, p + 46 + nameLen));
    } catch {
      return bad("unsafe_path", "name is not UTF-8");
    }
    // The Unix mode sits in the top half of the external attributes. Whatever host wrote the
    // entry, a link or special type there is refused; so is a Windows reparse point.
    const type = (external >>> 16) & 0o170000;
    if (type === 0o120000) return bad("link", `symlink ${JSON.stringify(raw.slice(0, 80))}`);
    if ((external & 0x400) !== 0 && madeBy >> 8 !== 3)
      return bad("link", `reparse point ${JSON.stringify(raw.slice(0, 80))}`);
    if (type !== 0 && type !== 0o100000 && type !== 0o040000)
      return bad(
        "special_file",
        `${JSON.stringify(raw.slice(0, 80))} (mode type ${type.toString(8)})`,
      );
    const dir = raw.endsWith("/");
    if (dir !== (type === 0o040000) && type !== 0)
      return bad("special_file", `${JSON.stringify(raw.slice(0, 80))} (type and name disagree)`);
    const name = checkName(raw, dir);
    if (dir && (usize !== 0 || csize > 2)) return bad("corrupt", "directory with data");
    entries.push({ name, dir, method, crc, csize, usize, offset });
    p = end;
  }
  if (p !== eocd) return bad("corrupt", "bytes after the last central entry");
  return entries;
}

function checkNames(entries: readonly Entry[]): void {
  const seen = new Map<string, boolean>();
  const folded = new Set<string>();
  for (const e of entries) {
    const key = e.name.toLowerCase();
    if (seen.has(e.name) || folded.has(key)) return bad("duplicate", e.name);
    seen.set(e.name, e.dir);
    folded.add(key);
  }
  // A file may not also be a directory on the way to another entry.
  for (const e of entries) {
    const parts = e.name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      if (seen.get(parent) === false)
        return bad("path_conflict", `${parent} is a file and a directory`);
    }
  }
}

/**
 * Checks `zip` and writes its files under `dest` (a directory the caller created fresh, which
 * nothing else writes to). Returns each file's name, size and sha256, computed from the inflated
 * bytes, sorted by name. Throws UnpackError for anything the header comment lists; on a throw,
 * files may already have been written, so the caller removes `dest`.
 */
export async function unpackZip(
  zip: Uint8Array,
  dest: string,
  limits: UnpackLimits = {},
): Promise<UnpackedFile[]> {
  const lim = {
    maxFiles: limits.maxFiles ?? MAX_FILES,
    maxTotalBytes: limits.maxTotalBytes ?? MAX_TOTAL_BYTES,
  };
  const b = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  if (b.length < 22) return bad("corrupt", "too short to be a zip");
  const entries = readDirectory(b, lim);
  checkNames(entries);
  const files = entries.filter((e) => !e.dir);
  // Before anything is inflated: the sizes the archive declares must fit.
  let declared = 0;
  for (const e of files) {
    declared += e.usize;
    if (declared > lim.maxTotalBytes) return bad("too_large", `over ${lim.maxTotalBytes} bytes`);
  }
  // First pass, nothing inflated or written: every local header must agree with the central
  // directory, and no two entries may share bytes (a bomb's shape).
  const placed = files.map((e) => {
    if (e.offset + 30 > b.length || b.readUInt32LE(e.offset) !== 0x04034b50)
      return bad("corrupt", `local header of ${e.name}`);
    const nameLen = b.readUInt16LE(e.offset + 26);
    const extraLen = b.readUInt16LE(e.offset + 28);
    if (b.readUInt16LE(e.offset + 6) & 0x41) return bad("unsupported", "encrypted entry");
    const local = b.subarray(e.offset + 30, e.offset + 30 + nameLen).toString("utf8");
    if (local !== e.name) return bad("corrupt", `local header of ${e.name} names another file`);
    const start = e.offset + 30 + nameLen + extraLen;
    const end = start + e.csize;
    if (end > b.length) return bad("corrupt", `data of ${e.name} runs past the archive`);
    return { e, start, end, from: e.offset };
  });
  const byOffset = placed.toSorted((x, y) => x.from - y.from);
  for (let i = 1; i < byOffset.length; i++)
    if (byOffset[i]!.from < byOffset[i - 1]!.end) return bad("corrupt", "overlapping entries");

  const root = resolve(dest);
  const out: UnpackedFile[] = [];
  let actual = 0;
  for (const { e, start, end } of placed) {
    const data = b.subarray(start, end);
    let bytes: Buffer;
    if (e.method === 0) {
      if (e.csize !== e.usize) return bad("corrupt", `${e.name} is stored with two sizes`);
      bytes = data;
    } else {
      try {
        // Never more than the size it declared, so a bomb stops at its own claim.
        bytes = inflateRawSync(data, { maxOutputLength: Math.max(1, e.usize) });
      } catch {
        return bad("corrupt", `${e.name} does not inflate to its declared size`);
      }
    }
    if (bytes.length !== e.usize) return bad("corrupt", `${e.name} has the wrong size`);
    if (crc32(bytes) !== e.crc) return bad("corrupt", `${e.name} fails its CRC`);
    actual += bytes.length;
    if (actual > lim.maxTotalBytes) return bad("too_large", `over ${lim.maxTotalBytes} bytes`);

    const path = resolve(root, e.name);
    if (!path.startsWith(root + sep)) return bad("unsafe_path", e.name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const fh = await open(path, "wx", 0o600);
    try {
      await fh.writeFile(bytes);
    } finally {
      await fh.close();
    }
    out.push({
      name: e.name,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return out.toSorted((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

/**
 * The files of a zip, by path and declared size, after the same checks `unpackZip` makes of the
 * directory (names, links, duplicates, counts, declared sizes). Nothing is inflated.
 */
export function listZipFiles(
  zip: Uint8Array,
  limits: UnpackLimits = {},
): { name: string; size: number }[] {
  const lim = {
    maxFiles: limits.maxFiles ?? MAX_FILES,
    maxTotalBytes: limits.maxTotalBytes ?? MAX_TOTAL_BYTES,
  };
  const b = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  if (b.length < 22) return bad("corrupt", "too short to be a zip");
  const entries = readDirectory(b, lim);
  checkNames(entries);
  let declared = 0;
  const files = entries.filter((e) => !e.dir);
  for (const e of files) {
    declared += e.usize;
    if (declared > lim.maxTotalBytes) return bad("too_large", `over ${lim.maxTotalBytes} bytes`);
  }
  return files
    .map((e) => ({ name: e.name, size: e.usize }))
    .toSorted((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

/**
 * The bytes of ONE file of a zip, read in memory with every check `unpackZip` makes: the whole
 * directory is validated first, then only this entry is inflated (never past the size it declared),
 * its local header must agree with the directory and its CRC must hold. Undefined when the zip has
 * no such file; throws UnpackError for anything unsafe. Nothing is written to disk.
 */
export function readZipFile(
  zip: Uint8Array,
  name: string,
  limits: UnpackLimits & { maxFileBytes?: number } = {},
): Uint8Array | undefined {
  const files = listZipFiles(zip, limits);
  if (!files.some((f) => f.name === name)) return undefined;
  const b = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const e = readDirectory(b, {
    maxFiles: limits.maxFiles ?? MAX_FILES,
    maxTotalBytes: limits.maxTotalBytes ?? MAX_TOTAL_BYTES,
  }).find((x) => !x.dir && x.name === name)!;
  if (e.usize > (limits.maxFileBytes ?? MAX_TOTAL_BYTES))
    return bad("too_large", `${e.name} is over the size a file may be read at`);
  if (e.offset + 30 > b.length || b.readUInt32LE(e.offset) !== 0x04034b50)
    return bad("corrupt", `local header of ${e.name}`);
  const nameLen = b.readUInt16LE(e.offset + 26);
  const extraLen = b.readUInt16LE(e.offset + 28);
  if (b.readUInt16LE(e.offset + 6) & 0x41) return bad("unsupported", "encrypted entry");
  if (b.subarray(e.offset + 30, e.offset + 30 + nameLen).toString("utf8") !== e.name)
    return bad("corrupt", `local header of ${e.name} names another file`);
  const start = e.offset + 30 + nameLen + extraLen;
  const end = start + e.csize;
  if (end > b.length) return bad("corrupt", `data of ${e.name} runs past the archive`);
  const data = b.subarray(start, end);
  let bytes: Buffer;
  if (e.method === 0) {
    if (e.csize !== e.usize) return bad("corrupt", `${e.name} is stored with two sizes`);
    bytes = data;
  } else {
    try {
      bytes = inflateRawSync(data, { maxOutputLength: Math.max(1, e.usize) });
    } catch {
      return bad("corrupt", `${e.name} does not inflate to its declared size`);
    }
  }
  if (bytes.length !== e.usize) return bad("corrupt", `${e.name} has the wrong size`);
  if (crc32(bytes) !== e.crc) return bad("corrupt", `${e.name} fails its CRC`);
  return new Uint8Array(bytes);
}

/** A fresh, private directory under `root` for one unpack. */
export async function freshUnpackDir(root: string, label: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(join(root, `${label.replace(/[^A-Za-z0-9]/g, "")}-`));
}
