import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_SHIMS_SH, launcherArgv, SHIM_NAMES, STEP_ENV, STEP_SHIM } from "../src/step-env";

const tmp = mkdtempSync(join(tmpdir(), "ls-shim-"));
const shims = join(tmp, "shims");
const bin = join(tmp, "bin");
const scratchTmp = join(tmp, "tmpdir");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A real fake interpreter named `bash` on a PATH the shim sits in front of. */
function realBash(body: string) {
  writeFileSync(join(bin, "bash"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "bash"), 0o755);
}

beforeAll(async () => {
  mkdirSync(bin, { recursive: true });
  mkdirSync(scratchTmp, { recursive: true });
  const p = Bun.spawn(["sh", "-c", INSTALL_SHIMS_SH, "tt", shims, STEP_SHIM, ...SHIM_NAMES]);
  expect(await p.exited).toBe(0);
});

/** Runs `shims/bash args` with the shim directory first on PATH. */
async function viaShim(
  args: string[],
  opts: { env?: Record<string, string>; stdin?: string } = {},
) {
  const p = Bun.spawn([join(shims, "bash"), ...args], {
    env: {
      PATH: `${shims}:${bin}:/usr/bin:/bin`,
      TMPDIR: scratchTmp,
      ...opts.env,
    },
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { out, err, code };
}

describe("the install script", () => {
  test("one shim, with a symlink per interpreter act launches", () => {
    expect(readdirSync(shims).toSorted()).toEqual(["step-shim", ...SHIM_NAMES].toSorted());
    for (const n of SHIM_NAMES) expect(existsSync(join(shims, n))).toBe(true);
    expect(SHIM_NAMES).toEqual(expect.arrayContaining(["bash", "sh", "node", "python"]));
  });
});

describe("the shim", () => {
  test("the step sees no terminal on stdin, stdout or stderr", async () => {
    realBash(
      "[ -t 0 ] && echo in=tty || echo in=notty; [ -t 1 ] && echo out=tty || echo out=notty; [ -t 2 ] && echo err=tty || echo err=notty >&2",
    );
    const r = await viaShim([]);
    // stdout and stderr are merged into one stream, as the runner captures them.
    const text = r.out + r.err;
    expect(text).toContain("in=notty");
    expect(text).toContain("out=notty");
    expect(text).toContain("err=notty");
    expect(text).not.toContain("=tty");
  });

  test("the exit code, and both streams in order, come through", async () => {
    realBash("echo one; echo two >&2; echo three; exit 7");
    const r = await viaShim([]);
    expect(r.code).toBe(7);
    expect((r.out + r.err).split("\n").filter(Boolean)).toEqual(["one", "two", "three"]);
  });

  test("arguments are passed through untouched", async () => {
    realBash('for a in "$@"; do echo "[$a]"; done');
    const r = await viaShim(["--noprofile", "-e", "a b", "", "$HOME", "x'y"]);
    expect(r.out.split("\n").filter(Boolean)).toEqual([
      "[--noprofile]",
      "[-e]",
      "[a b]",
      "[]",
      "[$HOME]",
      "[x'y]",
    ]);
  });

  test("stdin is not the caller's: a step that reads it gets end of file", async () => {
    realBash("cat; echo done");
    const r = await viaShim([], { stdin: "should not be seen" });
    expect(r.out).toBe("done\n");
  });

  test("a large output arrives whole", async () => {
    realBash("head -c 5000000 /dev/zero | tr '\\0' 'x'; echo");
    const r = await viaShim([]);
    expect(r.out.length).toBe(5_000_001);
  });

  test("the real interpreter is the next one on PATH, not the shim; a missing one is 127", async () => {
    realBash('echo "real:$0"');
    const r = await viaShim([]);
    expect(r.out).toBe(`real:${join(bin, "bash")}\n`);
    // A name with no real command anywhere on PATH.
    symlinkSync("step-shim", join(shims, "ls-no-such-interpreter"));
    const p = Bun.spawn([join(shims, "ls-no-such-interpreter")], {
      env: { PATH: `${shims}:${bin}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(p.stderr).text();
    expect(await p.exited).toBe(127);
    expect(err).toContain("command not found");
  });

  test("a nested interpreter passes straight through (no second pipe), and it leaves nothing behind", async () => {
    // The outer step runs `bash` again through PATH (the shim), as `#!/usr/bin/env bash` scripts do.
    writeFileSync(
      join(bin, "bash"),
      `#!/bin/sh\nif [ "$1" = inner ]; then echo "inner io=$LONGSHORE_STEP_IO"; [ -t 1 ] && echo tty || echo notty; else echo outer; bash inner; fi\n`,
    );
    chmodSync(join(bin, "bash"), 0o755);
    const r = await viaShim([]);
    expect(r.out.split("\n").filter(Boolean)).toEqual(["outer", "inner io=1", "notty"]);
    // The named pipe is gone when the step ends.
    expect(readdirSync(scratchTmp).filter((f) => f.startsWith("ls-step."))).toEqual([]);
  });

  test("a background process holding the pipe does not hold the step", async () => {
    realBash("(sleep 30 &) ; echo started");
    const t0 = Date.now();
    const r = await viaShim([]);
    expect(r.out).toContain("started");
    expect(r.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  test("without a usable temp directory it still runs the step", async () => {
    realBash("echo ran");
    const r = await viaShim([], { env: { TMPDIR: join(tmp, "does-not-exist") } });
    expect(r.out).toBe("ran\n");
    expect(r.code).toBe(0);
  });
});

/** Command lines of every process on the machine that contain `needle`. */
async function running(needle: string): Promise<string[]> {
  const p = Bun.spawn(["ps", "-axo", "command"], { stdout: "pipe" });
  const text = await new Response(p.stdout).text();
  await p.exited;
  return text.split("\n").filter((l) => l.includes(needle) && !l.includes("ps -axo"));
}

async function waitUntil(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await Bun.sleep(150);
  }
  return fn();
}

/** Starts `shims/bash` and returns the process with its pid and a way to read its output. */
function startShim(env: Record<string, string> = {}) {
  const p = Bun.spawn([join(shims, "bash")], {
    env: { PATH: `${shims}:${bin}:/usr/bin:/bin`, TMPDIR: scratchTmp, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = new Response(p.stdout).text();
  return { p, out };
}

describe("the watchdog (act's step-timeout kill hits only the shim)", () => {
  test("SIGKILL of the shim takes the interpreter and what it started down with it", async () => {
    realBash("sleep 31337 & sleep 31337; echo not-reached");
    const { p } = startShim({ LONGSHORE_STEP_GRACE: "1" });
    expect(await waitUntil(async () => (await running("sleep 31337")).length > 0, 5000)).toBe(true);
    p.kill("SIGKILL");
    await p.exited;
    // The watcher polls once a second, then TERM, then KILL after the grace period.
    const gone = await waitUntil(async () => (await running("sleep 31337")).length === 0, 10_000);
    if (!gone) await Bun.spawn(["pkill", "-f", "sleep 31337"]).exited; // do not leak from a failing test
    expect(gone).toBe(true);
  }, 30_000);

  test("a normal end leaves a daemon the step started on purpose alone", async () => {
    realBash("(sleep 31338 &); echo started");
    const { p, out } = startShim();
    expect(await out).toContain("started");
    expect(await p.exited).toBe(0);
    // Longer than the watcher's poll: it saw the interpreter gone and did nothing.
    await Bun.sleep(2500);
    const left = await running("sleep 31338");
    await Bun.spawn(["pkill", "-f", "sleep 31338"]).exited;
    expect(left.length).toBeGreaterThan(0);
  }, 20_000);

  test("TERM to the shim reaches the interpreter, which can clean up; the exit code is its own", async () => {
    realBash("trap 'echo got-term; exit 3' TERM; sleep 31339 & wait");
    const { p, out } = startShim();
    expect(await waitUntil(async () => (await running("sleep 31339")).length > 0, 5000)).toBe(true);
    p.kill("SIGTERM");
    expect(await p.exited).toBe(3);
    expect(await out).toContain("got-term");
    await waitUntil(async () => (await running("sleep 31339")).length === 0, 5000);
    await Bun.spawn(["pkill", "-f", "sleep 31339"]).exited;
  }, 20_000);

  test("an interpreter that ignores TERM is killed after the grace period", async () => {
    realBash("trap '' TERM; while :; do sleep 31340; done");
    const { p } = startShim({ LONGSHORE_STEP_GRACE: "1" });
    expect(await waitUntil(async () => (await running("sleep 31340")).length > 0, 5000)).toBe(true);
    const t0 = Date.now();
    p.kill("SIGTERM");
    await p.exited;
    expect(Date.now() - t0).toBeLessThan(8000);
    const gone = await waitUntil(async () => (await running("sleep 31340")).length === 0, 8000);
    if (!gone) await Bun.spawn(["pkill", "-f", "sleep 31340"]).exited;
    expect(gone).toBe(true);
  }, 30_000);

  test("the interpreter keeps its default SIGINT handling (a shell's async start would ignore it)", async () => {
    realBash("trap 'echo caught-int' INT; kill -INT $$; sleep 0.2; echo end");
    const r = await viaShim([]);
    expect(r.out).toContain("caught-int");
    expect(r.out).toContain("end");
  });

  test("the interpreter runs in its own process group", async () => {
    realBash("ps -o pgid= -p $$; ps -o pid= -p $$");
    const r = await viaShim([]);
    const [pgid, pid] = r.out.trim().split(/\s+/);
    expect(pgid).toBe(pid);
  });

  test("without perl the step still runs (no watchdog)", async () => {
    realBash("echo no-perl-ok; exit 5");
    // A PATH holding only what the shim itself needs.
    const minimal = join(tmp, "minbin");
    mkdirSync(minimal, { recursive: true });
    for (const tool of [
      "sh",
      "cat",
      "mkfifo",
      "mktemp",
      "dirname",
      "readlink",
      "sleep",
      "rm",
      "kill",
    ]) {
      const found = Bun.which(tool);
      if (found && !existsSync(join(minimal, tool))) symlinkSync(found, join(minimal, tool));
    }
    const p = Bun.spawn([join(shims, "bash")], {
      env: { PATH: `${shims}:${bin}:${minimal}`, TMPDIR: scratchTmp },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(5);
    expect(out).toContain("no-perl-ok");
  });
});

describe("the step environment", () => {
  test("the constants: no pager, no prompt, a UTF-8 locale", () => {
    expect(STEP_ENV).toEqual(
      expect.arrayContaining([
        "GIT_PAGER=cat",
        "PAGER=cat",
        "GIT_TERMINAL_PROMPT=0",
        "LANG=C.UTF-8",
        "LC_ALL=C.UTF-8",
      ]),
    );
    // TERM is unset, never set, and no controller environment is forwarded.
    expect(STEP_ENV.some((e) => e.startsWith("TERM="))).toBe(false);
    expect(STEP_ENV.every((e) => /^[A-Z_]+=[\w.:-]*$/.test(e))).toBe(true);
  });

  test("the launcher puts the shims first on PATH, unsets TERM, and execs act", async () => {
    const argv = launcherArgv("/tmp/tt-act/shims", ["/tmp/tt-act/act", "push", "-j", "hello"]);
    expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(argv).toContain("/tmp/tt-act/shims");
    expect(argv.slice(-4)).toEqual(["/tmp/tt-act/act", "push", "-j", "hello"]);
    // Run it for real with `env` standing in for act: PATH and TERM as steps would see them.
    const p = Bun.spawn(
      launcherArgv(shims, [
        "sh",
        "-c",
        'echo "path=$PATH"; echo "term=${TERM-unset}"; echo "lang=$LANG"; echo "lcall=$LC_ALL"; echo "pager=$GIT_PAGER"',
      ]),
      {
        env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color", LANG: "en_US.UTF-8" },
        stdout: "pipe",
      },
    );
    const out = await new Response(p.stdout).text();
    await p.exited;
    expect(out).toContain(`path=${shims}:/usr/bin:/bin`);
    // Unset: bash itself reports `dumb` for an unset TERM, which is also what a bash step on
    // GitHub's runner sees. What matters is that the caller's xterm is not passed on.
    expect(out).toMatch(/term=(unset|dumb)/);
    expect(out).not.toContain("xterm");
    expect(out).toContain("lang=C.UTF-8");
    expect(out).toContain("lcall=C.UTF-8");
    expect(out).toContain("pager=cat");
  });
});
