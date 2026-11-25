import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTALL_SHIMS_SH,
  launcherArgv,
  PRECREATE_PRIVATE_SH,
  SHIM_NAMES,
  STEP_ENV,
  STEP_SHIM,
} from "../src/step-env";

/**
 * The real tool, never an interpreter shim of a Turntable job these tests may themselves run in
 * (hosted dogfood): there `sh` on PATH is the outer job's shim, and a copy of it in a hermetic dir
 * finds no real `sh` and exits 127 (#420). A shim dir is one holding `step-shim`.
 */
function realTool(name: string): string | null {
  const path = (process.env.PATH ?? "")
    .split(":")
    .filter((d) => d !== "" && !existsSync(join(d, "step-shim")))
    .join(":");
  return Bun.which(name, { PATH: path });
}

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

/** Runs the install script with `path` as PATH, as the sandbox's exec would. */
async function install(dir: string, path: string, names: readonly string[] = SHIM_NAMES) {
  const p = Bun.spawn(["/bin/sh", "-c", INSTALL_SHIMS_SH, "tt", dir, STEP_SHIM, ...names], {
    env: { PATH: path },
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

beforeAll(async () => {
  mkdirSync(bin, { recursive: true });
  mkdirSync(scratchTmp, { recursive: true });
  // Every interpreter exists in this sandbox, so every one is shimmed.
  for (const n of SHIM_NAMES) {
    writeFileSync(join(bin, n), "#!/bin/sh\n");
    chmodSync(join(bin, n), 0o755);
  }
  expect((await install(shims, `${bin}:/usr/bin:/bin`)).code).toBe(0);
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
  test("one shim, with a symlink per interpreter act launches that exists", () => {
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
      `#!/bin/sh\nif [ "$1" = inner ]; then echo "inner io=$TURNTABLE_STEP_IO"; [ -t 1 ] && echo tty || echo notty; else echo outer; bash inner; fi\n`,
    );
    chmodSync(join(bin, "bash"), 0o755);
    const r = await viaShim([]);
    expect(r.out.split("\n").filter(Boolean)).toEqual(["outer", "inner io=1", "notty"]);
    // The named pipe is gone when the step ends.
    expect(readdirSync(scratchTmp).filter((f) => f.startsWith("ls-step."))).toEqual([]);
  });

  test("a grandchild started with a scrubbed env keeps its stderr apart from its stdout", async () => {
    // As a test that spawns `bash` with an explicit env does: TURNTABLE_STEP_IO is gone, so only
    // the inherited fifo says this is already a wrapped step. Without that, the nested shim merged
    // stderr into stdout and the caller that piped them apart read an empty stderr.
    writeFileSync(
      join(bin, "bash"),
      `#!/bin/sh
if [ "$1" = inner ]; then echo to-out; echo to-err >&2; exit 3; fi
a=$(env -i PATH="$PATH" TMPDIR="$TMPDIR" bash inner 2>&1 >/dev/null); echo "err=[$a]"
b=$(env -i PATH="$PATH" TMPDIR="$TMPDIR" bash inner 2>/dev/null); echo "out=[$b]"
echo "step-err" >&2
`,
    );
    chmodSync(join(bin, "bash"), 0o755);
    const r = await viaShim([]);
    expect(r.out.split("\n").filter(Boolean)).toEqual(["err=[to-err]", "out=[to-out]", "step-err"]);
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
    const { p } = startShim({ TURNTABLE_STEP_GRACE: "1" });
    expect(await waitUntil(async () => (await running("sleep 31337")).length > 0, 5000)).toBe(true);
    p.kill("SIGKILL");
    await p.exited;
    // The watcher polls once a second, then TERM, then KILL after the grace period.
    const gone = await waitUntil(async () => (await running("sleep 31337")).length === 0, 10_000);
    if (!gone) await Bun.spawn(["pkill", "-f", "sleep 31337"]).exited; // do not leak from a failing test
    expect(gone).toBe(true);
  }, 30_000);

  test("the watcher survives what kills the shim's whole process group (act's pty teardown), and still takes the interpreter down", async () => {
    realBash("sleep 31341 & sleep 31341; echo not-reached");
    // The shim leads a process group of its own, as a step does on act's pty: killing the group
    // kills the shim and anything left in it, which a subshell watcher would be.
    const p = Bun.spawn(["perl", "-e", "setpgrp(0,0); exec @ARGV", join(shims, "bash")], {
      env: { PATH: `${shims}:${bin}:/usr/bin:/bin`, TMPDIR: scratchTmp, TURNTABLE_STEP_GRACE: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await waitUntil(async () => (await running("sleep 31341")).length > 0, 5000)).toBe(true);
    // Let the shim set up its watcher before the group goes.
    expect(
      await waitUntil(async () => (await running("my($shim,$rpid,$grace,$dir)")).length > 0, 5000),
    ).toBe(true);
    process.kill(-p.pid, "SIGKILL");
    await p.exited;
    // A hangup to the same group right after, as the closing pty sends.
    try {
      process.kill(-p.pid, "SIGHUP");
    } catch {
      // the group may already be empty
    }
    const gone = await waitUntil(async () => (await running("sleep 31341")).length === 0, 10_000);
    if (!gone) await Bun.spawn(["pkill", "-f", "sleep 31341"]).exited;
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
    const { p } = startShim({ TURNTABLE_STEP_GRACE: "1" });
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
      const found = realTool(tool);
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

describe("steps run with umask 022, after Turntable's own files are written (issue 627)", () => {
  test("the launcher sets umask 0022 after it sources and removes the env file, before act", () => {
    const script = launcherArgv("/s", ["act"], "/tmp/x.env")[2] ?? "";
    const src = script.indexOf('. "$f"');
    const rm = script.indexOf('rm -f "$f"');
    const um = script.indexOf("umask 0022");
    const exec = script.indexOf("exec env");
    expect(src).toBeGreaterThanOrEqual(0);
    expect(um).toBeGreaterThan(rm);
    expect(rm).toBeGreaterThan(src);
    expect(exec).toBeGreaterThan(um);
  });

  test("started under umask 077, a step creates 644 files and 755 directories; the env file is read first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-umask-"));
    try {
      const envFile = join(dir, "job.env");
      // Made the way run-job makes it: 0600 before any content.
      writeFileSync(envFile, "export TT_MARK=hello\n", { mode: 0o600 });
      chmodSync(envFile, 0o600);
      const body =
        'echo "mark=$TT_MARK"; echo "umask=$(umask)"; touch f; mkdir d; echo "file=$(stat -c %a f)"; echo "dir=$(stat -c %a d)"; [ -e "$1" ] && echo envfile-present || echo envfile-gone';
      const p = Bun.spawn(
        [
          "sh",
          "-c",
          `umask 077; exec "$@"`,
          "x",
          ...launcherArgv(dir, ["sh", "-c", body, "s", envFile], envFile, false),
        ],
        { cwd: dir, env: { PATH: "/usr/bin:/bin" }, stdout: "pipe" },
      );
      const out = await new Response(p.stdout).text();
      await p.exited;
      expect(out).toContain("mark=hello");
      expect(out).toContain("umask=0022");
      expect(out).toContain("file=644");
      expect(out).toContain("dir=755");
      expect(out).toContain("envfile-gone");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the file is pre-created 0600 before content is put", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-umask-"));
    try {
      const f = join(dir, "job.env");
      const p = Bun.spawn(["sh", "-c", `umask 000; ${PRECREATE_PRIVATE_SH}`, "x", f], {
        stdout: "pipe",
      });
      await p.exited;
      expect(statSync(f).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A shim for an interpreter that is not installed would make `command -v` lie. These tests use a
// PATH made only of what they put in it, so they do not depend on what the machine has (GitHub's
// own runners have pwsh; a dev machine may not).
describe("only interpreters that exist are shimmed", () => {
  const TOOLS = [
    "sh",
    "mkdir",
    "chmod",
    "ln",
    "dirname",
    "readlink",
    "mktemp",
    "mkfifo",
    "cat",
    "rm",
    "kill",
    "sleep",
    "perl",
    "env",
  ];
  /** A PATH directory holding only the commands the shim itself needs, plus `extra` fakes. */
  function hermetic(name: string, extra: Record<string, string> = {}): string {
    const d = join(tmp, name);
    mkdirSync(d, { recursive: true });
    for (const t of TOOLS) {
      const real = realTool(t);
      if (real) symlinkSync(real, join(d, t));
    }
    for (const [n, body] of Object.entries(extra)) {
      writeFileSync(join(d, n), `#!/bin/sh\n${body}\n`);
      chmodSync(join(d, n), 0o755);
    }
    return d;
  }
  async function step(dir: string, pathAfter: string, script: string, shell = "sh") {
    const p = Bun.spawn([join(dir, shell), "-c", script], {
      env: { PATH: `${dir}:${pathAfter}`, TMPDIR: scratchTmp },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { out: out + err, code };
  }

  test("pwsh absent: no shim for it, so a workflow's own probe skips and succeeds, with its notice", async () => {
    const bin2 = hermetic("bin-nopwsh", { bash: 'exec sh "$@"' });
    const d = join(tmp, "shims-nopwsh");
    expect((await install(d, bin2)).code).toBe(0);
    expect(existsSync(join(d, "pwsh"))).toBe(false);
    expect(existsSync(join(d, "bash"))).toBe(true);
    const r = await step(
      d,
      bin2,
      'if ! command -v pwsh >/dev/null; then echo "::notice::pwsh is not installed, skipping"; exit 0; fi; echo ran-pwsh; pwsh -v',
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("::notice::pwsh is not installed, skipping");
    expect(r.out).not.toContain("ran-pwsh");
    expect(r.out).not.toContain("command not found");
  });

  test("`command -v` behaves as it does without Turntable: node absent is non-zero and prints nothing", async () => {
    const bin2 = hermetic("bin-nonode");
    const d = join(tmp, "shims-nonode");
    await install(d, bin2);
    const r = await step(d, bin2, "command -v node");
    expect(r.code).not.toBe(0);
    expect(r.out.trim()).toBe("");
    // and the same for every interpreter that is not there
    for (const n of ["node", "python", "python3", "pwsh"])
      expect(existsSync(join(d, n))).toBe(false);
  });

  test("pwsh present: the shim is used, and it runs the real one", async () => {
    const bin2 = hermetic("bin-pwsh", { pwsh: 'echo "real-pwsh $*"' });
    const d = join(tmp, "shims-pwsh");
    await install(d, bin2);
    expect(existsSync(join(d, "pwsh"))).toBe(true);
    const r = await step(d, bin2, "command -v pwsh; pwsh -NoProfile hi");
    expect(r.code).toBe(0);
    expect(r.out).toContain(join(d, "pwsh")); // `command -v` finds the shim first
    expect(r.out).toContain("real-pwsh -NoProfile hi");
  });

  test("only python3 installed: there is no `python` shim to pretend python exists", async () => {
    const bin2 = hermetic("bin-py3", { python3: "echo py3" });
    const d = join(tmp, "shims-py3");
    await install(d, bin2);
    expect(existsSync(join(d, "python3"))).toBe(true);
    expect(existsSync(join(d, "python"))).toBe(false);
    expect((await step(d, bin2, "command -v python")).code).not.toBe(0);
  });

  test("the shim directory itself on PATH does not count as the real interpreter", async () => {
    const bin2 = hermetic("bin-self");
    const d = join(tmp, "shims-self");
    // a first run makes shims for nothing; a second, with the shim dir on PATH, still finds no node
    await install(d, bin2);
    await install(d, `${d}:${bin2}`);
    expect(existsSync(join(d, "node"))).toBe(false);
  });
});

describe("realTool skips an outer Turntable shim dir (#420)", () => {
  test("a dir holding step-shim on PATH is never where a tool resolves from", () => {
    const outer = mkdtempSync(join(tmpdir(), "tt-outer-shims-"));
    writeFileSync(join(outer, "step-shim"), "#!/bin/sh\nexit 127\n");
    chmodSync(join(outer, "step-shim"), 0o755);
    symlinkSync("step-shim", join(outer, "sh"));
    const before = process.env.PATH;
    try {
      process.env.PATH = `${outer}:${before ?? ""}`;
      // The control: a plain lookup over the same PATH takes the shim.
      expect(Bun.which("sh", { PATH: process.env.PATH })).toBe(join(outer, "sh"));
      const real = realTool("sh");
      expect(real).not.toBeNull();
      expect(real!.startsWith(outer)).toBe(false);
    } finally {
      process.env.PATH = before;
      rmSync(outer, { recursive: true, force: true });
    }
  });
});
