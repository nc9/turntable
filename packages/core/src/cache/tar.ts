// Validation of a cache archive before it can be restored. actions/cache archives a tar
// (uncompressed, gzip or zstd). A restore extracts it in the job, so a hostile archive is a write
// primitive: `../../` traversal, an absolute path into a startup file, a symlink out of the
// workspace, a device node, a decompression bomb. This reads the tar headers (never the file
// data) and refuses an archive with any of them. It is defence in depth: the class rules already
// keep a privileged job from restoring what a lower class wrote.
import { createReadStream } from "node:fs";
import { createGunzip, createZstdDecompress } from "node:zlib";
import type { Readable } from "node:stream";

export type ArchiveRules = {
  /** Absolute paths are allowed only under one of these prefixes. */
  absoluteRoots: readonly string[];
  /** Most entries in an archive. */
  maxEntries: number;
  /** Most bytes after decompression. */
  maxUncompressed: number;
};

export const DEFAULT_RULES: ArchiveRules = {
  // actions/cache stores paths outside the workspace (~/.npm, ~/.cache) as absolute paths.
  absoluteRoots: ["/home/", "/root/", "/github/home/", "/workspace/", "/tmp/"],
  maxEntries: 500_000,
  maxUncompressed: 16 * 1024 ** 3,
};

/**
 * What a cache must never write, as one maintained list (a test covers every entry): git state
 * and CI config anywhere in a path, keys, and the startup and credential files of shells and
 * tools. An entry whose path contains any of these is refused, and so is a link that points at or
 * through one.
 */
export const DENIED_COMPONENTS: readonly string[] = [
  ".git",
  ".github",
  ".ssh",
  ".gnupg",
  ".longshore",
];
/** Files denied by name wherever they sit. */
export const DENIED_FILES: readonly string[] = [
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".profile",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "bunfig.toml",
  ".gitconfig",
  ".netrc",
  ".pypirc",
];
/** Denied when the two components follow each other (a directory and what is in it). */
export const DENIED_SEQUENCES: readonly (readonly [string, string])[] = [
  [".docker", "config.json"],
  [".config", "fish"],
  [".config", "git"],
  [".config", "gh"],
];

/** Whether any part of the path is denied. */
export function deniedPath(parts: readonly string[]): boolean {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (DENIED_COMPONENTS.includes(p)) return true;
    if (DENIED_FILES.includes(p)) return true;
    const n = parts[i + 1];
    if (n !== undefined && DENIED_SEQUENCES.some(([x, y]) => x === p && y === n)) return true;
  }
  return false;
}

export class ArchiveError extends Error {}
/** The output or its expansion went past a cap: the commit is refused with 413. */
export class ArchiveTooLargeError extends ArchiveError {}

/**
 * Normalises a tar path without touching the file system: collapses `.` and rejects `..`.
 * `denied` says the path names a denied location (see `deniedPath`): an entry like that is
 * dropped, but a link may not point at one, so the caller decides.
 */
function pathOf(raw: string, rules: ArchiveRules): { norm: string; denied: boolean } {
  if (raw.includes("\0")) throw new ArchiveError("path contains a NUL byte");
  if (raw.length === 0 || raw.length > 4096) throw new ArchiveError("path length is invalid");
  const absolute = raw.startsWith("/");
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) throw new ArchiveError(`path escapes its root: ${raw.slice(0, 120)}`);
  const norm = (absolute ? "/" : "") + parts.join("/");
  if (absolute && !rules.absoluteRoots.some((r) => norm.startsWith(r)))
    throw new ArchiveError(`absolute path outside the allowed roots: ${raw.slice(0, 120)}`);
  return { norm, denied: deniedPath(parts) };
}

/** A path that must not be denied: link targets. */
function checkPath(raw: string, rules: ArchiveRules): string {
  const { norm, denied } = pathOf(raw, rules);
  if (denied) throw new ArchiveError(`path is not allowed in a cache: ${raw.slice(0, 120)}`);
  return norm;
}

/**
 * A symlink target is resolved against the directory the link sits in, one component at a time.
 * It must stay inside that tree (or, if absolute, under an allowed root), never name a denied
 * location, and never pass through a link the archive already made, at any step.
 */
function checkSymlink(
  entryPath: string,
  target: string,
  rules: ArchiveRules,
  links: ReadonlySet<string>,
): void {
  if (target.includes("\0") || target === "") throw new ArchiveError("link target is invalid");
  // An absolute entry sits under one of the allowed roots, and its link may not leave that root:
  // not by an absolute target elsewhere, and not by climbing out with `..`.
  const root = entryPath.startsWith("/")
    ? rules.absoluteRoots.find((r) => entryPath.startsWith(r))
    : undefined;
  const within = (resolved: string): boolean =>
    root === undefined || `${resolved}/`.startsWith(root);
  if (target.startsWith("/")) {
    const norm = checkPath(target, rules);
    if (!within(norm)) throw new ArchiveError("link target leaves the root its entry is under");
    if (runsThroughLink(norm, links))
      throw new ArchiveError("link target runs through a link the archive made");
    return;
  }
  const abs = entryPath.startsWith("/");
  const base = entryPath.split("/").slice(0, -1);
  const stack = abs ? base.slice(1) : base;
  const here = () => (abs ? "/" : "") + stack.join("/");
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0)
        throw new ArchiveError(`link escapes its root: ${target.slice(0, 120)}`);
      stack.pop();
    } else stack.push(part);
    if (!within(here()))
      throw new ArchiveError(`link escapes the root its entry is under: ${target.slice(0, 120)}`);
    if (links.has(here()))
      throw new ArchiveError("link target runs through a link the archive made");
    if (deniedPath(stack)) throw new ArchiveError("link points at a path not allowed in a cache");
  }
}

/**
 * A hardlink target names another entry in the archive, resolved from the archive root (not from
 * the entry's directory): the way tar resolves it. So it is checked as a path of its own.
 */
function checkHardlink(target: string, rules: ArchiveRules): string {
  if (target === "") throw new ArchiveError("link target is invalid");
  return checkPath(target, rules);
}

/** Whether `norm` is, or sits below, a link the archive already created. */
function runsThroughLink(norm: string, links: ReadonlySet<string>): boolean {
  const parts = norm.split("/").filter(Boolean);
  let cur = norm.startsWith("/") ? "/" : "";
  for (const p of parts) {
    cur = cur === "" || cur === "/" ? cur + p : `${cur}/${p}`;
    if (links.has(cur)) return true;
  }
  return false;
}

const text = (b: Buffer, from: number, len: number): string => {
  const slice = b.subarray(from, from + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul < 0 ? slice.length : nul).toString("utf8");
};

function octal(b: Buffer, from: number, len: number): number {
  const t = text(b, from, len).trim();
  if (t === "") return 0;
  // GNU base-256 sizes (high bit set) are only used for files over 8 GiB: refuse them.
  if ((b[from]! & 0x80) !== 0) throw new ArchiveError("unsupported large size encoding");
  if (!/^[0-7]+$/.test(t)) throw new ArchiveError("bad number in tar header");
  return Number.parseInt(t, 8);
}

/** The decompression stream for an archive, picked by its leading bytes. */
export function archiveStream(file: string, head: Buffer): Readable {
  const raw = createReadStream(file);
  if (head[0] === 0x1f && head[1] === 0x8b) return raw.pipe(createGunzip());
  if (head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd)
    return raw.pipe(createZstdDecompress());
  return raw;
}

/** An entry that passed every rule, in the form our own writer re-emits it. */
export type CanonEntry = {
  type: "file" | "dir" | "symlink" | "hardlink";
  /** Normalised path (a leading `/` only for the allowed absolute roots). */
  name: string;
  /** Link target: normalised from the root for a hardlink, as written for a symlink. */
  link: string;
  mode: number;
  mtime: number;
  size: number;
};

export type Sink = {
  entry(e: CanonEntry): void | Promise<void>;
  data(b: Buffer): void | Promise<void>;
};

/** Reads the whole tar's headers and throws ArchiveError for the first unsafe entry. */
export function validateArchive(
  file: string,
  rules: ArchiveRules = DEFAULT_RULES,
): Promise<{ entries: number; bytes: number; skipped: number }> {
  return walkArchive(file, rules);
}

export async function walkArchive(
  file: string,
  rules: ArchiveRules,
  sink?: Sink,
): Promise<{ entries: number; bytes: number; skipped: number }> {
  const fd = await Bun.file(file).slice(0, 8).arrayBuffer();
  const stream = archiveStream(file, Buffer.from(fd));
  let buf: Buffer = Buffer.alloc(0);
  let dataLeft = 0; // file data bytes still to forward
  let dropData = false; // the bytes of a dropped entry are read and discarded
  let skipped = 0; // entries dropped for a denied path
  let padLeft = 0; // padding bytes still to drop
  let emit: CanonEntry | undefined;
  let paxMtime: number | undefined;
  let entries = 0;
  let total = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  let paxPath: string | undefined;
  let paxLink: string | undefined;
  let paxSize: number | undefined;
  /** Every link (symlink or hardlink) the archive has created so far, by normalised path. */
  const links = new Set<string>();
  let metaData: { kind: "L" | "K" | "x"; left: number; chunks: Buffer[]; pad: number } | undefined;
  let zeroBlocks = 0;

  const header = (h: Buffer): void => {
    if (h.every((x) => x === 0)) {
      zeroBlocks++;
      return;
    }
    zeroBlocks = 0;
    // A tar header checksum guards against reading garbage as headers.
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (sum !== octal(h, 148, 8)) throw new ArchiveError("corrupt tar header");
    const type = String.fromCharCode(h[156] === 0 ? 48 : h[156]!);
    const hdrSize = octal(h, 124, 12);
    // Only the three known header layouts are read: POSIX ustar, GNU, and V7 (no magic at all).
    const magic = h.subarray(257, 265);
    const isPosix = magic.equals(Buffer.from("ustar\0" + "00"));
    const isGnu = magic.equals(Buffer.from("ustar  \0"));
    if (!isPosix && !isGnu && !magic.every((x) => x === 0))
      throw new ArchiveError("unknown tar header format");
    // The prefix field is a name component only in POSIX ustar ("ustar\0" and version "00").
    // GNU tar's format ("ustar  \0") reuses those bytes for other data, so it is ignored there:
    // reading it as a prefix would walk the archive differently from tar.
    const prefix = isPosix ? text(h, 345, 155) : "";
    const name0 = text(h, 0, 100);
    if (type === "L" || type === "K" || type === "x") {
      if (hdrSize > 1024 * 1024) throw new ArchiveError("tar metadata record is too large");
      metaData = { kind: type, left: hdrSize, chunks: [], pad: (512 - (hdrSize % 512)) % 512 };
      return;
    }
    // Only these entry types are understood. Anything else (sparse files, PAX global headers,
    // volume labels, devices, fifos) is refused rather than guessed at.
    if (!["0", "7", "5", "1", "2"].includes(type))
      throw new ArchiveError(
        `entry type ${JSON.stringify(type)} is not allowed: ${(paxPath ?? longName ?? name0).slice(0, 120)}`,
      );
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${name0}` : name0);
    const link = paxLink ?? longLink ?? text(h, 157, 100);
    // A PAX size overrides the header's, as it does in tar; links and directories carry no data.
    const size = paxSize ?? hdrSize;
    if ((type === "1" || type === "2" || type === "5") && (size !== 0 || hdrSize !== 0))
      throw new ArchiveError(
        `a link or directory entry with data is refused: ${name.slice(0, 120)}`,
      );
    longName = undefined;
    longLink = undefined;
    paxPath = undefined;
    paxLink = undefined;
    paxSize = undefined;
    const mtime0 = paxMtime ?? octal(h, 136, 12);
    paxMtime = undefined;
    entries++;
    if (entries > rules.maxEntries) throw new ArchiveError("too many entries");
    const { norm, denied } = pathOf(name, rules);
    // A name that normalises to nothing ("./", "/") is the archive root: a directory entry for it
    // is dropped, and anything else with such a name is refused. We never emit one.
    if (norm === "" || norm === "/") {
      if (type !== "5") throw new ArchiveError("an entry with an empty name is refused");
      entries--;
      return;
    }
    if (denied) {
      // An entry at a denied location (git state, CI config, keys, startup files; an npm package
      // may ship a `.github` directory) is dropped from what is stored, and counted. What is
      // never accepted is a link that points at one: that is checked on the link's target.
      skipped++;
      entries--;
      total += size;
      if (total > rules.maxUncompressed)
        throw new ArchiveTooLargeError("archive is too large when unpacked");
      dataLeft = size;
      padLeft = (512 - (size % 512)) % 512;
      dropData = size > 0;
      return;
    }
    if (runsThroughLink(norm, links))
      throw new ArchiveError(`entry runs through a link the archive made: ${name.slice(0, 120)}`);
    let checkedHard = "";
    if (type === "1") {
      const target = checkHardlink(link, rules);
      checkedHard = target;
      if (runsThroughLink(target, links))
        throw new ArchiveError(`hardlink target runs through a link: ${link.slice(0, 120)}`);
      links.add(norm);
    } else if (type === "2") {
      checkSymlink(norm, link, rules, links);
      links.add(norm);
    }
    total += size;
    if (total > rules.maxUncompressed)
      throw new ArchiveTooLargeError("archive is too large when unpacked");
    dataLeft = size;
    padLeft = (512 - (size % 512)) % 512;
    emit = {
      type: type === "5" ? "dir" : type === "1" ? "hardlink" : type === "2" ? "symlink" : "file",
      name: norm,
      link: type === "1" ? checkedHard : link,
      // Setuid, setgid and sticky bits never survive: the client sees plain permissions.
      mode: octal(h, 100, 8) & 0o777,
      mtime: mtime0,
      size,
    };
  };

  /** PAX keys that cannot change how the archive is walked or where it extracts. */
  const PAX_PLAIN = new Set(["mtime", "atime", "ctime", "uid", "gid", "uname", "gname"]);

  const finishMeta = (): void => {
    const m = metaData!;
    const data = Buffer.concat(m.chunks);
    if (m.kind === "L") longName = data.toString("utf8").replace(/\0+$/, "");
    else if (m.kind === "K") longLink = data.toString("utf8").replace(/\0+$/, "");
    else {
      // PAX records: "<len> key=value\n". Unknown keys are refused: an extension we do not
      // understand (GNU.sparse.*, SCHILY.*, ...) may change how tar reads the archive.
      let rest = data;
      while (rest.length > 0) {
        const sp = rest.indexOf(0x20);
        const len = sp < 0 ? Number.NaN : Number.parseInt(rest.subarray(0, sp).toString(), 10);
        if (!Number.isInteger(len) || len <= sp + 1 || len > rest.length)
          throw new ArchiveError("bad PAX record");
        const rec = rest.subarray(sp + 1, len - 1).toString("utf8");
        const eq = rec.indexOf("=");
        if (eq <= 0) throw new ArchiveError("bad PAX record");
        const k = rec.slice(0, eq);
        const v = rec.slice(eq + 1);
        if (k === "path") paxPath = v;
        else if (k === "linkpath") paxLink = v;
        else if (k === "size") {
          if (!/^[0-9]{1,15}$/.test(v)) throw new ArchiveError("bad PAX size");
          paxSize = Number(v);
        } else if (k === "mtime") {
          if (!/^[0-9]{1,15}(\.[0-9]{1,9})?$/.test(v)) throw new ArchiveError("bad PAX mtime");
          paxMtime = Math.floor(Number(v));
        } else if (!PAX_PLAIN.has(k))
          throw new ArchiveError(`PAX key ${JSON.stringify(k.slice(0, 40))} is not allowed`);
        rest = rest.subarray(len);
      }
    }
    padLeft = m.pad;
    metaData = undefined;
  };

  try {
    for await (const chunk of stream) {
      buf = buf.length === 0 ? (chunk as Buffer) : Buffer.concat([buf, chunk as Buffer]);
      for (;;) {
        if (dataLeft > 0) {
          const n = Math.min(dataLeft, buf.length);
          if (n > 0 && !dropData) await sink?.data(buf.subarray(0, n));
          dataLeft -= n;
          buf = buf.subarray(n);
          if (dataLeft > 0) break;
          dropData = false;
        }
        if (padLeft > 0) {
          const n = Math.min(padLeft, buf.length);
          padLeft -= n;
          buf = buf.subarray(n);
          if (padLeft > 0) break;
        }
        if (metaData) {
          const n = Math.min(metaData.left, buf.length);
          metaData.chunks.push(buf.subarray(0, n));
          metaData.left -= n;
          buf = buf.subarray(n);
          if (metaData.left > 0) break;
          finishMeta();
          continue;
        }
        if (buf.length < 512) break;
        header(buf.subarray(0, 512));
        buf = buf.subarray(512);
        if (emit) {
          const e = emit;
          emit = undefined;
          await sink?.entry(e);
        }
        if (zeroBlocks >= 2) {
          stream.destroy();
          if (entries === 0)
            throw new ArchiveError(
              skipped > 0
                ? `archive has no entries left after dropping ${skipped} at paths not allowed in a cache`
                : "archive has no entries",
            );
          return { entries, bytes: total, skipped };
        }
      }
    }
  } catch (e) {
    if (e instanceof ArchiveError) throw e;
    throw new ArchiveError(`unreadable archive: ${e instanceof Error ? e.message : "error"}`);
  }
  if (dataLeft > 0 || metaData) throw new ArchiveError("archive is truncated");
  if (entries === 0)
    throw new ArchiveError(
      skipped > 0
        ? `archive has no entries left after dropping ${skipped} at paths not allowed in a cache`
        : "archive has no entries",
    );
  return { entries, bytes: total, skipped };
}
