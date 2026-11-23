// The checkout runs in a child process, under one deadline, a memory ceiling (where the system can
// read it), a concurrency limit and the attempt's cancellation. Stub programs stand in for the
// child here; the real child is exercised in git-fetch.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCloneHost, isRepoPart } from "../src/run/checkout";
import {
  checkoutConfigFromEnv,
  DEFAULT_CHECKOUT_CONFIG,
  readRss,
  runCheckoutChild,
  Semaphore,
} from "../src/run/checkout-child";
import { DEFAULT_FETCH_LIMITS } from "../src/run/git-fetch";

const tmp = mkdtempSync(join(tmpdir(), "ls-cochild-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SHA = "a".repeat(40);
const stub = (name: string, body: string): string[] => {
  const f = join(tmp, `${name}.ts`);
  writeFileSync(f, body);
  return [process.execPath, f];
};
const req = (command: string[], over: Partial<Parameters<typeof runCheckoutChild>[0]> = {}) => ({
  owner: "acme",
  repo: "web",
  sha: SHA,
  dir: join(tmp, "d"),
  out: join(tmp, "o.tgz"),
  command,
  ...over,
});

describe("running the checkout in a child", () => {
  test("a child that does the work reports its result; its arguments carry everything it needs", async () => {
    const cmd = stub(
      "ok",
      `import { writeFileSync } from "node:fs";
const a = process.argv.slice(2);
writeFileSync(a[a.indexOf("--out") + 1] + ".args", JSON.stringify(a));
console.log("ok ${SHA} files=3 tarball=1234");`,
    );
    const r = await runCheckoutChild(
      req(cmd, { url: "http://127.0.0.1:1/a/b.git", allowHosts: ["127.0.0.1"] }),
    );
    expect(r).toEqual({ sha: SHA, files: 3, tarballBytes: 1234 });
    const a = JSON.parse(readFileSync(join(tmp, "o.tgz.args"), "utf8")) as string[];
    expect(a[0]).toBe("fetch-source");
    // the positionals come last, after `--`, so nothing in them can be taken for an option
    expect(a.slice(-3)).toEqual(["--", "acme/web", SHA]);
    expect(a.indexOf("--")).toBeGreaterThan(a.indexOf("--limits"));
    expect(a[a.indexOf("--max-memory-mib") + 1]).toBe(String(DEFAULT_CHECKOUT_CONFIG.memoryMb));
    expect(a).toContain("--allow-host");
    expect(a[a.indexOf("--url") + 1]).toBe("http://127.0.0.1:1/a/b.git");
    const limits = JSON.parse(a[a.indexOf("--limits") + 1]!);
    expect(limits.maxPackBytes).toBe(DEFAULT_FETCH_LIMITS.maxPackBytes);
    expect(limits.timeoutMs).toBe(DEFAULT_CHECKOUT_CONFIG.timeoutMs);
  });

  test("the child holds no secret: its environment is scrubbed", async () => {
    process.env.TURNTABLE_TEST_SECRET = "s3cret-value";
    process.env.GITHUB_TOKEN = "ghp_not_for_children";
    try {
      const cmd = stub(
        "env",
        `import { writeFileSync } from "node:fs";
const a = process.argv.slice(2);
writeFileSync(a[a.indexOf("--out") + 1] + ".env", JSON.stringify(process.env));
console.log("ok ${SHA} files=1 tarball=1");`,
      );
      await runCheckoutChild(req(cmd));
      const env = readFileSync(join(tmp, "o.tgz.env"), "utf8");
      expect(env).not.toContain("s3cret-value");
      expect(env).not.toContain("ghp_not_for_children");
      expect(Object.keys(JSON.parse(env)).some((k) => k.startsWith("TURNTABLE_"))).toBe(false);
    } finally {
      delete process.env.TURNTABLE_TEST_SECRET;
      delete process.env.GITHUB_TOKEN;
    }
  });

  test("a failing child is an error carrying its last stderr line, shortened and cleaned", async () => {
    const cmd = stub(
      "fail",
      `console.error("noise");
console.error("fetch-source failed: boom \\u001b[31m" + "x".repeat(400));
process.exit(1);`,
    );
    const err = await runCheckoutChild(req(cmd)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toStartWith("the checkout failed: fetch-source failed: boom");
    expect(msg.length).toBeLessThan(200);
    expect(msg).not.toContain("\u001b");
  });

  test("a child that gives no result line is an error", async () => {
    await expect(runCheckoutChild(req(stub("silent", "console.log('hello');")))).rejects.toThrow(
      /no result/,
    );
  });

  test("the deadline kills the child", async () => {
    const cmd = stub("slow", "await Bun.sleep(60_000);");
    const t0 = Date.now();
    await expect(
      runCheckoutChild(req(cmd, { config: { timeoutMs: 300 }, pollMs: 50 })),
    ).rejects.toThrow(/took too long/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  test("cancelling the attempt kills the child, and an already cancelled one never starts", async () => {
    const cmd = stub("slow2", "await Bun.sleep(60_000);");
    const ac = new AbortController();
    const t0 = Date.now();
    const p = runCheckoutChild(req(cmd, { signal: ac.signal, pollMs: 50 }));
    setTimeout(() => ac.abort(), 150);
    await expect(p).rejects.toThrow(/cancelled/);
    expect(Date.now() - t0).toBeLessThan(5000);
    const done = new AbortController();
    done.abort();
    await expect(runCheckoutChild(req(cmd, { signal: done.signal }))).rejects.toThrow(/cancelled/);
  });

  test("a child that grows past the memory ceiling is killed (resident size read from the system)", async () => {
    const cmd = stub("hog", "await Bun.sleep(60_000);");
    const seen: number[] = [];
    const t0 = Date.now();
    await expect(
      runCheckoutChild(
        req(cmd, {
          config: { memoryMb: 100 },
          pollMs: 50,
          rss: (pid) => {
            seen.push(pid);
            return 500 * 1024 * 1024;
          },
        }),
      ),
    ).rejects.toThrow(/more than 100 MiB/);
    expect(seen.length).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(5000);
    // a ceiling of 0 turns the check off: the reader is never asked
    const asked: number[] = [];
    const ok = stub("ok2", `console.log("ok ${SHA} files=1 tarball=1");`);
    await runCheckoutChild(
      req(ok, { config: { memoryMb: 0 }, pollMs: 20, rss: (p) => (asked.push(p), 1e12) }),
    );
    expect(asked).toEqual([]);
  });

  test("readRss reads /proc where there is one, and says nothing where there is not", () => {
    const rss = readRss(process.pid);
    if (process.platform === "linux") expect(rss).toBeGreaterThan(1024 * 1024);
    else expect(rss).toBeUndefined();
    expect(readRss(2 ** 30)).toBeUndefined();
  });
});

describe("concurrency", () => {
  test("a semaphore lets n in, queues the rest in order, and gives a turn back on release", async () => {
    const s = new Semaphore(2);
    const order: string[] = [];
    const a = await s.acquire();
    const b = await s.acquire();
    const c = s.acquire().then((r) => (order.push("c"), r));
    const d = s.acquire().then((r) => (order.push("d"), r));
    await Bun.sleep(20);
    expect(order).toEqual([]);
    a();
    a(); // releasing twice gives back one turn only
    await Bun.sleep(20);
    expect(order).toEqual(["c"]);
    b();
    await Bun.sleep(20);
    expect(order).toEqual(["c", "d"]);
    (await c)();
    (await d)();
  });

  test("a checkout waiting for its turn is cancelled by the attempt's signal and leaves the queue", async () => {
    const s = new Semaphore(1);
    const held = await s.acquire();
    const ac = new AbortController();
    const waiting = s.acquire(ac.signal);
    ac.abort();
    await expect(waiting).rejects.toThrow(/cancelled/);
    held();
    const again = await s.acquire(); // not blocked by the cancelled waiter
    again();
  });
});

describe("settings", () => {
  test("the defaults, and the environment variables that change them, with bad values refused", () => {
    expect(checkoutConfigFromEnv({})).toMatchObject({
      timeoutMs: 300_000,
      memoryMb: 1536,
      concurrency: 2,
    });
    const c = checkoutConfigFromEnv({
      TURNTABLE_CHECKOUT_TIMEOUT_SECONDS: "60",
      TURNTABLE_CHECKOUT_MAX_MEMORY_MIB: "0",
      TURNTABLE_CHECKOUT_CONCURRENCY: "1",
      TURNTABLE_CHECKOUT_MAX_PACK_MIB: "64",
      TURNTABLE_CHECKOUT_MAX_UNPACKED_MIB: "256",
      TURNTABLE_CHECKOUT_MAX_TARBALL_MIB: "100",
    });
    expect(c).toMatchObject({ timeoutMs: 60_000, memoryMb: 0, concurrency: 1 });
    expect(c.limits).toEqual({
      maxPackBytes: 64 * 1024 * 1024,
      maxInflatedBytes: 256 * 1024 * 1024,
      maxTarballBytes: 100 * 1024 * 1024,
    });
    for (const bad of [
      { TURNTABLE_CHECKOUT_CONCURRENCY: "0" },
      { TURNTABLE_CHECKOUT_TIMEOUT_SECONDS: "abc" },
      { TURNTABLE_CHECKOUT_MAX_PACK_MIB: "-1" },
    ])
      expect(() => checkoutConfigFromEnv(bad)).toThrow(/must be a whole number/);
    // the lowered defaults
    expect(DEFAULT_FETCH_LIMITS.maxPackBytes).toBe(128 * 1024 * 1024);
    expect(DEFAULT_FETCH_LIMITS.maxInflatedBytes).toBe(512 * 1024 * 1024);
  });

  test("the host is pinned to github.com unless the operator allowed another, and . and .. are not repository names", () => {
    expect(() => assertCloneHost("https://github.com/a/b.git")).not.toThrow();
    expect(() => assertCloneHost("https://GitHub.com/a/b.git")).not.toThrow();
    expect(() => assertCloneHost("https://github.com:443/a/b.git")).not.toThrow(); // the default port, spelled out, is the default
    expect(() => assertCloneHost("http://github.com/a/b.git")).toThrow(/https/);
    expect(() => assertCloneHost("https://github.com:8443/a/b.git")).toThrow(/default port/);
    expect(() => assertCloneHost("https://github.com:8443/a/b.git", ["github.com"])).toThrow(
      /default port/,
    );
    expect(() => assertCloneHost("https://evil.example/a/b.git")).toThrow(/not github.com/);
    expect(() => assertCloneHost("https://github.com.evil.example/a/b.git")).toThrow(
      /not github.com/,
    );
    expect(() => assertCloneHost("http://127.0.0.1:9/a/b.git")).toThrow();
    expect(() => assertCloneHost("http://127.0.0.1:9/a/b.git", ["127.0.0.1"])).not.toThrow();
    expect(() => assertCloneHost("not a url")).toThrow();
    for (const bad of [".", "..", "", "a b", "a/b"]) expect(isRepoPart(bad), bad).toBe(false);
    for (const ok of ["acme", "web.js", "a-b_c", "..a", "a.."])
      expect(isRepoPart(ok), ok).toBe(true);
  });
});
