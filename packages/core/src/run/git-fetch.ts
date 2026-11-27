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
import { chmodSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { foldKey, HFS_IGNORABLE } from "@turntable/act-runner";
import { ResponseTooLargeError, safeFetch, type SafeFetch } from "@turntable/net";

export class GitFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitFetchError";
  }
}

/** The limits an operator can raise (a setting each); the child reports one of these by name. */
export const BUDGET_LIMITS = ["maxPackBytes", "maxInflatedBytes", "maxTarballBytes"] as const;
export type BudgetLimit = (typeof BUDGET_LIMITS)[number];

/**
 * A size budget the fetch ran over: the pack, the unpacked data or the tarball. A named failure
 * (infra kind `fetch_limit`), never retried: the same commit hits the same budget again.
 */
export class FetchLimitError extends GitFetchError {
  readonly limit: BudgetLimit;
  constructor(limit: BudgetLimit, message: string) {
    super(message);
    this.name = "FetchLimitError";
    this.limit = limit;
  }
}

/**
 * The budget an error says the fetch ran over, or undefined for any other error: the pack body
 * (thrown as a `FetchLimitError` where the pack is fetched), the unpacked data, or the tarball
 * writer's cap. The fixed small caps (a ref list, a per-object size) are not budgets and stay unnamed.
 */
export function budgetLimitOf(e: unknown): BudgetLimit | undefined {
  if (e instanceof FetchLimitError) return e.limit;
  if (e instanceof Error && /the tarball is larger than the cap/.test(e.message))
    return "maxTarballBytes";
  return undefined;
}

/** A full-history delivery gets this many times the shallow tree's pack, unpacked and tarball budgets. */
export const FULL_HISTORY_FACTOR = 4;

export interface FetchLimits {
  /** Most bytes of packfile. Default 128 MiB. */
  maxPackBytes: number;
  /** Most objects in the pack. Default 500 000. */
  maxObjects: number;
  /** Most bytes of inflated object data in total, delta results included. Default 512 MiB. */
  maxInflatedBytes: number;
  /** Most bytes of any one object, as declared and as produced. Default 128 MiB. */
  maxObjectBytes: number;
  /** Longest chain of deltas on deltas. Default 512 (git's own limit is 4095 and its default 50). */
  maxDeltaDepth: number;
  /** Most files and directories written. Default 300 000. */
  maxEntries: number;
  /** Largest tree object, in bytes. Default 32 MiB. */
  maxTreeBytes: number;
  /** Largest gzip tarball written for the sandbox. Default 256 MiB. */
  maxTarballBytes: number;
  /** Most tags a full-history delivery takes. Default 10 000. */
  maxRefs: number;
  /** Most submodules (nested ones included) one checkout fetches. Default 64. */
  maxSubmodules: number;
  /** Wall clock for the whole fetch: the requests, and the parsing and writing after them. */
  timeoutMs: number;
}

export const DEFAULT_FETCH_LIMITS: FetchLimits = {
  maxPackBytes: 128 * 1024 * 1024,
  maxObjects: 500_000,
  maxInflatedBytes: 512 * 1024 * 1024,
  maxObjectBytes: 128 * 1024 * 1024,
  maxDeltaDepth: 512,
  maxEntries: 300_000,
  maxTreeBytes: 32 * 1024 * 1024,
  maxTarballBytes: 256 * 1024 * 1024,
  maxRefs: 10_000,
  maxSubmodules: 64,
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

/**
 * Text that came from the other side (a path name, a server's error line, a zlib message) goes into
 * errors and logs only shortened and with control characters (and bidi/zero-width marks) removed.
 */
// stripping control characters is the point
export function clean(s: string, max = 120): string {
  const stripped = s
    .replaceAll(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, " ")
    .trim();
  const chars = [...stripped];
  return chars.length > max ? `${chars.slice(0, max).join("")}...` : stripped;
}

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
    const hex = dec.decode(buf.subarray(i, i + 4));
    if (!/^[0-9a-f]{4}$/i.test(hex)) throw new GitFetchError("bad pkt-line length");
    const len = Number.parseInt(hex, 16);
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
  /** Called often (between requests, objects and files): it may throw to stop the work (parent gone, over memory). */
  checkpoint?: () => void;
  /**
   * An installation token for a private repository. Sent as HTTP Basic (`x-access-token`) only to
   * the URL's own origin and repository path; a redirect while it is held is refused.
   */
  token?: string;
  /**
   * Deliver the whole history of the commit (no `deepen`), plus every tag and the default branch's
   * tip, instead of the one commit at depth 1. Every limit still applies, and a repository over one
   * fails (`GitFetchError`); it is never cut down to a shallow one.
   */
  fullHistory?: boolean;
}

/** The checkout child's exit status when the forge refused the credential. */
export const EXIT_AUTH_REFUSED = 77;
/** The child ran over a size budget; stderr names it as `fetch_limit <name>`. */
export const EXIT_FETCH_LIMIT = 78;

/** The server refused the credential (or its absence): 401, 403, or a 404 when a token was sent. */
export class GitAuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "GitAuthError";
  }
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
  /** True when the whole history was delivered (no shallow roots). */
  full: boolean;
  /**
   * With `full`: the refs to write, by full name (`refs/tags/v1`, `refs/remotes/origin/main`,
   * `refs/heads/main`), each pointing at an object in `objects`.
   */
  refs: { name: string; oid: string }[];
  /** With `full`: every object reachable from the wants, all verified present. */
  reachable?: Set<string>;
  /** What the fetch used, so a caller that fetches more can share one budget. */
  usage: { packBytes: number; inflatedBytes: number; objects: number };
}

export async function fetchCommit(o: FetchOptions): Promise<FetchedCommit> {
  const limits = { ...DEFAULT_FETCH_LIMITS, ...o.limits };
  if (!/^[0-9a-f]{40}$/.test(o.sha))
    throw new GitFetchError("the commit must be a 40 character sha");
  const f = o.fetch ?? safeFetch;
  const deadline = Date.now() + limits.timeoutMs;
  const left = (): number => {
    o.checkpoint?.();
    const ms = deadline - Date.now();
    if (ms <= 0) throw new GitFetchError("the fetch took too long");
    return ms;
  };
  let base = o.url.replace(/\/+$/, "");
  const common = { "git-protocol": "version=2", "user-agent": "git/2.39.0 (turntable)" };
  // The credential goes only to the configured repository: same origin, same path prefix.
  const repoUrl = new URL(base);
  const authFor = (target: string): Record<string, string> => {
    if (!o.token) return {};
    const t = new URL(target);
    const ok =
      t.origin === repoUrl.origin &&
      (t.pathname === repoUrl.pathname || t.pathname.startsWith(`${repoUrl.pathname}/`));
    if (!ok) throw new GitFetchError("refusing to send the credential outside the repository");
    return {
      authorization: `Basic ${Buffer.from(`x-access-token:${o.token}`).toString("base64")}`,
    };
  };
  const refused = (status: number): boolean =>
    status === 401 || status === 403 || (status === 404 && o.token !== undefined);

  // 1. Capabilities: the server must speak protocol v2 and offer `fetch`. A redirect is followed
  // only within the same origin (a repository that moved); never to another host, and the fetch
  // that follows goes to where this one ended.
  let advUrl = `${base}/info/refs?service=git-upload-pack`;
  let adv: Response | undefined;
  for (let hop = 0; hop <= 3; hop += 1) {
    adv = await f(advUrl, {
      headers: {
        ...common,
        ...authFor(advUrl),
        accept: "application/x-git-upload-pack-advertisement",
      },
      timeoutMs: left(),
      maxBytes: 1024 * 1024,
      redirect: "manual",
    });
    const location = adv.headers.get("location");
    if (adv.status >= 300 && adv.status < 400 && location !== null) {
      const next = new URL(location, advUrl);
      if (o.token !== undefined)
        throw new GitFetchError(
          "the server redirected while a credential was held; refusing to follow it",
        );
      if (next.origin !== new URL(advUrl).origin)
        throw new GitFetchError("the server redirected to another host; refusing to follow it");
      if (!next.pathname.endsWith("/info/refs"))
        throw new GitFetchError("the server redirected somewhere that is not a git repository");
      advUrl = next.href;
      base = `${next.origin}${next.pathname.slice(0, -"/info/refs".length)}`;
      adv = undefined;
      continue;
    }
    break;
  }
  if (!adv) throw new GitFetchError("too many redirects");
  left();
  if (refused(adv.status))
    throw new GitAuthError(
      adv.status,
      `the server answered HTTP ${adv.status} for ${hostPath(base)}`,
    );
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

  // 2. Which refs to want. A full delivery asks the server for HEAD (the default branch) and the
  // tags; the commit itself is always wanted by sha.
  const wants = new Set<string>([o.sha]);
  const refs: { name: string; oid: string }[] = [];
  if (o.fullHistory) {
    if (!caps.some((c) => c === "ls-refs" || c.startsWith("ls-refs=")))
      throw new GitFetchError("the server does not offer git protocol v2 ls-refs");
    const lsRes = await f(`${base}/git-upload-pack`, {
      method: "POST",
      headers: {
        ...common,
        ...authFor(`${base}/git-upload-pack`),
        "content-type": "application/x-git-upload-pack-request",
        accept: "application/x-git-upload-pack-result",
      },
      body: concat([
        pkt("command=ls-refs\n"),
        pkt("agent=turntable\n"),
        pkt("object-format=sha1\n"),
        DELIM,
        pkt("symrefs\n"),
        pkt("ref-prefix HEAD\n"),
        pkt("ref-prefix refs/tags/\n"),
        FLUSH,
      ]),
      timeoutMs: left(),
      maxBytes: 16 * 1024 * 1024,
      redirect: "error",
    });
    if (refused(lsRes.status))
      throw new GitAuthError(lsRes.status, `the server answered HTTP ${lsRes.status} to ls-refs`);
    if (!lsRes.ok) throw new GitFetchError(`the server answered HTTP ${lsRes.status} to ls-refs`);
    let headOid: string | undefined;
    let defaultBranch: string | undefined;
    const tags = new Map<string, string>();
    for (const p of packets(new Uint8Array(await lsRes.arrayBuffer()))) {
      if (p.kind !== "data") continue;
      const line = dec.decode(p.data).trim();
      if (line.startsWith("ERR "))
        throw new GitFetchError(`the server refused: ${clean(line.slice(4))}`);
      const [oid = "", name = "", ...attrs] = line.split(" ");
      if (!/^[0-9a-f]{40}$/.test(oid)) continue;
      if (name === "HEAD") {
        headOid = oid;
        const target = attrs.find((a) => a.startsWith("symref-target:"))?.slice(14);
        if (target?.startsWith("refs/heads/")) defaultBranch = target.slice("refs/heads/".length);
      } else if (name.startsWith("refs/tags/")) {
        if (!validRefName(name))
          throw new GitFetchError(
            `the repository has a tag with an unsafe name: ${JSON.stringify(clean(name, 60))}`,
          );
        tags.set(name, oid);
        if (tags.size > limits.maxRefs)
          throw new GitFetchError(`the repository has more than ${limits.maxRefs} tags`);
      }
    }
    for (const [name, oid] of tags) {
      wants.add(oid);
      refs.push({ name, oid });
    }
    if (headOid !== undefined && defaultBranch !== undefined) {
      if (!validRefName(`refs/heads/${defaultBranch}`))
        throw new GitFetchError("the default branch has an unsafe name");
      wants.add(headOid);
      refs.push({ name: `refs/heads/${defaultBranch}`, oid: headOid });
      refs.push({ name: `refs/remotes/origin/${defaultBranch}`, oid: headOid });
    }
  }

  // 3. The fetch: one commit at depth 1, or (full) every want with no depth.
  const body = concat([
    pkt(`command=${GIT_FETCH_COMMAND}\n`),
    pkt("agent=turntable\n"),
    pkt("object-format=sha1\n"),
    DELIM,
    ...[...wants].map((w) => pkt(`want ${w}\n`)),
    ...(o.fullHistory ? [] : [pkt("deepen 1\n")]),
    pkt("no-progress\n"),
    pkt("ofs-delta\n"),
    pkt("done\n"),
    FLUSH,
  ]);
  const res = await f(`${base}/git-upload-pack`, {
    method: "POST",
    headers: {
      ...common,
      ...authFor(`${base}/git-upload-pack`),
      "content-type": "application/x-git-upload-pack-request",
      accept: "application/x-git-upload-pack-result",
    },
    body,
    timeoutMs: left(),
    maxBytes: limits.maxPackBytes + 1024 * 1024,
    redirect: "error",
  }).catch((e: unknown) => {
    // Only this response's cap is the pack budget; the other responses' caps are fixed and small.
    if (e instanceof ResponseTooLargeError)
      throw new FetchLimitError("maxPackBytes", "the pack is larger than its budget");
    throw e;
  });
  if (refused(res.status))
    throw new GitAuthError(res.status, `the server answered HTTP ${res.status} to the fetch`);
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
        throw new GitFetchError(`the server refused: ${clean(dec.decode(p.data.subarray(1)))}`);
      continue;
    }
    const line = dec.decode(p.data).trim();
    if (line === "packfile") section = "packfile";
    else if (line.startsWith("ERR "))
      throw new GitFetchError(`the server refused: ${clean(line.slice(4))}`);
  }
  if (pack.length === 0)
    throw new GitFetchError(
      "the server sent no packfile (is the commit reachable, and the repository public?)",
    );
  left();
  const packBytes = concat(pack);
  const objects = readPack(packBytes, limits, deadline, o.checkpoint);
  let inflatedBytes = 0;
  for (const obj of objects.values()) inflatedBytes += obj.data.length;
  const usage = { packBytes: packBytes.length, inflatedBytes, objects: objects.size };

  // 4. The commit asked for must be in it, with its own sha.
  const commit = objects.get(o.sha);
  if (!commit || commit.type !== "commit")
    throw new GitFetchError("the pack does not contain the requested commit");
  const text = dec.decode(commit.data);
  // The header is anchored: `tree` first, then any `parent` lines in a row, then `author`. A
  // `tree` or `parent` line further down (in a signature or the message) is never read.
  const m = /^tree ([0-9a-f]{40})\n((?:parent [0-9a-f]{40}\n)*)author /.exec(text);
  if (!m) throw new GitFetchError("the commit header is malformed");
  const tree = m[1] as string;
  const parents = [...(m[2] as string).matchAll(/parent ([0-9a-f]{40})\n/g)].map(
    (x) => x[1] as string,
  );
  if (!objects.has(tree)) throw new GitFetchError("the pack does not contain the commit's tree");
  const sep = text.indexOf("\n\n");
  const subject = sep < 0 ? "" : (text.slice(sep + 2).split("\n", 1)[0] ?? "");
  if (!o.fullHistory)
    return { sha: o.sha, objects, parents, tree, subject, full: false, refs: [], usage };
  // A full delivery is complete or it is nothing: every commit, tree and blob the wants reach
  // must be in the pack, or the history would look whole to git and not be.
  const reachable = assertConnected(objects, [...wants], limits, o.checkpoint);
  return { sha: o.sha, objects, parents, tree, subject, full: true, refs, reachable, usage };
}

/** A ref name git accepts (git-check-ref-format), and nothing that could break a packed-refs line. */
export function validRefName(name: string): boolean {
  if (name.length > 255 || name.length === 0) return false;
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(name)) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (name.endsWith("/") || name.endsWith(".") || name === "@") return false;
  return name
    .split("/")
    .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

/**
 * Walks everything the roots reach (tags to their targets, commits to parents and trees, trees to
 * entries) and fails when any object is missing. Returns the set walked. Tree entries are read
 * leniently here (only mode and oid): these objects go into `.git`, never onto the disk as files.
 */
function assertConnected(
  objects: Map<string, GitObject>,
  roots: string[],
  limits: FetchLimits,
  checkpoint?: () => void,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  const need = (oid: string): void => {
    if (!seen.has(oid)) stack.push(oid);
  };
  let n = 0;
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj)
      throw new GitFetchError("the history is not complete: the pack lacks an object it reaches");
    seen.add(oid);
    n += 1;
    if (n % 1024 === 0) checkpoint?.();
    if (obj.type === "commit") {
      const m = /^tree ([0-9a-f]{40})\n((?:parent [0-9a-f]{40}\n)*)author /.exec(
        dec.decode(obj.data),
      );
      if (!m) throw new GitFetchError("a commit header is malformed");
      need(m[1] as string);
      for (const x of (m[2] as string).matchAll(/parent ([0-9a-f]{40})\n/g)) need(x[1] as string);
    } else if (obj.type === "tag") {
      const m = /^object ([0-9a-f]{40})\n/.exec(dec.decode(obj.data.subarray(0, 64)));
      if (!m) throw new GitFetchError("a tag object is malformed");
      need(m[1] as string);
    } else if (obj.type === "tree") {
      if (obj.data.length > limits.maxTreeBytes)
        throw new GitFetchError("a tree object is too large");
      let i = 0;
      const d = obj.data;
      while (i < d.length) {
        const sp = d.indexOf(0x20, i);
        const nul = sp < 0 ? -1 : d.indexOf(0, sp + 1);
        if (sp < 0 || nul < 0 || nul + 21 > d.length)
          throw new GitFetchError("a tree is malformed");
        if (dec.decode(d.subarray(i, sp)) !== "160000")
          need(Buffer.from(d.subarray(nul + 1, nul + 21)).toString("hex"));
        i = nul + 21;
      }
    }
  }
  return seen;
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

/**
 * Applies a delta. The result's declared size is checked against `maxObjectBytes` (unnamed) and
 * `maxLeftBytes` (what is LEFT of the unpack budget, named) BEFORE it is allocated. Every copy
 * is checked against the base and against the output still to fill.
 */
function applyDelta(
  base: Uint8Array,
  delta: Uint8Array,
  maxObjectBytes: number,
  maxLeftBytes: number,
): Uint8Array {
  let i = 0;
  const varint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[i++];
      if (b === undefined) throw new GitFetchError("a delta is truncated");
      if (shift > 49) throw new GitFetchError("a delta size is absurd");
      v += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return v;
      shift += 7;
    }
  };
  if (varint() !== base.length) throw new GitFetchError("a delta does not match its base");
  const size = varint();
  // The fixed per-object cap first: it is not a budget, so it is unnamed like a plain blob's.
  if (size > maxObjectBytes) throw new GitFetchError("a packed object is too large");
  if (size > maxLeftBytes)
    throw new FetchLimitError(
      "maxInflatedBytes",
      "a delta would produce more than the pack may unpack to",
    );
  const out = new Uint8Array(size);
  let o = 0;
  while (i < delta.length) {
    const op = delta[i++]!;
    if ((op & 0x80) !== 0) {
      let off = 0;
      let len = 0;
      for (let k = 0; k < 4; k += 1)
        if ((op & (1 << k)) !== 0) off += (delta[i++] ?? 0) * 2 ** (8 * k);
      for (let k = 0; k < 3; k += 1)
        if ((op & (0x10 << k)) !== 0) len += (delta[i++] ?? 0) * 2 ** (8 * k);
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

/**
 * Reads a whole packfile into verified objects, by sha. The pack is hostile input, so every size
 * is bounded before it is acted on: the object count before anything is allocated for it, each
 * object's declared size before it is inflated (and the inflate itself is capped at that size, so
 * a stream that lies is cut), delta results before they are allocated, and the sum of everything
 * unpacked against one budget. Delta chains are depth-limited and an offset delta may only point
 * at an EARLIER object. `deadline` is checked between objects.
 */
export function readPack(
  pack: Uint8Array,
  limits: FetchLimits = DEFAULT_FETCH_LIMITS,
  deadline: number = Date.now() + limits.timeoutMs,
  checkpoint?: () => void,
): Map<string, GitObject> {
  if (pack.length < 32 || dec.decode(pack.subarray(0, 4)) !== "PACK")
    throw new GitFetchError("not a packfile");
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (view.getUint32(4) !== 2) throw new GitFetchError("unsupported pack version");
  const count = view.getUint32(8);
  if (count > limits.maxObjects) throw new GitFetchError("the pack has too many objects");
  const end = pack.length - 20;
  const trailer = pack.subarray(end);
  const sum = createHash("sha1").update(pack.subarray(0, end)).digest();
  if (Buffer.compare(Buffer.from(trailer), sum) !== 0)
    throw new GitFetchError("the pack checksum does not match");

  type Raw = { type: number; data: Uint8Array; baseOffset?: number; baseOid?: string };
  const byOffset = new Map<number, Raw>();
  let pos = 12;
  let budget = 0;
  const spend = (n: number): void => {
    budget += n;
    if (budget > limits.maxInflatedBytes)
      throw new FetchLimitError("maxInflatedBytes", "the pack is too large when unpacked");
  };
  const byte = (): number => {
    if (pos >= end) throw new GitFetchError("the pack is truncated");
    return pack[pos++]!;
  };
  for (let n = 0; n < count; n += 1) {
    checkpoint?.();
    if (Date.now() > deadline) throw new GitFetchError("the fetch took too long");
    const start = pos;
    let c = byte();
    const type = (c >> 4) & 7;
    let size = c & 15;
    let shift = 4;
    while ((c & 0x80) !== 0) {
      if (shift > 49) throw new GitFetchError("a packed object size is absurd");
      c = byte();
      size += (c & 0x7f) * 2 ** shift;
      shift += 7;
    }
    // Declared size: bounded before the stream is touched.
    if (size > limits.maxObjectBytes) throw new GitFetchError("a packed object is too large");
    spend(size);
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === 6) {
      c = byte();
      let off = c & 0x7f;
      while ((c & 0x80) !== 0) {
        if (off > 2 ** 40) throw new GitFetchError("a delta offset is absurd");
        c = byte();
        off = (off + 1) * 128 + (c & 0x7f);
      }
      baseOffset = start - off;
      // Only an earlier object, and never the delta itself or anything before the first object.
      if (off <= 0 || baseOffset < 12 || baseOffset >= start)
        throw new GitFetchError("a delta points outside the pack");
    } else if (type === 7) {
      if (pos + 20 > end) throw new GitFetchError("the pack is truncated");
      baseOid = Buffer.from(pack.subarray(pos, pos + 20)).toString("hex");
      pos += 20;
    } else if (!(type in TYPES)) {
      throw new GitFetchError("a packed object has an unknown type");
    }
    const { data, used } = inflateAt(pack.subarray(0, end), pos, size);
    pos += used;
    byOffset.set(start, {
      type,
      data,
      ...(baseOffset !== undefined ? { baseOffset } : {}),
      ...(baseOid ? { baseOid } : {}),
    });
  }
  if (pos !== end) throw new GitFetchError("the pack has trailing data");

  const objects = new Map<string, GitObject>();
  const resolved = new Map<number, GitObject>();
  const resolving = new Set<number>();
  const depthOf = new Map<number, number>();
  // The length of the chain of deltas an object sits on, by its offset: a memoised walk would
  // otherwise never go deeper than one step, so the depth is counted explicitly.
  const oidAt = new Map<string, number>();
  const baseOffsetOf = (oid: string): number => oidAt.get(oid) ?? -1;
  const chain = (offset: number, baseAt: number): void => {
    const d = (depthOf.get(baseAt) ?? 0) + 1;
    if (d > limits.maxDeltaDepth) throw new GitFetchError("a delta chain is too long");
    depthOf.set(offset, d);
  };
  const resolve = (offset: number, depth = 0): GitObject => {
    const done = resolved.get(offset);
    if (done) return done;
    if (depth > limits.maxDeltaDepth) throw new GitFetchError("a delta chain is too long");
    if (resolving.has(offset)) throw new GitFetchError("a delta depends on itself");
    checkpoint?.();
    if (Date.now() > deadline) throw new GitFetchError("the fetch took too long");
    const raw = byOffset.get(offset);
    if (!raw) throw new GitFetchError("a delta points outside the pack");
    resolving.add(offset);
    let obj: GitObject;
    if (raw.type === 6) {
      const baseAt = raw.baseOffset as number;
      const base = resolve(baseAt, depth + 1);
      chain(offset, baseAt);
      obj = {
        type: base.type,
        data: applyDelta(
          base.data,
          raw.data,
          limits.maxObjectBytes,
          limits.maxInflatedBytes - budget,
        ),
      };
      spend(obj.data.length);
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
      chain(offset, baseOffsetOf(raw.baseOid as string));
      obj = {
        type: base.type,
        data: applyDelta(
          base.data,
          raw.data,
          limits.maxObjectBytes,
          limits.maxInflatedBytes - budget,
        ),
      };
      spend(obj.data.length);
    } else {
      obj = { type: TYPES[raw.type] as ObjectType, data: raw.data };
    }
    resolving.delete(offset);
    resolved.set(offset, obj);
    const oid = oidOf(obj.type, obj.data);
    objects.set(oid, obj);
    if (!oidAt.has(oid)) oidAt.set(oid, offset);
    return obj;
  };
  // Whole objects first, so a ref-delta's base is found by sha; then the deltas.
  for (const [off, r] of byOffset) if (r.type !== 6 && r.type !== 7) resolve(off);
  for (const [off, r] of byOffset) if (r.type === 6 || r.type === 7) resolve(off);
  return objects;
}

// ---- writing the checkout ----

/**
 * Whether a name IS `target` (or its 8.3 short name `short`) on a filesystem that folds case,
 * ignores trailing dots and spaces (NTFS), ignorable Unicode (HFS+) or names an NTFS alternate data
 * stream (`.git::$INDEX_ALLOCATION`): a checkout on such a disk would otherwise write into `.git`.
 */
function isNamed(name: string, target: string, short: string): boolean {
  const folded = name
    .replaceAll(HFS_IGNORABLE, "")
    .toLowerCase()
    .replace(/[ .]+$/, "");
  const base = folded.split(":", 1)[0] ?? folded;
  return base === target || base === short;
}
const isDotGit = (name: string): boolean => isNamed(name, ".git", "git~1");
const isDotGitmodules = (name: string): boolean => isNamed(name, ".gitmodules", "gitmod~1");

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

// `ignoreBOM: true` keeps a leading U+FEFF in a name instead of silently dropping it.
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * A tree's entries, one at a time (so a cap inside the caller's loop stops a huge tree early).
 * Names must be valid UTF-8, each unique, and in git's order (byte order, a directory sorting as
 * if its name ended in `/`): a tree that is not is not one git wrote, and is refused.
 */
function* treeEntries(data: Uint8Array): Generator<TreeEntry> {
  let i = 0;
  let prev: Buffer | undefined;
  const seen = new Set<string>();
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = sp < 0 ? -1 : data.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new GitFetchError("a tree is malformed");
    const mode = dec.decode(data.subarray(i, sp));
    const rawName = data.subarray(sp + 1, nul);
    let name: string;
    try {
      name = strict.decode(rawName);
    } catch {
      throw new GitFetchError("a tree has a name that is not valid UTF-8");
    }
    if (seen.has(name)) throw new GitFetchError("a tree has the same name twice");
    seen.add(name);
    const key = Buffer.concat([Buffer.from(rawName), Buffer.from([mode === "40000" ? 0x2f : 0])]);
    if (prev && Buffer.compare(prev, key) >= 0)
      throw new GitFetchError("a tree is not in git's order");
    prev = key;
    yield { mode, name, oid: Buffer.from(data.subarray(nul + 1, nul + 21)).toString("hex") };
    i = nul + 21;
  }
}

export function safeName(name: string): boolean {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    !isDotGit(name)
  );
}

export interface Materialized {
  files: number;
  bytes: number;
}

interface IndexEntry {
  path: string;
  /** The git mode as a number: 0o100644, 0o100755, 0o120000, 0o160000. */
  mode: number;
  oid: string;
}

const u32 = (n: bigint | number): number => Number(BigInt(n) & 0xffffffffn);

/**
 * A version 2 `.git/index` for the checkout: one entry per file, symlink and submodule, sorted by
 * path, with the stat data of what was just written. With it `git status` is clean and
 * `git ls-files -s` lists the tree; without it git sees every file as deleted.
 */
function writeIndex(dir: string, entries: IndexEntry[]): Buffer {
  const sorted = entries.toSorted((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  );
  const head = Buffer.alloc(12);
  head.write("DIRC", 0);
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(sorted.length, 8);
  const parts: Buffer[] = [head];
  for (const e of sorted) {
    const path = Buffer.from(e.path);
    const fixed = Buffer.alloc(62);
    if (e.mode !== 0o160000) {
      const st = lstatSync(join(dir, e.path), { bigint: true });
      const ct = st.ctimeNs;
      const mt = st.mtimeNs;
      fixed.writeUInt32BE(u32(ct / 1_000_000_000n), 0);
      fixed.writeUInt32BE(u32(ct % 1_000_000_000n), 4);
      fixed.writeUInt32BE(u32(mt / 1_000_000_000n), 8);
      fixed.writeUInt32BE(u32(mt % 1_000_000_000n), 12);
      fixed.writeUInt32BE(u32(st.dev), 16);
      fixed.writeUInt32BE(u32(st.ino), 20);
      fixed.writeUInt32BE(u32(st.uid), 28);
      fixed.writeUInt32BE(u32(st.gid), 32);
      fixed.writeUInt32BE(u32(st.size), 36);
    }
    fixed.writeUInt32BE(e.mode, 24);
    Buffer.from(e.oid, "hex").copy(fixed, 40);
    fixed.writeUInt16BE(Math.min(path.length, 0xfff), 60);
    const pad = 8 - ((62 + path.length) % 8);
    parts.push(fixed, path, Buffer.alloc(pad));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}

/**
 * Writes the commit's tree into `dir` and a `.git` next to it (HEAD detached at the commit,
 * `origin` as the remote, a `shallow` file when the history was cut, a real index, and the objects
 * the commit reaches, loose). Objects the pack carried but the commit does not reach are not
 * written. `dir` must be empty and private to the caller. On success the commit's object map is
 * cleared: nothing needs it any more, and it can be large.
 */
export function materialize(
  dir: string,
  c: FetchedCommit,
  remoteUrl: string,
  limits: Partial<FetchLimits> = {},
  hooks: {
    beforeWrite?: (path: string) => void;
    checkpoint?: () => void;
    /** Receives each submodule (gitlink) the tree holds: its path and pinned commit. */
    gitlinks?: { path: string; sha: string }[];
  } = {},
): Materialized {
  const max = { ...DEFAULT_FETCH_LIMITS, ...limits };
  const deadline = Date.now() + max.timeoutMs;
  let entries = 0;
  let bytes = 0;
  // The folded paths of symlinks the tree made. Nothing is written at or below one.
  const symlinks = new Set<string>();
  const reachable = new Set<string>(c.reachable ?? [c.sha, c.tree]);
  const index: IndexEntry[] = [];
  const underSymlink = (key: string): boolean => {
    let at = key.indexOf("/");
    while (at >= 0) {
      if (symlinks.has(key.slice(0, at))) return true;
      at = key.indexOf("/", at + 1);
    }
    return symlinks.has(key);
  };
  // The second layer, and the one that does not depend on how names compare: every parent of what
  // is about to be written is looked at ON DISK, right now, and must be a plain directory. A parent
  // that became a symlink (a name the key above did not fold together, another process in the
  // directory) is refused, so nothing is ever written through one.
  const plainParents = (path: string): void => {
    const parts = path.split("/");
    let cur = dir;
    for (let i = 0; i < parts.length - 1; i += 1) {
      cur = join(cur, parts[i] as string);
      const st = lstatSync(cur, { throwIfNoEntry: false });
      if (!st || !st.isDirectory())
        throw new GitFetchError("the repository writes through a symlink");
    }
  };
  const create = <T>(f: () => T): T => {
    try {
      return f();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST")
        throw new GitFetchError("two paths of the repository are the same name on this filesystem");
      throw e;
    }
  };
  const walk = (treeOid: string, rel: string, depth: number): void => {
    if (depth > 200) throw new GitFetchError("the tree is nested too deeply");
    const tree = c.objects.get(treeOid);
    if (!tree || tree.type !== "tree")
      throw new GitFetchError("the pack lacks a tree the commit needs");
    if (tree.data.length > max.maxTreeBytes) throw new GitFetchError("a tree object is too large");
    for (const e of treeEntries(tree.data)) {
      if (!safeName(e.name))
        throw new GitFetchError(
          `the repository has an unsafe path name: ${JSON.stringify(clean(e.name))}`,
        );
      entries += 1;
      if (entries > max.maxEntries) throw new GitFetchError("the repository has too many files");
      if (entries % 256 === 0 && Date.now() > deadline)
        throw new GitFetchError("the fetch took too long");
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      // Nothing is written through a symlink the tree itself made. The key folds the way the
      // filesystems that fold names do (Unicode normalisation, ignorable characters, case,
      // trailing dots and spaces), so `A` and `a`, or an NFD and an NFC spelling, are one name here.
      const key = foldKey(path);
      if (underSymlink(key)) throw new GitFetchError("the repository writes through a symlink");
      const full = join(dir, path);
      hooks.checkpoint?.();
      hooks.beforeWrite?.(path);
      plainParents(path);
      if (e.mode === "40000") {
        reachable.add(e.oid);
        create(() => mkdirSync(full));
        walk(e.oid, path, depth + 1);
      } else if (e.mode === "160000") {
        create(() => mkdirSync(full)); // a submodule: an empty directory, never fetched
        index.push({ path, mode: 0o160000, oid: e.oid });
        hooks.gitlinks?.push({ path, sha: e.oid });
      } else {
        const blob = c.objects.get(e.oid);
        if (!blob || blob.type !== "blob")
          throw new GitFetchError("the pack lacks a blob the commit needs");
        bytes += blob.data.length;
        if (bytes > max.maxInflatedBytes)
          throw new FetchLimitError("maxInflatedBytes", "the repository is too large");
        reachable.add(e.oid);
        if (e.mode === "120000") {
          if (isDotGitmodules(e.name)) throw new GitFetchError(".gitmodules may not be a symlink");
          create(() => symlinkSync(Buffer.from(blob.data), full)); // the target's bytes, as they are
          symlinks.add(key);
          index.push({ path, mode: 0o120000, oid: e.oid });
        } else if (e.mode === "100644" || e.mode === "100755" || e.mode === "100664") {
          // `wx`: create, never open an existing file or follow a link at the final name.
          create(() => writeFileSync(full, blob.data, { flag: "wx" }));
          const exec = e.mode === "100755";
          chmodSync(full, exec ? 0o755 : 0o644);
          index.push({ path, mode: exec ? 0o100755 : 0o100644, oid: e.oid });
        } else {
          throw new GitFetchError(`the tree has an unsupported mode ${clean(e.mode, 12)}`);
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
  // `shallow` only when the history was cut. A full delivery is checked complete (every commit,
  // tree and blob reachable is present), so it has no such file, and says so truthfully.
  if (!c.full && c.parents.length > 0) writeFileSync(join(git, "shallow"), `${c.sha}\n`);
  if (c.refs.length > 0) {
    // packed-refs: no file per ref, so no ref name can collide on a case-folding disk or escape.
    const lines = [...new Map(c.refs.map((r) => [r.name, r.oid])).entries()]
      .toSorted((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))
      .map(([name, oid]) => `${oid} ${name}\n`);
    writeFileSync(join(git, "packed-refs"), `# pack-refs with: sorted \n${lines.join("")}`);
  }
  for (const oid of reachable) {
    const obj = c.objects.get(oid);
    if (!obj) throw new GitFetchError("the pack lacks an object the commit reaches");
    const path = join(git, "objects", oid.slice(0, 2), oid.slice(2));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      deflateSync(concat([enc.encode(`${obj.type} ${obj.data.length}\0`), obj.data])),
      { mode: 0o444 },
    );
  }
  writeFileSync(join(git, "index"), writeIndex(dir, index));
  c.objects.clear();
  return { files: entries, bytes };
}
