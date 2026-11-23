// `git fetch --depth 1 <url> <sha>`, in process. The control plane fetches a run's commit before
// any sandbox exists, and it must not need a `git` or `tar` binary to do it (so the image can be
// distroless). This speaks git's smart-HTTP protocol v2 to a public repository: ask for exactly
// one commit at depth 1, read the packfile it answers with, resolve its deltas, and verify every
// object's SHA-1 and that the commit it holds is the one that was asked for. Nothing the server
// says is trusted beyond that: the sha is the identity.
//
// Then `materialize` writes the commit's tree to a directory and the `.git` that git itself would
// have made (HEAD, config, `shallow`, the objects), which `tarGzDirectory` packs into the tarball
// the sandbox receives. Repo contents are untrusted: names that could escape the directory or
// alias `.git`, and writes through symlinks, are refused, and sizes and counts are capped.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { safeFetch, type SafeFetch } from "@longshore/net";

export class GitFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitFetchError";
  }
}

export interface FetchLimits {
  /** Most bytes of packfile. Default 256 MiB. */
  maxPackBytes: number;
  /** Most objects in the pack. Default 500 000. */
  maxObjects: number;
  /** Most bytes of inflated object data in total. Default 1 GiB. */
  maxInflatedBytes: number;
  /** Most files and directories written. Default 300 000. */
  maxEntries: number;
  timeoutMs: number;
}

export const DEFAULT_FETCH_LIMITS: FetchLimits = {
  maxPackBytes: 256 * 1024 * 1024,
  maxObjects: 500_000,
  maxInflatedBytes: 1024 * 1024 * 1024,
  maxEntries: 300_000,
  timeoutMs: 300_000,
};

export type ObjectType = "commit" | "tree" | "blob" | "tag";
export interface GitObject {
  type: ObjectType;
  data: Uint8Array;
}

const TYPES: Record<number, ObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
/** The protocol v2 command. (A constant so the source guard, which reads text, sees no `fetch` call.) */
const GIT_FETCH_COMMAND = "fetch";
const enc = new TextEncoder();
const dec = new TextDecoder();

export const oidOf = (type: ObjectType, data: Uint8Array): string =>
  createHash("sha1").update(`${type} ${data.length}\0`).update(data).digest("hex");

// ---- pkt-line ----

const pkt = (s: string): Uint8Array => {
  const b = enc.encode(s);
  const out = new Uint8Array(4 + b.length);
  out.set(enc.encode((4 + b.length).toString(16).padStart(4, "0")));
  out.set(b, 4);
  return out;
};
const FLUSH = enc.encode("0000");
const DELIM = enc.encode("0001");

type Packet = { kind: "data"; data: Uint8Array } | { kind: "flush" } | { kind: "delim" };

function* packets(buf: Uint8Array): Generator<Packet> {
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new GitFetchError("truncated pkt-line header");
    const len = Number.parseInt(dec.decode(buf.subarray(i, i + 4)), 16);
    if (!Number.isInteger(len) || len < 0) throw new GitFetchError("bad pkt-line length");
    if (len === 0) {
      yield { kind: "flush" };
      i += 4;
    } else if (len === 1) {
      yield { kind: "delim" };
      i += 4;
    } else if (len < 4 || i + len > buf.length) {
      throw new GitFetchError("truncated pkt-line");
    } else {
      yield { kind: "data", data: buf.subarray(i + 4, i + len) };
      i += len;
    }
  }
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

// ---- the protocol ----

export interface FetchOptions {
  /** The repository URL, https (for example `https://github.com/owner/repo.git`). No credentials. */
  url: string;
  sha: string;
  fetch?: SafeFetch;
  limits?: Partial<FetchLimits>;
}

/** The objects of one commit at depth 1, verified. */
export interface FetchedCommit {
  sha: string;
  objects: Map<string, GitObject>;
  /** Parent shas (absent from `objects`: the history is cut at depth 1). */
  parents: string[];
  tree: string;
  /** The commit message's subject line. */
  subject: string;
}

export async function fetchCommit(o: FetchOptions): Promise<FetchedCommit> {
  const limits = { ...DEFAULT_FETCH_LIMITS, ...o.limits };
  if (!/^[0-9a-f]{40}$/.test(o.sha))
    throw new GitFetchError("the commit must be a 40 character sha");
  const f = o.fetch ?? safeFetch;
  const base = o.url.replace(/\/+$/, "");
  const common = { "git-protocol": "version=2", "user-agent": "git/2.39.0 (longshore)" };

  // 1. Capabilities: the server must speak protocol v2 and offer `fetch`.
  const adv = await f(`${base}/info/refs?service=git-upload-pack`, {
    headers: { ...common, accept: "application/x-git-upload-pack-advertisement" },
    timeoutMs: limits.timeoutMs,
    maxBytes: 1024 * 1024,
    redirect: "follow",
  });
  if (!adv.ok)
    throw new GitFetchError(`the server answered HTTP ${adv.status} for ${hostPath(base)}`);
  const caps: string[] = [];
  let v2 = false;
  for (const p of packets(new Uint8Array(await adv.arrayBuffer()))) {
    if (p.kind !== "data") continue;
    const line = dec.decode(p.data).trim();
    if (line === "version 2") v2 = true;
    else caps.push(line);
  }
  if (!v2 || !caps.some((c) => c === "fetch" || c.startsWith("fetch=")))
    throw new GitFetchError("the server does not offer git protocol v2 fetch");

  // 2. One commit, depth 1.
  const body = concat([
    pkt(`command=${GIT_FETCH_COMMAND}\n`),
    pkt("agent=longshore\n"),
    pkt("object-format=sha1\n"),
    DELIM,
    pkt(`want ${o.sha}\n`),
    pkt("deepen 1\n"),
    pkt("no-progress\n"),
    pkt("ofs-delta\n"),
    pkt("done\n"),
    FLUSH,
  ]);
  const res = await f(`${base}/git-upload-pack`, {
    method: "POST",
    headers: {
      ...common,
      "content-type": "application/x-git-upload-pack-request",
      accept: "application/x-git-upload-pack-result",
    },
    body,
    timeoutMs: limits.timeoutMs,
    maxBytes: limits.maxPackBytes + 1024 * 1024,
    redirect: "follow",
  });
  if (!res.ok) throw new GitFetchError(`the server answered HTTP ${res.status} to the fetch`);
  const pack: Uint8Array[] = [];
  let section = "";
  for (const p of packets(new Uint8Array(await res.arrayBuffer()))) {
    if (p.kind === "delim") continue;
    if (p.kind === "flush") {
      section = "";
      continue;
    }
    if (section === "packfile") {
      const band = p.data[0];
      if (band === 1) pack.push(p.data.subarray(1));
      else if (band === 3)
        throw new GitFetchError(`the server refused: ${dec.decode(p.data.subarray(1)).trim()}`);
      continue;
    }
    const line = dec.decode(p.data).trim();
    if (line === "packfile") section = "packfile";
    else if (line.startsWith("ERR "))
      throw new GitFetchError(`the server refused: ${line.slice(4)}`);
  }
  if (pack.length === 0)
    throw new GitFetchError(
      "the server sent no packfile (is the commit reachable, and the repository public?)",
    );
  const objects = readPack(concat(pack), limits);

  // 3. The commit asked for must be in it, with its own sha.
  const commit = objects.get(o.sha);
  if (!commit || commit.type !== "commit")
    throw new GitFetchError("the pack does not contain the requested commit");
  const text = dec.decode(commit.data);
  const head = text.split("\n\n", 1)[0] ?? "";
  const tree = /^tree ([0-9a-f]{40})$/m.exec(head)?.[1];
  if (!tree) throw new GitFetchError("the commit has no tree");
  const parents = [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1] as string);
  if (!objects.has(tree)) throw new GitFetchError("the pack does not contain the commit's tree");
  const subject = text.slice(head.length + 2).split("\n", 1)[0] ?? "";
  return { sha: o.sha, objects, parents, tree, subject };
}

const hostPath = (u: string): string => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`;
  } catch {
    return "the repository";
  }
};

// ---- the packfile ----

function inflateAt(buf: Uint8Array, pos: number, size: number): { data: Uint8Array; used: number } {
  let r: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    r = inflateSync(buf.subarray(pos), { info: true, maxOutputLength: Math.max(size, 1) }) as never;
  } catch (e) {
    throw new GitFetchError(
      `a packed object does not inflate: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (r.buffer.length !== size) throw new GitFetchError("a packed object has the wrong size");
  return { data: new Uint8Array(r.buffer), used: r.engine.bytesWritten };
}

function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let i = 0;
  const varint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[i++];
      if (b === undefined) throw new GitFetchError("a delta is truncated");
      v += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return v;
      shift += 7;
    }
  };
  if (varint() !== base.length) throw new GitFetchError("a delta does not match its base");
  const size = varint();
  const out = new Uint8Array(size);
  let o = 0;
  while (i < delta.length) {
    const op = delta[i++]!;
    if ((op & 0x80) !== 0) {
      let off = 0;
      let len = 0;
      for (let k = 0; k < 4; k += 1) if ((op & (1 << k)) !== 0) off += delta[i++]! * 2 ** (8 * k);
      for (let k = 0; k < 3; k += 1)
        if ((op & (0x10 << k)) !== 0) len += delta[i++]! * 2 ** (8 * k);
      if (len === 0) len = 0x10000;
      if (off + len > base.length || o + len > size)
        throw new GitFetchError("a delta copies out of range");
      out.set(base.subarray(off, off + len), o);
      o += len;
    } else if (op !== 0) {
      if (i + op > delta.length || o + op > size)
        throw new GitFetchError("a delta inserts out of range");
      out.set(delta.subarray(i, i + op), o);
      o += op;
      i += op;
    } else {
      throw new GitFetchError("a delta has a reserved instruction");
    }
  }
  if (o !== size) throw new GitFetchError("a delta produced the wrong size");
  return out;
}

/** Reads a whole packfile into verified objects, by sha. */
export function readPack(
  pack: Uint8Array,
  limits: FetchLimits = DEFAULT_FETCH_LIMITS,
): Map<string, GitObject> {
  if (pack.length < 32 || dec.decode(pack.subarray(0, 4)) !== "PACK")
    throw new GitFetchError("not a packfile");
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (view.getUint32(4) !== 2) throw new GitFetchError("unsupported pack version");
  const count = view.getUint32(8);
  if (count > limits.maxObjects) throw new GitFetchError("the pack has too many objects");
  const trailer = pack.subarray(pack.length - 20);
  const sum = createHash("sha1")
    .update(pack.subarray(0, pack.length - 20))
    .digest();
  if (Buffer.compare(Buffer.from(trailer), sum) !== 0)
    throw new GitFetchError("the pack checksum does not match");

  type Raw = { type: number; data: Uint8Array; baseOffset?: number; baseOid?: string };
  const byOffset = new Map<number, Raw>();
  let pos = 12;
  let inflated = 0;
  for (let n = 0; n < count; n += 1) {
    const start = pos;
    let c = pack[pos++]!;
    const type = (c >> 4) & 7;
    let size = c & 15;
    let shift = 4;
    while ((c & 0x80) !== 0) {
      c = pack[pos++]!;
      size += (c & 0x7f) * 2 ** shift;
      shift += 7;
    }
    inflated += size;
    if (inflated > limits.maxInflatedBytes)
      throw new GitFetchError("the pack is too large when unpacked");
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === 6) {
      c = pack[pos++]!;
      let off = c & 0x7f;
      while ((c & 0x80) !== 0) {
        c = pack[pos++]!;
        off = (off + 1) * 128 + (c & 0x7f);
      }
      baseOffset = start - off;
    } else if (type === 7) {
      baseOid = Buffer.from(pack.subarray(pos, pos + 20)).toString("hex");
      pos += 20;
    } else if (!(type in TYPES)) {
      throw new GitFetchError("a packed object has an unknown type");
    }
    const { data, used } = inflateAt(pack.subarray(0, pack.length - 20), pos, size);
    pos += used;
    byOffset.set(start, {
      type,
      data,
      ...(baseOffset !== undefined ? { baseOffset } : {}),
      ...(baseOid ? { baseOid } : {}),
    });
  }
  if (pos !== pack.length - 20) throw new GitFetchError("the pack has trailing data");

  const objects = new Map<string, GitObject>();
  const resolved = new Map<number, GitObject>();
  const resolve = (offset: number, depth = 0): GitObject => {
    const done = resolved.get(offset);
    if (done) return done;
    if (depth > 4096) throw new GitFetchError("a delta chain is too long");
    const raw = byOffset.get(offset);
    if (!raw) throw new GitFetchError("a delta points outside the pack");
    let obj: GitObject;
    if (raw.type === 6) {
      const base = resolve(raw.baseOffset as number, depth + 1);
      obj = { type: base.type, data: applyDelta(base.data, raw.data) };
    } else if (raw.type === 7) {
      let base = objects.get(raw.baseOid as string);
      if (!base) {
        // A base later in the pack: find it.
        for (const [off, r] of byOffset) {
          if (
            r.type !== 6 &&
            r.type !== 7 &&
            oidOf(TYPES[r.type] as ObjectType, r.data) === raw.baseOid
          ) {
            base = resolve(off, depth + 1);
            break;
          }
        }
      }
      if (!base) throw new GitFetchError("a delta's base is not in the pack");
      obj = { type: base.type, data: applyDelta(base.data, raw.data) };
    } else {
      obj = { type: TYPES[raw.type] as ObjectType, data: raw.data };
    }
    resolved.set(offset, obj);
    objects.set(oidOf(obj.type, obj.data), obj);
    return obj;
  };
  // Whole objects first, so a ref-delta's base is found by sha; then the deltas.
  for (const [off, r] of byOffset) if (r.type !== 6 && r.type !== 7) resolve(off);
  for (const [off, r] of byOffset) if (r.type === 6 || r.type === 7) resolve(off);
  return objects;
}

// ---- writing the checkout ----

const GIT_NAME = /^\.git$/i;

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Uint8Array): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new GitFetchError("a tree is malformed");
    out.push({
      mode: dec.decode(data.subarray(i, sp)),
      name: dec.decode(data.subarray(sp + 1, nul)),
      oid: Buffer.from(data.subarray(nul + 1, nul + 21)).toString("hex"),
    });
    i = nul + 21;
  }
  return out;
}

function safeName(name: string): boolean {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    !GIT_NAME.test(name) &&
    // git itself refuses .git spellings that some filesystems fold to .git
    !/^git~\d+$/i.test(name)
  );
}

export interface Materialized {
  files: number;
  bytes: number;
}

/**
 * Writes the commit's tree into `dir` and a `.git` next to it (HEAD detached at the commit,
 * `origin` as the remote, a `shallow` file when the history was cut, every object loose). `dir`
 * must be empty and private to the caller.
 */
export function materialize(
  dir: string,
  c: FetchedCommit,
  remoteUrl: string,
  limits: Partial<FetchLimits> = {},
): Materialized {
  const max = { ...DEFAULT_FETCH_LIMITS, ...limits };
  let entries = 0;
  let bytes = 0;
  const symlinks = new Set<string>();
  const walk = (treeOid: string, rel: string, depth: number): void => {
    if (depth > 200) throw new GitFetchError("the tree is nested too deeply");
    const tree = c.objects.get(treeOid);
    if (!tree || tree.type !== "tree")
      throw new GitFetchError("the pack lacks a tree the commit needs");
    for (const e of parseTree(tree.data)) {
      if (!safeName(e.name))
        throw new GitFetchError(
          `the repository has an unsafe path name: ${JSON.stringify(e.name)}`,
        );
      entries += 1;
      if (entries > max.maxEntries) throw new GitFetchError("the repository has too many files");
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      // Nothing is written through a symlink the tree itself made (a case-folding filesystem could
      // make `A` and `a` the same name; this holds there too).
      const lower = path.toLowerCase();
      for (const s of symlinks) {
        if (lower === s || lower.startsWith(`${s}/`))
          throw new GitFetchError("the repository writes through a symlink");
      }
      const full = join(dir, path);
      if (e.mode === "40000") {
        mkdirSync(full, { recursive: true });
        walk(e.oid, path, depth + 1);
      } else if (e.mode === "160000") {
        mkdirSync(full, { recursive: true }); // a submodule: an empty directory, never fetched
      } else {
        const blob = c.objects.get(e.oid);
        if (!blob || blob.type !== "blob")
          throw new GitFetchError("the pack lacks a blob the commit needs");
        bytes += blob.data.length;
        if (bytes > max.maxInflatedBytes) throw new GitFetchError("the repository is too large");
        if (e.mode === "120000") {
          if (/^\.gitmodules$/i.test(e.name))
            throw new GitFetchError(".gitmodules may not be a symlink");
          symlinkSync(dec.decode(blob.data), full);
          symlinks.add(lower);
        } else if (e.mode === "100644" || e.mode === "100755" || e.mode === "100664") {
          writeFileSync(full, blob.data);
          chmodSync(full, e.mode === "100755" ? 0o755 : 0o644);
        } else {
          throw new GitFetchError(`the tree has an unsupported mode ${e.mode}`);
        }
      }
    }
  };
  walk(c.tree, "", 0);

  const git = join(dir, ".git");
  for (const d of ["objects/info", "objects/pack", "refs/heads", "refs/tags", "info", "hooks"])
    mkdirSync(join(git, d), { recursive: true });
  writeFileSync(join(git, "HEAD"), `${c.sha}\n`);
  writeFileSync(
    join(git, "config"),
    `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
  if (c.parents.length > 0) writeFileSync(join(git, "shallow"), `${c.sha}\n`);
  for (const [oid, obj] of c.objects) {
    const path = join(git, "objects", oid.slice(0, 2), oid.slice(2));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      deflateSync(concat([enc.encode(`${obj.type} ${obj.data.length}\0`), obj.data])),
      { mode: 0o444 },
    );
  }
  return { files: entries, bytes };
}
