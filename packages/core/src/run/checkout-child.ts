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
import { readFileSync } from "node:fs";
import { scrubbedEnv } from "@longshore/provider-sdk";
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
  const t = num("LONGSHORE_CHECKOUT_TIMEOUT_SECONDS", 10, 3600);
  if (t !== undefined) cfg.timeoutMs = t * 1000;
  const mem = num("LONGSHORE_CHECKOUT_MAX_MEMORY_MIB", 0, 65536);
  if (mem !== undefined) cfg.memoryMb = mem;
  const c = num("LONGSHORE_CHECKOUT_CONCURRENCY", 1, 16);
  if (c !== undefined) cfg.concurrency = c;
  const pack = num("LONGSHORE_CHECKOUT_MAX_PACK_MIB", 1, 4096);
  if (pack !== undefined) cfg.limits.maxPackBytes = pack * MIB;
  const unpacked = num("LONGSHORE_CHECKOUT_MAX_UNPACKED_MIB", 1, 16384);
  if (unpacked !== undefined) cfg.limits.maxInflatedBytes = unpacked * MIB;
  const tarball = num("LONGSHORE_CHECKOUT_MAX_TARBALL_MIB", 1, 4096);
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
}

export interface ChildResult {
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
  const argv = [
    ...(r.command ?? selfCommand()),
    "fetch-source",
    `${r.owner}/${r.repo}`,
    r.sha,
    "--dir",
    r.dir,
    "--out",
    r.out,
    "--limits",
    JSON.stringify(limits),
    ...(r.url ? ["--url", r.url] : []),
    ...(r.allowHosts ?? []).flatMap((h) => ["--allow-host", h]),
  ];
  if (r.signal?.aborted) throw new Error("the checkout was cancelled");
  const child = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: scrubbedEnv(),
  });
  let killedFor: string | undefined;
  const kill = (why: string): void => {
    if (killedFor) return;
    killedFor = why;
    child.kill("SIGKILL");
  };
  const started = Date.now();
  const rss = r.rss ?? readRss;
  const timer = setInterval(() => {
    if (r.signal?.aborted) kill("the checkout was cancelled");
    else if (Date.now() - started > cfg.timeoutMs) kill("the checkout took too long");
    else if (cfg.memoryMb > 0) {
      const used = rss(child.pid);
      if (used !== undefined && used > cfg.memoryMb * MIB)
        kill(`the checkout used more than ${cfg.memoryMb} MiB of memory`);
    }
  }, r.pollMs ?? 200);
  const onAbort = (): void => kill("the checkout was cancelled");
  r.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [out, err, code] = await Promise.all([
      readCapped(child.stdout, 4096),
      readCapped(child.stderr, 8192),
      child.exited,
    ]);
    if (killedFor) throw new Error(killedFor);
    if (code !== 0) {
      const line = err.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${code}`;
      throw new Error(`the checkout failed: ${clean(line)}`);
    }
    const m = /^ok [0-9a-f]{40} files=(\d+) tarball=(\d+)/m.exec(out);
    if (!m) throw new Error("the checkout gave no result");
    return { files: Number(m[1]), tarballBytes: Number(m[2]) };
  } finally {
    clearInterval(timer);
    r.signal?.removeEventListener("abort", onAbort);
  }
}
