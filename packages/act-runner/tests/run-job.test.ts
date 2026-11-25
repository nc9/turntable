import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import { InfraError, type Provider } from "@turntable/provider-sdk";
import { SHIM_NAMES } from "../src/step-env";
import {
  drain,
  planJob,
  planWorkflow,
  resolveActions,
  resumeJob,
  runJob,
  sha256Hex,
  staticResolver,
  tarDirectory,
  type RunEvent,
} from "../src/index";

const world = new FakeWorld({ exec: { tickSeconds: 1 } });
const tmp = mkdtempSync(join(tmpdir(), "tt-act-test-"));
afterAll(() => {
  world.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

const WF =
  "name: t\non: push\njobs:\n  hello:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n";
const spec = {
  name: "act",
  labels: { t: "act" },
  ttlSeconds: 300,
  network: { egress: "open" },
} as const;
const fixture = (n: string): Promise<string> => Bun.file(`${import.meta.dir}/fixtures/${n}`).text();

async function tarWith(files: Record<string, string>): Promise<Uint8Array> {
  const d = mkdtempSync(join(tmp, "t-"));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c, { mode: 0o755 });
  return tarDirectory(d, Object.keys(files));
}

/** A fake `act`: prints `stdout` then runs `tail`, then exits with `code`. */
async function fakeAct(stdout: string, code: number, tail = "") {
  const script = `#!/bin/sh\ncat <<'TT_EOF'\n${stdout}TT_EOF\n${tail}\nexit ${code}\n`;
  const bytes = await tarWith({ act: script });
  return { bytes, sha256: sha256Hex(bytes) };
}

async function setup(wf: string = WF) {
  const p = world.provider();
  const { id } = await p.create(spec);
  const plan = planJob(wf, "hello", {
    workflowPath: ".github/workflows/ci.yml",
    readFile: () => undefined,
    root: `${world.sandboxDir(id)}/tt`,
  });
  const repoTarball = await tarWith({ "README.md": "hi\n" });
  return { p, id, plan, repoTarball };
}

async function go(
  act: Awaited<ReturnType<typeof fakeAct>>,
  mutate?: (p: Provider, id: string) => void,
) {
  const { p, id, plan, repoTarball } = await setup();
  const events: RunEvent[] = [];
  const result = await drain(runJob(p, id, plan, { repoTarball, act }, { pollMs: 50 }), (e) => {
    events.push(e);
    if (e.kind === "act") mutate?.(p, id);
  });
  return { result, events, p, id };
}

describe("the step environment", () => {
  test("act starts with the shims first on PATH, no inherited TERM, a UTF-8 locale and no pager", async () => {
    const act = await fakeAct(
      "",
      0,
      'echo "term=${TERM-unset}"; echo "lang=$LANG"; echo "lcall=$LC_ALL"; echo "pager=$GIT_PAGER"; echo "prompt=$GIT_TERMINAL_PROMPT"; echo "first=${PATH%%:*}"; ls "${PATH%%:*}"',
    );
    const saved = process.env.TERM;
    process.env.TERM = "xterm-256color"; // the controller's own terminal must not leak through
    try {
      const { events } = await go(act);
      const log = events
        .filter((e) => e.kind === "log")
        .map((e) => new TextDecoder().decode(e.bytes))
        .join("");
      expect(log).toMatch(/term=(unset|dumb)/);
      expect(log).not.toContain("xterm");
      expect(log).toContain("lang=C.UTF-8");
      expect(log).toContain("lcall=C.UTF-8");
      expect(log).toContain("pager=cat");
      expect(log).toContain("prompt=0");
      expect(log).toMatch(/first=.*\/shims/);
      // Only interpreters that exist in the sandbox are shimmed (a shim for an absent one would
      // make `command -v` lie): bash and sh always, the rest only if there.
      const listed = log
        .split("\n")
        .slice(log.split("\n").findIndex((l) => l.startsWith("first=")) + 1)
        .filter(Boolean);
      expect(listed).toEqual(expect.arrayContaining(["step-shim", "bash", "sh"]));
      for (const name of listed) expect(["step-shim", ...SHIM_NAMES]).toContain(name);
    } finally {
      if (saved === undefined) delete process.env.TERM;
      else process.env.TERM = saved;
    }
  });

  test("a sandbox where the shims cannot be installed fails the job as infra_error", async () => {
    const act = await fakeAct("", 0);
    const { p, id, plan, repoTarball } = await setup();
    // A file where the shim directory must go.
    mkdirSync(plan.layout.root, { recursive: true });
    writeFileSync(plan.layout.shims, "in the way");
    const result = await drain(runJob(p, id, plan, { repoTarball, act }, { pollMs: 50 }), () => {});
    expect(result.state).toBe("infra_error");
    expect(result.reason).toContain("cannot install step shims");
  });
});

describe("the secrets-proxy environment", () => {
  const CRED = "cred-not-a-real-secret-4f9a";
  test("reaches act through a file the launcher sources and deletes, never through an argv", async () => {
    const { p, id, plan, repoTarball } = await setup();
    const envFile = `${plan.layout.root}/job.env`;
    const act = await fakeAct(
      await fixture("success.jsonl"),
      0,
      `echo "proxy=$HTTPS_PROXY"; echo "lower=$https_proxy"; echo "bundle=$SSL_CERT_FILE"; if [ -e '${envFile}' ]; then echo envfile-left; else echo envfile-gone; fi`,
    );
    const argvs: string[] = [];
    const puts: string[] = [];
    const start = p.exec.start.bind(p.exec);
    p.exec.start = (sid, o) => {
      argvs.push(o.argv.join("\u0000"));
      return start(sid, o);
    };
    const put = p.files.put.bind(p.files);
    p.files.put = (sid, path, bytes) => {
      puts.push(path);
      return put(sid, path, bytes);
    };
    const events: RunEvent[] = [];
    const result = await drain(
      runJob(
        p,
        id,
        plan,
        { repoTarball, act, proxy: { url: `http://att:${CRED}@10.0.0.2:3128`, caPem: "CA" } },
        { pollMs: 50 },
      ),
      (e) => events.push(e),
    );
    const log = events
      .filter((e) => e.kind === "log")
      .map((e) => new TextDecoder().decode(e.bytes))
      .join("");
    expect(result.state).toBe("success");
    // act (and so every step) has the proxy in its environment, from the sourced file.
    expect(log).toContain(`proxy=http://att:${CRED}@10.0.0.2:3128`);
    expect(log).toContain(`lower=http://att:${CRED}@10.0.0.2:3128`);
    expect(log).toMatch(/bundle=.*proxy-bundle\.pem/);
    // The file was deleted before act started.
    expect(log).toContain("envfile-gone");
    expect(puts).toContain(envFile);
    // No exec the provider was asked to run carries the credential.
    expect(argvs.length).toBeGreaterThan(3);
    for (const a of argvs) expect(a).not.toContain(CRED);
    // The file was made private before the launcher read it.
    expect(argvs.some((a) => a.includes("chmod 600"))).toBe(true);
  });
});

describe("file modes (issue 627)", () => {
  test("act and its steps run with umask 022 while the env and vars files are 0600 before and after the put", async () => {
    const p = world.provider();
    const { id } = await p.create(spec);
    const plan = planJob(WF, "hello", {
      workflowPath: ".github/workflows/ci.yml",
      readFile: () => undefined,
      root: `${world.sandboxDir(id)}/tt`,
      vars: { X: "y" },
    });
    const act = await fakeAct(
      await fixture("success.jsonl"),
      0,
      `echo "umask=$(umask)"; t=$(mktemp -d); touch "$t/f"; mkdir "$t/d"; echo "file=$(stat -c %a "$t/f")"; echo "dir=$(stat -c %a "$t/d")"; rm -rf "$t"`,
    );
    const modes: Record<string, number> = {};
    const put = p.files.put.bind(p.files);
    p.files.put = async (sid, path, bytes) => {
      if (path.endsWith("job.env") || path === plan.layout.varsFile) {
        // Already there and private before the content arrives.
        modes[`${path.split("/").pop()}:before`] = statSync(path).mode & 0o777;
      }
      await put(sid, path, bytes);
      if (path.endsWith("job.env") || path === plan.layout.varsFile) {
        modes[`${path.split("/").pop()}:after`] = statSync(path).mode & 0o777;
      }
    };
    const events: RunEvent[] = [];
    const result = await drain(
      runJob(
        p,
        id,
        plan,
        {
          repoTarball: await tarWith({ "README.md": "hi\n" }),
          act,
          githubToken: "tok-not-real",
        },
        { pollMs: 50 },
      ),
      (e) => events.push(e),
    );
    const log = events
      .filter((e) => e.kind === "log")
      .map((e) => new TextDecoder().decode(e.bytes))
      .join("");
    expect(result.state).toBe("success");
    expect(log).toContain("umask=0022");
    expect(log).toContain("file=644");
    expect(log).toContain("dir=755");
    expect(modes["job.env:before"]).toBe(0o600);
    expect(modes["job.env:after"]).toBe(0o600);
    expect(modes[`${plan.layout.varsFile.split("/").pop()}:before`]).toBe(0o600);
    expect(modes[`${plan.layout.varsFile.split("/").pop()}:after`]).toBe(0o600);
  });
});

describe("a repository larger than the provider's per-file cap", () => {
  test("is delivered in parts, reassembled and checked in the sandbox", async () => {
    const small = new FakeWorld({ exec: { tickSeconds: 1 }, maxFileBytes: 20_000 });
    try {
      const p = small.provider();
      const { id } = await p.create(spec);
      const plan = planJob(WF, "hello", {
        workflowPath: ".github/workflows/ci.yml",
        readFile: () => undefined,
        root: `${small.sandboxDir(id)}/tt`,
      });
      // Incompressible content, so the tarball is well over the cap.
      const big = new Uint8Array(100_000);
      crypto.getRandomValues(big);
      const d = mkdtempSync(join(tmp, "big-"));
      writeFileSync(join(d, "blob.bin"), big);
      writeFileSync(join(d, "README.md"), "hi\n");
      const repoTarball = await tarDirectory(d, ["blob.bin", "README.md"]);
      expect(repoTarball.length).toBeGreaterThan(20_000 * 4);
      // The provider really refuses a single file this big.
      await expect(p.files.put(id, `${plan.layout.root}/x`, repoTarball)).rejects.toThrow();
      const act = await fakeAct(
        await fixture("success.jsonl"),
        0,
        `cd '${plan.layout.repo}' && echo "blob=$(wc -c < blob.bin | tr -d " ")" && echo "readme=$(cat README.md)" && ls '${plan.layout.root}' | grep -c part || true`,
      );
      const events: RunEvent[] = [];
      const result = await drain(runJob(p, id, plan, { repoTarball, act }, { pollMs: 50 }), (e) =>
        events.push(e),
      );
      const log = events
        .filter((e) => e.kind === "log")
        .map((e) => new TextDecoder().decode(e.bytes))
        .join("");
      expect(result.state).toBe("success");
      expect(log).toContain("blob=100000");
      expect(log).toContain("readme=hi");
      // No part file is left behind.
      expect(log).toMatch(/\n0\n?$/m);
    } finally {
      small.dispose();
    }
  });

  test("a part that arrives damaged fails the job instead of running a broken repository", async () => {
    const small = new FakeWorld({ exec: { tickSeconds: 1 }, maxFileBytes: 20_000 });
    try {
      const p = small.provider();
      const { id } = await p.create(spec);
      const plan = planJob(WF, "hello", {
        workflowPath: ".github/workflows/ci.yml",
        readFile: () => undefined,
        root: `${small.sandboxDir(id)}/tt`,
      });
      const big = new Uint8Array(100_000);
      crypto.getRandomValues(big);
      const d = mkdtempSync(join(tmp, "big-"));
      writeFileSync(join(d, "blob.bin"), big);
      const repoTarball = await tarDirectory(d, ["blob.bin"]);
      const put = p.files.put.bind(p.files);
      p.files.put = (sid, path, bytes) =>
        path.endsWith(".part1")
          ? put(sid, path, new Uint8Array(bytes.length))
          : put(sid, path, bytes);
      const act = await fakeAct("", 0);
      const result = await drain(
        runJob(p, id, plan, { repoTarball, act }, { pollMs: 50 }),
        () => {},
      );
      expect(result.state).toBe("infra_error");
      expect(result.reason).toContain("checksum mismatch");
    } finally {
      small.dispose();
    }
  });
});

describe("runJob against the fake provider", () => {
  test("success: events, contiguous log offsets, success verdict", async () => {
    const out = await fixture("success.jsonl");
    const { result, events } = await go(await fakeAct(out, 0));
    expect(result).toMatchObject({ state: "success", exitCode: 0 });
    const logs = events.filter((e) => e.kind === "log");
    let off = 0;
    let text = "";
    for (const l of logs) {
      expect(l.offset).toBe(off);
      off += l.bytes.length;
      text += new TextDecoder().decode(l.bytes);
    }
    expect(text).toBe(out);
    const act = events.flatMap((e) => (e.kind === "act" ? [e.event] : []));
    expect(act.some((e) => e.type === "step-end" && e.name === "Say hello")).toBe(true);
    expect(events[0]).toEqual({ kind: "phase", phase: "preparing" });
  });

  test("failure: non-zero exit with a failed job result", async () => {
    const { result } = await go(await fakeAct(await fixture("failure.jsonl"), 1));
    expect(result).toMatchObject({ state: "failure", exitCode: 1 });
    expect(result.reason).toContain("Boom");
  });

  test("skipped: exit 0 and no events", async () => {
    const { result } = await go(await fakeAct("", 0));
    expect(result).toMatchObject({ state: "skipped", exitCode: 0 });
  });

  test("infra_error: act crashes before any job event", async () => {
    const { result } = await go(await fakeAct("Error: bad flag\n", 2));
    expect(result.state).toBe("infra_error");
    expect(result.exitCode).toBe(2);
  });

  test("infra_error: exit 0 but the job result says failure", async () => {
    const { result } = await go(await fakeAct(await fixture("failure.jsonl"), 0));
    expect(result.state).toBe("infra_error");
  });

  test("infra_error: act checksum mismatch is refused inside the sandbox", async () => {
    const act = await fakeAct("", 0);
    const { result } = await go({ ...act, sha256: "0".repeat(64) });
    expect(result.state).toBe("infra_error");
    expect(result.reason).toContain("install failed");
  });

  test("infra_error: sandbox destroyed mid-run (cancel)", async () => {
    const act = await fakeAct(
      (await fixture("success.jsonl")).split("\n")[0] + "\n",
      0,
      "sleep 30",
    );
    const { result } = await go(act, (p, id) => void p.destroy(id));
    expect(result.state).toBe("infra_error");
  });

  test("transient provider errors are retried", async () => {
    const { p, id, plan, repoTarball } = await setup();
    world.failNext("exec", 2, new InfraError("blip"));
    const act = await fakeAct(await fixture("success.jsonl"), 0);
    const result = await drain(runJob(p, id, plan, { repoTarball, act }, { pollMs: 20 }));
    expect(result.state).toBe("success");
  });

  test("remote actions are delivered by sha; unresolved ones are refused", async () => {
    const wf = `${WF}      - uses: acme/tool@v1\n`;
    const act = await fakeAct(await fixture("success.jsonl"), 0);
    const first = await setup(wf);
    const refused = await drain(
      runJob(
        first.p,
        first.id,
        first.plan,
        { repoTarball: first.repoTarball, act },
        { pollMs: 20 },
      ),
    );
    expect(refused.state).toBe("infra_error");
    expect(refused.reason).toContain("acme/tool@v1");

    const { p, id, plan, repoTarball } = await setup(wf);
    const sha = "c".repeat(40);
    const resolved = await resolveActions(plan, staticResolver({ "acme/tool@v1": sha }));
    const asked: string[] = [];
    const d = mkdtempSync(join(tmp, "a-"));
    mkdirSync(join(d, "tool-abc"));
    writeFileSync(join(d, "tool-abc", "action.yml"), "name: tool\n");
    const tgz = await tarDirectory(d, ["tool-abc"]);
    const result = await drain(
      runJob(
        p,
        id,
        resolved,
        {
          repoTarball,
          act,
          fetchAction: async (repo, s) => {
            asked.push(`${repo}@${s}`);
            return tgz;
          },
        },
        { pollMs: 20 },
      ),
    );
    expect(result.state).toBe("success");
    expect(asked).toEqual([`acme/tool@${sha}`]);
    const dir = resolved.actions[0]?.dir ?? "";
    expect(await Bun.file(`${dir}/action.yml`).text()).toBe("name: tool\n");
    // The workflow copy act reads is pinned to the sha.
    const wfText = await Bun.file(`${plan.layout.repo}/.github/workflows/ci.yml`).text();
    expect(wfText).toContain(`uses: acme/tool@${sha} # v1`);
  });
});

describe("onExec and resumeJob: a controller that restarts gets the real result", () => {
  /** Runs a real job, then replays its exec from scratch the way a restarted controller would. */
  async function runThenResume(out: string, code: number) {
    const { p, id, plan, repoTarball } = await setup();
    const act = await fakeAct(out, code);
    const seen: { sandboxId: string; execId: string }[] = [];
    const first: RunEvent[] = [];
    const result = await drain(
      runJob(p, id, plan, { repoTarball, act }, { pollMs: 50, onExec: (i) => void seen.push(i) }),
      (e) => first.push(e),
    );
    // a brand-new provider instance and no state from the first run: only the ids survive
    const fresh = world.provider();
    const again: RunEvent[] = [];
    const resumed = await drain(
      resumeJob(fresh, seen[0]!.sandboxId, seen[0]!.execId, { pollMs: 50 }),
      (e) => again.push(e),
    );
    return { result, first, resumed, again, seen, id, p: fresh };
  }

  test("onExec reports the sandbox and exec once, as soon as the exec starts", async () => {
    const { seen, id, first } = await runThenResume(await fixture("success.jsonl"), 0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sandboxId).toBe(id);
    expect(seen[0]!.execId).toBeString();
    // it fired before the job was watched: nothing but setup phases came before it could have
    expect(first.some((e) => e.kind === "phase" && e.phase === "running")).toBe(true);
  });

  test("a success that finished while nobody watched still resumes as success, with the same log", async () => {
    const { result, resumed, first, again } = await runThenResume(
      await fixture("success.jsonl"),
      0,
    );
    expect(result).toMatchObject({ state: "success" });
    expect(resumed).toMatchObject({ state: "success", exitCode: 0 });
    const logText = (events: RunEvent[]) =>
      events
        .filter((e) => e.kind === "log")
        .map((e) => Buffer.from(e.bytes).toString())
        .join("");
    expect(logText(again)).toBe(logText(first)); // the full log, from offset 0
    expect(again.filter((e) => e.kind === "act").length).toBe(
      first.filter((e) => e.kind === "act").length,
    );
  });

  test("a failure resumes as the same failure", async () => {
    const { result, resumed } = await runThenResume(await fixture("failure.jsonl"), 1);
    expect(result.state).toBe("failure");
    expect(resumed).toMatchObject({ state: "failure", exitCode: 1 });
  });

  test("a lost exec and a vanished sandbox are infra_error, never a guess", async () => {
    const { p, id, plan, repoTarball } = await setup();
    const act = await fakeAct(await fixture("success.jsonl"), 0, "sleep 30");
    let ids: { sandboxId: string; execId: string } | undefined;
    const run = runJob(
      p,
      id,
      plan,
      { repoTarball, act },
      { pollMs: 50, onExec: (i) => void (ids = i) },
    );
    for (;;) {
      const n = await run.next();
      if (n.done || ids) break;
    }
    void run.return({ state: "infra_error", reason: "stop" });
    world.loseExec(ids!.sandboxId, ids!.execId);
    const lost = await drain(
      resumeJob(world.provider(), ids!.sandboxId, ids!.execId, { pollMs: 50 }),
    );
    expect(lost.state).toBe("infra_error");
    await world.provider().destroy(ids!.sandboxId);
    const gone = await drain(
      resumeJob(world.provider(), ids!.sandboxId, ids!.execId, { pollMs: 50 }),
    );
    expect(gone).toMatchObject({ state: "infra_error" });
  });
});

describe("the OIDC request variables", () => {
  test("reach every step through the env file, never an argv", async () => {
    const { p, id, plan, repoTarball } = await setup();
    const act = await fakeAct(
      await fixture("success.jsonl"),
      0,
      `echo "url=$ACTIONS_ID_TOKEN_REQUEST_URL"; echo "tok=$ACTIONS_ID_TOKEN_REQUEST_TOKEN"`,
    );
    const argvs: string[] = [];
    const start = p.exec.start.bind(p.exec);
    p.exec.start = (sid, o) => {
      argvs.push(o.argv.join("\u0000"));
      return start(sid, o);
    };
    const events: RunEvent[] = [];
    const result = await drain(
      runJob(
        p,
        id,
        plan,
        {
          repoTarball,
          act,
          oidc: {
            requestUrl: "https://ci.example.test/oidc/acme/token?api-version=2.0",
            requestToken: "placeholder-value",
          },
        },
        { pollMs: 50 },
      ),
      (e) => events.push(e),
    );
    const log = events
      .filter((e) => e.kind === "log")
      .map((e) => new TextDecoder().decode(e.bytes))
      .join("");
    expect(result.state).toBe("success");
    expect(log).toContain("url=https://ci.example.test/oidc/acme/token?api-version=2.0");
    expect(log).toContain("tok=placeholder-value");
    expect(argvs.join("\n")).not.toContain("placeholder-value");
  });
});

describe("the run's vars (issue 613)", () => {
  const VARS = { TURNTABLE_CI: "true", X: "y", TRICKY: 'a "q" $HOME\nb\\c' };

  test("reach act through a 0600 var file that is not in an argv and is removed after", async () => {
    const p = world.provider();
    const { id } = await p.create(spec);
    const plan = planJob(WF, "hello", {
      workflowPath: ".github/workflows/ci.yml",
      readFile: () => undefined,
      root: `${world.sandboxDir(id)}/tt`,
      vars: VARS,
    });
    const file = plan.layout.varsFile;
    expect(plan.vars).toEqual(VARS);
    const act = await fakeAct(
      await fixture("success.jsonl"),
      0,
      `echo "mode=$(stat -c %a '${file}')"; echo "args=$*"; sed 's/^/var:/' '${file}'`,
    );
    const argvs: string[] = [];
    const start = p.exec.start.bind(p.exec);
    p.exec.start = (sid, o) => {
      argvs.push(o.argv.join("\u0000"));
      return start(sid, o);
    };
    const events: RunEvent[] = [];
    const result = await drain(
      runJob(
        p,
        id,
        plan,
        { repoTarball: await tarWith({ "README.md": "hi\n" }), act },
        { pollMs: 50 },
      ),
      (e) => events.push(e),
    );
    const log = events
      .filter((e) => e.kind === "log")
      .map((e) => new TextDecoder().decode(e.bytes))
      .join("");
    expect(result.state).toBe("success");
    expect(log).toContain("mode=600");
    expect(log).toContain(`--var-file ${file}`);
    expect(log).toContain('var:TURNTABLE_CI="true"');
    expect(log).toContain('var:X="y"');
    expect(log).toContain('var:TRICKY="a \\"q\\" \\$HOME\\nb\\\\c"');
    for (const a of argvs) expect(a).not.toContain("TURNTABLE_CI");
    expect(existsSync(file)).toBe(false);
  });

  test("a run with no vars passes no --var-file and writes no file", async () => {
    const { p, id, plan, repoTarball } = await setup();
    expect(plan.vars).toBeUndefined();
    expect(plan.argv).not.toContain("--var-file");
    const act = await fakeAct(await fixture("success.jsonl"), 0, `echo "args=$*"`);
    const events: RunEvent[] = [];
    const result = await drain(runJob(p, id, plan, { repoTarball, act }, { pollMs: 50 }), (e) =>
      events.push(e),
    );
    expect(result.state).toBe("success");
    expect(existsSync(plan.layout.varsFile)).toBe(false);
  });

  test("planWorkflow stores the planner's vars on each job and planJob takes them", () => {
    const wp = planWorkflow(
      WF,
      { name: "push", ref: "refs/heads/main" },
      {
        readFile: () => undefined,
        vars: VARS,
      },
    );
    expect(wp.jobs[0]?.vars).toEqual(VARS);
  });
});
