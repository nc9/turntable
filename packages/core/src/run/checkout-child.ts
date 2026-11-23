// The parent side of a checkout: run it in a child process (this same binary, `fetch-source`),
// under one deadline, a resident-memory ceiling, a concurrency limit and the attempt's cancellation.
// What is enforced where:
//   - the deadline and cancellation: everywhere; the child is killed with SIGKILL;
//   - the memory ceiling: on Linux, by polling the child's VmRSS from /proc every 200 ms and
//     killing it above the ceiling. On other systems (macOS, development) there is no such reading
//     and the ceiling is not enforced; the in-process budgets (pack, unpacked, per-object, tree and
//     tarball caps) still bound what the child can ask for;
//   - the child holds no secret: its environment is scrubbed, and it gets everything it needs as
//     arguments.
import { constants, readFileSync } from "node:fs";
import { lstat, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubbedEnv } from "@turntable/provider-sdk";
import { clean, DEFAULT_FETCH_LIMITS, type FetchLimits } from "./git-fetch";

export interface CheckoutConfig {
  /** Child's wall clock, in ms. Default 5 minutes. */
  timeoutMs: number;
  /** Child's resident memory ceiling in MiB (Linux only). Default 1536; 0 turns it off. */
  memoryMb: number;
  /** Checkouts running at once. Default 2. */
  concurrency: number;
  limits: Partial<FetchLimits>;
}

export const DEFAULT_CHECKOUT_CONFIG: CheckoutConfig = {
  timeoutMs: 300_000,
  memoryMb: 1536,
  concurrency: 2,
  limits: {},
};

const MIB = 1024 * 1024;

/**
 * The environment a checkout child gets: the base allowlist (PATH and the like) and, so the child
 * reaches GitHub the way the server does, the TLS trust and proxy settings. Nothing else: no
 * Turntable setting, no token, no key. (Env only: the child still runs as the server's user. See
 * docs/security.mdx.)
 */
export const CHILD_ENV_PASSTHROUGH: readonly string[] = [
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
];

let warnedNoRss = false;
/** Says once, when the ceiling is on but the system gives no way to read the child's memory. */
function warnNoRssOnce(log: (m: string) => void): void {
  if (warnedNoRss) return;
  warnedNoRss = true;
  log(
    "checkout memory ceiling is on but the child's resident memory cannot be read here (no /proc): the ceiling is not enforced; the pack, unpacked and tarball caps still apply",
  );
}

/** The checkout settings from the environment (all optional; a bad value stops the server at start). */
export function checkoutConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): CheckoutConfig {
  const num = (name: string, min: number, max: number): number | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`${name} must be a whole number from ${min} to ${max}`);
    return n;
  };
  const cfg: CheckoutConfig = { ...DEFAULT_CHECKOUT_CONFIG, limits: {} };
  const t = num("TURNTABLE_CHECKOUT_TIMEOUT_SECONDS", 10, 3600);
  if (t !== undefined) cfg.timeoutMs = t * 1000;
  const mem = num("TURNTABLE_CHECKOUT_MAX_MEMORY_MIB", 0, 65536);
  if (mem !== undefined) cfg.memoryMb = mem;
  const c = num("TURNTABLE_CHECKOUT_CONCURRENCY", 1, 16);
  if (c !== undefined) cfg.concurrency = c;
  const pack = num("TURNTABLE_CHECKOUT_MAX_PACK_MIB", 1, 4096);
  if (pack !== undefined) cfg.limits.maxPackBytes = pack * MIB;
  const unpacked = num("TURNTABLE_CHECKOUT_MAX_UNPACKED_MIB", 1, 16384);
  if (unpacked !== undefined) cfg.limits.maxInflatedBytes = unpacked * MIB;
  const tarball = num("TURNTABLE_CHECKOUT_MAX_TARBALL_MIB", 1, 4096);
  if (tarball !== undefined) cfg.limits.maxTarballBytes = tarball * MIB;
  return cfg;
}

/** Counts a limited number of holders; the rest wait their turn. */
export class Semaphore {
  #free: number;
  #waiting: (() => void)[] = [];
  constructor(n: number) {
    this.#free = n;
  }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    while (this.#free <= 0) {
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = (): void => {
          this.#waiting = this.#waiting.filter((w) => w !== wake);
          reject(new Error("the checkout was cancelled while it waited for its turn"));
        };
        if (signal?.aborted) return onAbort();
        this.#waiting.push(wake);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    this.#free -= 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#free += 1;
      this.#waiting.shift()?.();
    };
  }
}

/** Resident set size of a process in bytes, from /proc (Linux); undefined where there is none. */
export function readRss(pid: number): number | undefined {
  try {
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) * 1024 : undefined;
  } catch {
    return undefined;
  }
}

/** The command that runs this program again: the compiled binary itself, or bun with the entry file. */
export function selfCommand(): string[] {
  const compiled = Bun.main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN/.test(Bun.main);
  return compiled ? [process.execPath] : [process.execPath, Bun.main];
}

export interface ChildRequest {
  owner: string;
  repo: string;
  sha: string;
  url?: string;
  dir: string;
  out: string;
  allowHosts?: readonly string[];
  config?: Partial<CheckoutConfig>;
  signal?: AbortSignal | undefined;
  /** The program to run, default `selfCommand()`. */
  command?: string[];
  /** Test seams. */
  rss?: (pid: number) => number | undefined;
  pollMs?: number;
  /** How long to wait for a killed child to be gone before giving up on it. Default 5 s. */
  killWaitMs?: number;
  spawn?: typeof Bun.spawn;
  log?: (m: string) => void;
}

export interface ChildResult {
  sha: string;
  files: number;
  tarballBytes: number;
}

async function readCapped(stream: ReadableStream<Uint8Array> | null, cap: number): Promise<string> {
  if (!stream) return "";
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of stream) {
    if (n < cap) chunks.push(c.subarray(0, cap - n));
    n += c.length;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Runs the checkout in a child and waits for it. Throws, with the reason in short clean words, on any failure. */
export async function runCheckoutChild(r: ChildRequest): Promise<ChildResult> {
  const cfg = { ...DEFAULT_CHECKOUT_CONFIG, ...r.config };
  const limits: Partial<FetchLimits> = {
    ...DEFAULT_FETCH_LIMITS,
    ...cfg.limits,
    timeoutMs: cfg.timeoutMs,
  };
  // The commit is checked here, in the parent, whatever the caller did: it goes into an argument.
  if (!/^[0-9a-f]{40}$/.test(r.sha))
    throw new Error("the commit must be a 40 character lower-case sha");
  const log = r.log ?? ((m: string) => console.warn(`[turntable] ${m}`));
  const argv = [
    ...(r.command ?? selfCommand()),
    "fetch-source",
    "--dir",
    r.dir,
    "--out",
    r.out,
    "--limits",
    JSON.stringify(limits),
    "--max-memory-mib",
    String(cfg.memoryMb),
    ...(r.url ? ["--url", r.url] : []),
    ...(r.allowHosts ?? []).flatMap((h) => ["--allow-host", h]),
    // Nothing after this is an option, whatever a name looks like.
    "--",
    `${r.owner}/${r.repo}`,
    r.sha,
  ];
  if (r.signal?.aborted) throw new Error("the checkout was cancelled");
  const child = (r.spawn ?? Bun.spawn)(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: scrubbedEnv({}, CHILD_ENV_PASSTHROUGH),
  });
  let killedFor: string | undefined;
  let onKilled: () => void = () => {};
  const killed = new Promise<void>((resolve) => (onKilled = resolve));
  const kill = (why: string): void => {
    if (killedFor) return;
    killedFor = why;
    child.kill("SIGKILL");
    onKilled();
  };
  const started = Date.now();
  const rss = r.rss ?? readRss;
  const timer = setInterval(() => {
    if (r.signal?.aborted) kill("the checkout was cancelled");
    else if (Date.now() - started > cfg.timeoutMs) kill("the checkout took too long");
    else if (cfg.memoryMb > 0) {
      const used = rss(child.pid);
      if (used === undefined) warnNoRssOnce(log);
      else if (used > cfg.memoryMb * MIB)
        kill(`the checkout used more than ${cfg.memoryMb} MiB of memory`);
    }
  }, r.pollMs ?? 200);
  const onAbort = (): void => kill("the checkout was cancelled");
  r.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const finished = Promise.all([
      readCapped(child.stdout, 4096),
      readCapped(child.stderr, 8192),
      child.exited,
    ]);
    // After a kill the wait is bounded: a child that does not go away (stuck in the kernel) is
    // given up on rather than holding the attempt, and its slot, forever.
    const gone = killed.then(async () => {
      await Bun.sleep(r.killWaitMs ?? 5000);
      return "abandoned" as const;
    });
    const res = await Promise.race([finished, gone]);
    if (killedFor) throw new Error(killedFor);
    if (res === "abandoned") throw new Error("the checkout did not stop");
    const [out, err, code] = res;
    if (code !== 0) {
      const line = err.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${code}`;
      throw new Error(`the checkout failed: ${clean(line)}`);
    }
    const m = /^ok ([0-9a-f]{40}) files=(\d+) tarball=(\d+)$/m.exec(out);
    if (!m) throw new Error("the checkout gave no result");
    return { sha: m[1] as string, files: Number(m[2]), tarballBytes: Number(m[3]) };
  } finally {
    clearInterval(timer);
    r.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Reads the tarball the child wrote, trusting nothing about it: the path must be a regular file
 * (not a link, not a directory) owned by this user and no larger than the cap, it is opened
 * without following links and checked again through the descriptor, and what it holds must be as
 * long as the child said. Returns the bytes.
 */
export async function readChildTarball(
  path: string,
  o: { maxBytes: number; expectBytes: number; uid?: number | undefined },
): Promise<Uint8Array> {
  const uid = o.uid ?? process.getuid?.();
  const before = await lstat(path);
  if (!before.isFile()) throw new Error("the checkout's tarball is not a regular file");
  if (uid !== undefined && before.uid !== uid)
    throw new Error("the checkout's tarball is not owned by this user");
  if (before.size > o.maxBytes) throw new Error("the checkout's tarball is larger than the cap");
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev)
      throw new Error("the checkout's tarball changed while it was opened");
    if (uid !== undefined && st.uid !== uid)
      throw new Error("the checkout's tarball is not owned by this user");
    if (st.size > o.maxBytes) throw new Error("the checkout's tarball is larger than the cap");
    if (st.size !== o.expectBytes)
      throw new Error("the checkout's tarball is not the size the child reported");
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const { bytesRead } = await fh.read(buf, off, st.size - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    if (off !== st.size) throw new Error("the checkout's tarball was cut short");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  } finally {
    await fh.close();
  }
}

/**
 * Removes what an earlier server process left behind (a crash or a kill between a checkout's
 * start and its cleanup): `tt-src-*` directories and files in the temporary directory that are
 * older than `maxAgeMs`. Never anything younger, so a checkout in progress is never touched.
 */
export async function sweepOldCheckouts(
  dir: string = tmpdir(),
  maxAgeMs = 60 * 60 * 1000,
  now: number = Date.now(),
): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith("tt-src-")) continue;
    const full = join(dir, name);
    try {
      const st = await stat(full);
      if (now - st.mtimeMs < maxAgeMs) continue;
      await rm(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // gone already, or not ours to remove: leave it
    }
  }
  return removed;
}
