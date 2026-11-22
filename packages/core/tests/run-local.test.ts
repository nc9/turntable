import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanError, sha256Hex, tarDirectory } from "@turntable/act-runner";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import {
  type Db,
  ensureLocalTenant,
  listAttempts,
  listJobs,
  listRuns,
  openDatabase,
  readLog,
} from "../src/db";
import { runLocal } from "../src/run/run-local";
import { dbRunStore } from "../src/run/store";

const tmp = mkdtempSync(join(tmpdir(), "tt-run-test-"));
const world = new FakeWorld({ hostPaths: [tmp], exec: { tickSeconds: 1 } });
afterAll(() => {
  world.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

const FIX = `${import.meta.dir}/../../act-runner/tests/fixtures`;
const WF =
  "name: t\non: push\njobs:\n  hello:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n";
const enc = new TextDecoder();

async function tarWith(files: Record<string, string>): Promise<Uint8Array> {
  const d = mkdtempSync(join(tmp, "t-"));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c, { mode: 0o755 });
  return tarDirectory(d, Object.keys(files));
}

async function fakeAct(stdout: string, code: number, tail = "") {
  const bytes = await tarWith({
    act: `#!/bin/sh\ncat <<'TT_EOF'\n${stdout}TT_EOF\n${tail}\nexit ${code}\n`,
  });
  return { bytes, sha256: sha256Hex(bytes) };
}

async function setup() {
  const db: Db = openDatabase(":memory:");
  const scope = await ensureLocalTenant(db);
  const repoTarball = await tarWith({ "README.md": "hi\n" });
  const root = mkdtempSync(join(tmp, "r-"));
  return { db, scope, repoTarball, root: join(root, "tt") };
}

async function go(
  act: Awaited<ReturnType<typeof fakeAct>>,
  extra: Partial<Parameters<typeof runLocal>[0]> = {},
  workflow = WF,
) {
  const { db, scope, repoTarball, root } = await setup();
  const out: string[] = [];
  const provider = world.provider();
  const result = await runLocal({
    provider,
    providerName: "fake",
    store: dbRunStore(db, scope),
    workflowPath: ".github/workflows/ci.yml",
    workflowYaml: workflow,
    job: "hello",
    event: "push",
    ref: "refs/heads/main",
    sha: "a".repeat(40),
    repoTarball,
    image: "unused",
    out: (t) => out.push(t),
    planRoot: root,
    act,
    pollMs: 30,
    ...extra,
  });
  const logText = async (): Promise<string> => {
    const chunks = await readLog(db, scope, result.attemptId);
    let off = 0;
    let text = "";
    for (const c of chunks) {
      expect(c.offset).toBe(off);
      off += c.bytes.length;
      text += enc.decode(c.bytes);
    }
    return text;
  };
  return { db, scope, result, out: out.join(""), logText, provider };
}

describe("runLocal", () => {
  test("success: rows, log with contiguous offsets, sandbox destroyed", async () => {
    const act = await fakeAct(await Bun.file(`${FIX}/success.jsonl`).text(), 0);
    const { db, scope, result, out, logText, provider } = await go(act);
    expect(result).toMatchObject({ state: "success", exitCode: 0 });
    const [run] = await listRuns(db, scope);
    expect(run).toMatchObject({ status: "success", workflowPath: ".github/workflows/ci.yml" });
    const [job] = await listJobs(db, scope, result.runId);
    expect(job).toMatchObject({ state: "success", exitCode: 0, jobKey: "hello" });
    const [attempt] = await listAttempts(db, scope, result.jobId);
    expect(attempt).toMatchObject({ state: "success", exitCode: 0, provider: "fake" });
    expect(attempt?.sandboxId).toBeTruthy();
    const stored = await logText();
    expect(stored).toBe(out);
    expect(stored).toContain("▶ Say hello");
    expect(stored).toContain("hello from act");
    expect(stored).toContain("✓ Say hello");
    expect(await provider.count({ labels: { "turntable.run": result.runId } })).toBe(0);
  });

  test("failure: exit 1, job failure with a non-zero code", async () => {
    const act = await fakeAct(await Bun.file(`${FIX}/failure.jsonl`).text(), 1);
    const { db, scope, result, out } = await go(act);
    expect(result).toMatchObject({ state: "failure", exitCode: 1 });
    const [job] = await listJobs(db, scope, result.runId);
    expect(job).toMatchObject({ state: "failure", exitCode: 1 });
    expect(out).toContain("✗ Boom failure");
  });

  test("infra_error: exit 2, no exit code stored, act's own text shown", async () => {
    const { db, scope, result, out } = await go(await fakeAct("Error: bad flag\n", 2));
    expect(result).toMatchObject({ state: "infra_error", exitCode: 2 });
    const [job] = await listJobs(db, scope, result.runId);
    expect(job?.state).toBe("infra_error");
    expect(job?.exitCode).toBeNull();
    expect(out).toContain("Error: bad flag");
  });

  test("skipped: exit 0, recorded as success until the skipped state exists", async () => {
    const { db, scope, result } = await go(await fakeAct("", 0));
    expect(result).toMatchObject({ state: "skipped", exitCode: 0 });
    const [job] = await listJobs(db, scope, result.runId);
    expect(job?.state).toBe("success");
  });

  test("sandbox create failure is an infra_error row, not a crash", async () => {
    world.failNext("create", 1);
    const { db, scope, result } = await go(await fakeAct("", 0));
    expect(result).toMatchObject({ state: "infra_error", exitCode: 2 });
    const [job] = await listJobs(db, scope, result.runId);
    expect(job?.state).toBe("infra_error");
  });

  test("cancel destroys the sandbox, marks cancelled, exits 130", async () => {
    const first = (await Bun.file(`${FIX}/success.jsonl`).text()).split("\n")[0] + "\n";
    const act = await fakeAct(first, 0, "sleep 30");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    const { db, scope, result, provider } = await go(act, { signal: ac.signal });
    expect(result).toMatchObject({ state: "cancelled", exitCode: 130 });
    const [job] = await listJobs(db, scope, result.runId);
    expect(job?.state).toBe("cancelled");
    const [run] = await listRuns(db, scope);
    expect(run?.status).toBe("cancelled");
    expect(await provider.count({ labels: { "turntable.run": result.runId } })).toBe(0);
  }, 20_000);

  test("secrets are redacted before display and storage", async () => {
    const key = "AKIA" + "IOSFODNN7EXAMPLE";
    const out = JSON.stringify({
      jobID: "hello",
      msg: `key ${key}\n`,
      raw_output: true,
      stage: "Main",
      step: "x",
      stepID: ["0"],
      time: "t",
      level: "info",
    });
    const { result, out: shown, logText } = await go(await fakeAct(`${out}\n`, 0));
    expect(result.state).toBe("infra_error"); // exit 0 with no job result is untrusted
    expect(shown).not.toContain(key);
    expect(await logText()).not.toContain(key);
    expect(shown).toContain("***");
  });

  test("an unsupported workflow throws a PlanError before any row exists", async () => {
    const { db, scope, repoTarball, root } = await setup();
    const bad = WF.replace("    runs-on", "    needs: other\n    runs-on");
    await expect(
      runLocal({
        provider: world.provider(),
        providerName: "fake",
        store: dbRunStore(db, scope),
        workflowPath: ".github/workflows/ci.yml",
        workflowYaml: bad,
        job: "hello",
        event: "push",
        ref: "refs/heads/main",
        repoTarball,
        image: "unused",
        out: () => {},
        planRoot: root,
      }),
    ).rejects.toBeInstanceOf(PlanError);
    expect(await listRuns(db, scope)).toHaveLength(0);
  });
});
