import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeWorld } from "@longshore/provider-sdk/testing";
import { InfraError, type Provider } from "@longshore/provider-sdk";
import {
  drain,
  planJob,
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
      'echo "term=${TERM-unset}"; echo "lang=$LANG"; echo "pager=$GIT_PAGER"; echo "prompt=$GIT_TERMINAL_PROMPT"; echo "first=${PATH%%:*}"; ls "${PATH%%:*}"',
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
      expect(log).toContain("pager=cat");
      expect(log).toContain("prompt=0");
      expect(log).toMatch(/first=.*\/shims/);
      for (const name of ["step-shim", "bash", "sh", "node", "python"]) expect(log).toContain(name);
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
