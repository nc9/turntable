// The checkout child is not trusted: what it reports and what it writes are checked, the server
// plans from the tarball it will deliver, cleanup is off the event loop, an orphaned child stops,
// and a child that will not die is given up on.
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanTarGz, tarGzDirectoryToFile } from "@turntable/act-runner";
import { readChildTarball, runCheckoutChild, sweepOldCheckouts } from "../src/run/checkout-child";
import { makeCheckpoint } from "../src/run/fetch-source-cli";
import { tarballReader } from "../src/run/tarball-reader";
import { UnsafePathError } from "../src/run/safe-read";
import { gitRepoSource } from "../src/scheduler";

const tmp = mkdtempSync(join(tmpdir(), "ls-cotrust-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SHA = "b".repeat(40);

/** A stub child: copies `tarball` (gzip bytes) to --out (or not), writes a different workflow into --dir, prints a line. */
function stubChild(
  name: string,
  o: {
    tarball: Uint8Array | "none";
    dirFile?: [string, string];
    line?: (size: number) => string;
    symlinkOut?: string;
  },
): string[] {
  const f = join(tmp, `${name}.ts`);
  const bin = join(tmp, `${name}.bin`);
  if (o.tarball !== "none") writeFileSync(bin, o.tarball);
  // The line is built from the size, so a test can make it lie.
  const lineExpr = o.line ? `(${o.line.toString()})(size)` : "`ok ${sha} files=1 tarball=${size}`";
  writeFileSync(
    f,
    `import { copyFileSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
const dir = a[a.indexOf("--dir") + 1];
const out = a[a.indexOf("--out") + 1];
const sha = a.at(-1);
${o.dirFile ? `mkdirSync(dir + "/.github/workflows", { recursive: true }); writeFileSync(dir + "/" + ${JSON.stringify(o.dirFile[0])}, ${JSON.stringify(o.dirFile[1])});` : ""}
let size = 0;
${
  o.symlinkOut
    ? `symlinkSync(${JSON.stringify(o.symlinkOut)}, out);`
    : o.tarball === "none"
      ? ""
      : `copyFileSync(${JSON.stringify(bin)}, out); size = statSync(out).size;`
}
console.log(${lineExpr});`,
  );
  return [process.execPath, f];
}

let archiveN = 0;
/** A real archive: a directory packed by the writer the child uses, so it has the shape the scanner accepts. */
async function archive(
  files: Record<string, string>,
  links: Record<string, string> = {},
): Promise<Uint8Array> {
  const d = mkdtempSync(join(tmp, "arch-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(d, path.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(d, path), text);
  }
  for (const [path, target] of Object.entries(links)) symlinkSync(target, join(d, path));
  const out = join(tmp, `arch-${archiveN++}.tgz`);
  await tarGzDirectoryToFile(d, out, { maxBytes: 1e8 });
  return new Uint8Array(readFileSync(out));
}

const run = (
  command: string[],
  over: Partial<Parameters<ReturnType<typeof gitRepoSource>["checkout"]>[2]> & {
    sha?: string;
  } = {},
) =>
  gitRepoSource({
    cloneUrl: () => "http://127.0.0.1:9/acme/web.git",
    allowHosts: ["127.0.0.1"],
    command,
  }).checkout({ sha: over.sha ?? SHA } as never, { owner: "acme", repo: "web" }, over);

describe("the child's output is not trusted", () => {
  test("the server plans from the TARBALL: a workflow different in the directory is never seen", async () => {
    const cmd = stubChild("planned", {
      tarball: await archive({ ".github/workflows/ci.yml": "name: delivered\n" }),
      dirFile: [".github/workflows/ci.yml", "name: shown-to-the-planner\n"],
    });
    const co = await run(cmd);
    expect(co.readFile(".github/workflows/ci.yml")).toBe("name: delivered\n");
    expect(co.readFile("nothing.txt")).toBeUndefined();
    co.dispose?.();
  });

  test("a tarball that is a symlink, is not as long as the child said, or is over the cap is refused", async () => {
    const victim = join(tmp, "victim.txt");
    writeFileSync(victim, "x".repeat(100));
    // the child leaves a symlink where its tarball should be
    await expect(
      run(stubChild("symlink", { tarball: "none", symlinkOut: victim })),
    ).rejects.toThrow(/not a regular file/);
    // it reports a size that is not the file's
    await expect(
      run(
        stubChild("badsize", {
          tarball: await archive({ a: "b" }),
          line: (s) => `ok ${"b".repeat(40)} files=1 tarball=${s + 5}`,
        }),
      ),
    ).rejects.toThrow(/not the size the child reported/);
    // it reports another commit
    await expect(
      run(
        stubChild("badsha", {
          tarball: await archive({ a: "b" }),
          line: (s) => `ok ${"c".repeat(40)} files=1 tarball=${s}`,
        }),
      ),
    ).rejects.toThrow(/different commit/);
    // it writes nothing at all
    await expect(
      run(
        stubChild("nofile", {
          tarball: "none",
          line: () => `ok ${"b".repeat(40)} files=1 tarball=5`,
        }),
      ),
    ).rejects.toThrow();
  });

  test("readChildTarball checks the kind, the owner, the cap and the size, and never follows a link", async () => {
    const f = join(tmp, "good.tgz");
    writeFileSync(f, new Uint8Array(100));
    expect(await readChildTarball(f, { maxBytes: 1000, expectBytes: 100 })).toHaveLength(100);
    await expect(readChildTarball(f, { maxBytes: 50, expectBytes: 100 })).rejects.toThrow(
      /larger than the cap/,
    );
    await expect(readChildTarball(f, { maxBytes: 1000, expectBytes: 99 })).rejects.toThrow(
      /not the size/,
    );
    await expect(
      readChildTarball(f, { maxBytes: 1000, expectBytes: 100, uid: (process.getuid?.() ?? 0) + 1 }),
    ).rejects.toThrow(/not owned/);
    const dirPath = join(tmp, "adir");
    mkdirSync(dirPath);
    await expect(readChildTarball(dirPath, { maxBytes: 1000, expectBytes: 0 })).rejects.toThrow(
      /not a regular file/,
    );
    const link = join(tmp, "link.tgz");
    symlinkSync(f, link);
    await expect(readChildTarball(link, { maxBytes: 1000, expectBytes: 100 })).rejects.toThrow(
      /not a regular file/,
    );
  });
});

describe("reading from the tarball keeps the safe reader's rules", () => {
  test("a symlink, a traversal, an oversize file and a file past the keep budget are refused loudly", async () => {
    const tgz = await archive(
      { "a-ok.yml": "fine\n", "b-big.txt": "x".repeat(2000), "c-later.txt": "kept? no" },
      { "d-link.yml": "/etc/passwd" },
    );
    const read = await tarballReader(tgz, {
      maxUnpackedBytes: 1e6,
      maxFileBytes: 1000,
      captureTotal: 10,
    });
    expect(read("a-ok.yml")).toBe("fine\n");
    expect(read("missing")).toBeUndefined();
    expect(() => read("d-link.yml")).toThrow(UnsafePathError);
    expect(() => read("../x")).toThrow(UnsafePathError);
    expect(() => read("b-big.txt")).toThrow(/larger than/);
    expect(() => read("c-later.txt")).toThrow(/more text than a checkout keeps/);
  });

  test("a .git bigger than the keep budget does not stop planning from reading .github (#778)", async () => {
    const tgz = await archive({
      ".git/objects/pack": "g".repeat(500),
      ".github/actions/x/action.yml": "runs: {}\n",
      "zz-text": "t".repeat(40),
    });
    const read = await tarballReader(tgz, { maxUnpackedBytes: 1e6, captureTotal: 20 });
    expect(read(".github/actions/x/action.yml")).toBe("runs: {}\n");
    // Real text past the cap still gets the clear refusal.
    expect(() => read("zz-text")).toThrow(/more text than a checkout keeps/);
  });

  test("a path that is not in its canonical spelling is refused loudly, never read as missing", async () => {
    const tgz = await archive({ "a/b": "x" });
    const read = await tarballReader(tgz, { maxUnpackedBytes: 1e6 });
    expect(read("a/b")).toBe("x");
    for (const p of ["a//b", "./a/b", "a/./b", "a/", "", "/a/b", "a/b/"])
      expect(() => read(p), JSON.stringify(p)).toThrow(UnsafePathError);
  });

  test("the scan lists everything and keeps only small files; a bomb and too many entries are stopped", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 50; i += 1) files[`d/f${i}`] = "y".repeat(100);
    files["huge"] = "z".repeat(500_000);
    const tgz = await archive(files);
    const m = await scanTarGz(tgz, {
      maxUnpackedBytes: 5e6,
      maxEntries: 1000,
      captureUpTo: 1000,
      captureTotal: 3000,
    });
    expect(m.size).toBe(53); // the root, d, 50 files and huge
    expect(m.get("huge")!.data).toBeUndefined(); // listed, not kept
    expect(m.get("huge")!.size).toBe(500_000);
    expect([...m.values()].filter((e) => e.data).length).toBe(30); // the keep budget (3000 / 100)
    await expect(
      scanTarGz(tgz, {
        maxUnpackedBytes: 100_000,
        maxEntries: 1000,
        captureUpTo: 10,
        captureTotal: 10,
      }),
    ).rejects.toThrow(/too large/);
    await expect(
      scanTarGz(tgz, { maxUnpackedBytes: 5e6, maxEntries: 10, captureUpTo: 10, captureTotal: 10 }),
    ).rejects.toThrow(/too many entries/);
    await expect(
      scanTarGz(new Uint8Array([1, 2, 3]), {
        maxUnpackedBytes: 1e6,
        maxEntries: 10,
        captureUpTo: 10,
        captureTotal: 10,
      }),
    ).rejects.toThrow();
  });
});

describe("cleanup is not done on the event loop, and a failed checkout leaves nothing", () => {
  test("the tarball file and the tree are gone shortly after a checkout returns, and after a failed one", async () => {
    const before = new Set(
      (await Bun.$`ls ${tmpdir()}`.text()).split("\n").filter((n) => n.startsWith("tt-src-")),
    );
    const ok = await run(
      stubChild("clean-ok", { tarball: await archive({ a: "b" }), dirFile: ["x.txt", "tree"] }),
    );
    ok.dispose?.();
    await expect(
      run(
        stubChild("clean-bad", {
          tarball: await archive({ a: "b" }),
          line: (s) => `ok ${"c".repeat(40)} files=1 tarball=${s}`,
        }),
      ),
    ).rejects.toThrow();
    let leftover: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      leftover = (await Bun.$`ls ${tmpdir()}`.text())
        .split("\n")
        .filter((n) => n.startsWith("tt-src-") && !before.has(n));
      if (leftover.length === 0) break;
      await Bun.sleep(50);
    }
    expect(leftover).toEqual([]);
  });

  test("old tt-src-* leftovers are swept and nothing else; a young one is kept", async () => {
    const d = mkdtempSync(join(tmp, "sweep-"));
    const old = join(d, "tt-src-old");
    const oldFile = join(d, "tt-src-old.tgz");
    const young = join(d, "tt-src-young");
    const other = join(d, "keep-me");
    for (const p of [old, young, other]) mkdirSync(p);
    writeFileSync(join(old, "f"), "x");
    writeFileSync(oldFile, "x");
    const longAgo = new Date(Date.now() - 3 * 3600_000);
    utimesSync(old, longAgo, longAgo);
    utimesSync(oldFile, longAgo, longAgo);
    utimesSync(other, longAgo, longAgo);
    expect(await sweepOldCheckouts(d, 3600_000)).toBe(2);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(await sweepOldCheckouts(join(d, "does-not-exist"))).toBe(0);
  });
});

describe("an orphaned or hungry child stops", () => {
  test("the checkpoint stops a child whose parent is gone, or that is over memory, and costs a clock read in a loop", () => {
    const stops: string[] = [];
    let ppid = 100;
    let rss = 10;
    let t = 0;
    const cp = makeCheckpoint({
      parentPid: 100,
      getParentPid: () => ppid,
      rss: () => rss,
      maxRssBytes: 1000,
      onStop: (w) => stops.push(w),
      now: () => t,
    });
    t = 1000;
    cp();
    expect(stops).toEqual([]);
    ppid = 1;
    cp(); // throttled: same instant
    expect(stops).toEqual([]);
    t = 1100;
    cp();
    expect(stops).toEqual(["the server that started this checkout is gone"]);
    ppid = 100;
    rss = 2_000_000;
    t = 1200;
    cp();
    expect(stops.at(-1)).toMatch(/more than \d+ MiB/);
    // a ceiling of 0 is no ceiling
    const off = makeCheckpoint({
      parentPid: 1,
      getParentPid: () => 1,
      rss: () => 1e12,
      maxRssBytes: 0,
      onStop: (w) => stops.push(w),
      now: () => 5000,
    });
    const n = stops.length;
    off();
    expect(stops.length).toBe(n);
  });

  test("a REAL child exits by itself when its parent is killed (it waits on a server that never answers)", async () => {
    const stall = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    const parent = join(tmp, "orphan-parent.ts");
    const main = new URL("../src/main.ts", import.meta.url).pathname;
    writeFileSync(
      parent,
      `const c = Bun.spawn([process.execPath, ${JSON.stringify(main)}, "fetch-source", "--dir", ${JSON.stringify(join(tmp, "orph-dir"))}, "--out", ${JSON.stringify(join(tmp, "orph.tgz"))}, "--url", "http://127.0.0.1:${stall.port}/a/b.git", "--allow-host", "127.0.0.1", "--", "acme/web", "${SHA}"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
console.log(c.pid);
await Bun.sleep(1500);
process.kill(process.pid, "SIGKILL");`,
    );
    const p = Bun.spawn([process.execPath, parent], { stdout: "pipe", stderr: "ignore" });
    const pid = Number((await new Response(p.stdout).text()).trim().split("\n")[0]);
    await p.exited;
    expect(Number.isInteger(pid) && pid > 1).toBe(true);
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let gone = false;
    for (let i = 0; i < 80 && !gone; i += 1) {
      gone = !alive();
      if (!gone) await Bun.sleep(100);
    }
    if (!gone) process.kill(pid, "SIGKILL");
    void stall.stop(true);
    expect(gone).toBe(true);
  }, 30_000);

  test("a child that does not go away after SIGKILL is given up on, not waited for", async () => {
    const never = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({ start() {} });
    const fake = (() => ({
      pid: 123_456_789,
      stdout: never(),
      stderr: never(),
      exited: new Promise<number>(() => {}),
      kill() {},
    })) as unknown as typeof Bun.spawn;
    const t0 = Date.now();
    await expect(
      runCheckoutChild({
        owner: "acme",
        repo: "web",
        sha: SHA,
        dir: join(tmp, "d9"),
        out: join(tmp, "o9.tgz"),
        spawn: fake,
        command: ["x"],
        config: { timeoutMs: 100 },
        pollMs: 20,
        killWaitMs: 150,
      }),
    ).rejects.toThrow(/took too long/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test("a bad sha never reaches a child, and the child's environment keeps the TLS and proxy settings but no secret", async () => {
    await expect(
      runCheckoutChild({
        owner: "acme",
        repo: "web",
        sha: "--help",
        dir: "d",
        out: "o",
        command: ["x"],
      }),
    ).rejects.toThrow(/40 character/);
    await expect(
      runCheckoutChild({
        owner: "acme",
        repo: "web",
        sha: "A".repeat(40),
        dir: "d",
        out: "o",
        command: ["x"],
      }),
    ).rejects.toThrow(/lower-case/);
    const saved = { ...process.env };
    process.env.SSL_CERT_FILE = "/etc/ssl/custom.pem";
    process.env.HTTPS_PROXY = "http://proxy.internal:3128";
    process.env.NO_PROXY = "localhost";
    process.env.GITHUB_TOKEN = "ghp_nope";
    process.env.TURNTABLE_X = "nope";
    try {
      const f = join(tmp, "envout.json");
      const script = join(tmp, "env2.ts");
      writeFileSync(
        script,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(f)}, JSON.stringify(process.env)); console.log("ok ${SHA} files=1 tarball=1");`,
      );
      await runCheckoutChild({
        owner: "acme",
        repo: "web",
        sha: SHA,
        dir: join(tmp, "d8"),
        out: join(tmp, "o8.tgz"),
        command: [process.execPath, script],
      });
      const env = JSON.parse(await Bun.file(f).text()) as Record<string, string>;
      expect(env.SSL_CERT_FILE).toBe("/etc/ssl/custom.pem");
      expect(env.HTTPS_PROXY).toBe("http://proxy.internal:3128");
      expect(env.NO_PROXY).toBe("localhost");
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(Object.keys(env).some((k) => k.startsWith("TURNTABLE_"))).toBe(false);
    } finally {
      for (const k of ["SSL_CERT_FILE", "HTTPS_PROXY", "NO_PROXY", "GITHUB_TOKEN", "TURNTABLE_X"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
