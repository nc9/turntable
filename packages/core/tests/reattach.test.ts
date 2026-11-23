import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import type { Provider } from "@turntable/provider-sdk";
import {
  appendLogFenced,
  bindRepo,
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  type Db,
  getJob,
  getRun,
  listAttempts,
  listSteps,
  openDatabase,
  readLog,
  recordExec,
  type Scope,
} from "../src/db";
import { claimNextAttempt } from "../src/db";
import { executeJob } from "../src/run/job-exec";
import type { RunStore } from "../src/run/store";
import { SecretRegistry } from "@turntable/redact";
import { createActRunner, reconcileExpired, Scheduler } from "../src/scheduler";
import { onPostgres } from "./pg-mode";

const FIXTURE = join(import.meta.dir, "../../act-runner/tests/fixtures");
const T0 = 1_800_000_000_000;

const WORKFLOW =
  "name: t\non: push\njobs:\n  hello:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n";

/** A repo source whose only job is to supply the workflow: a re-attach replays the exec, it does not rerun it. */
const source = {
  checkout: async () => ({
    tarball: new Uint8Array(),
    readFile: (p: string) => (p === "w.yml" ? WORKFLOW : undefined),
  }),
};

let world: FakeWorld;
let provider: Provider;
let db: Db;
let scope: Required<Scope>;

beforeEach(async () => {
  world = new FakeWorld();
  provider = world.provider();
  db = openDatabase(":memory:");
  const org = await createOrg(db, { slug: "a", name: "a" });
  const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "app" });
  scope = { orgId: org.id, projectId: project.id };
  await bindRepo(db, scope, { forge: "github", owner: "acme", repo: "web" });
});
afterEach(() => world.dispose());

/** Starts a job the way a worker would: a sandbox and an exec printing act's output. */
async function startJob(fixture: string, tail = "sleep 0.3") {
  const sb = await provider.create({
    name: "job",
    labels: {},
    ttlSeconds: 600,
    network: { egress: "none" },
  });
  const { execId } = await provider.exec.start(sb.id, {
    argv: ["sh", "-c", `cat '${join(FIXTURE, fixture)}'; ${tail}`],
    timeoutSeconds: 30,
  });
  return { sandboxId: sb.id, execId };
}

async function untilDone(sandboxId: string, execId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await provider.exec.status(sandboxId, execId)).state !== "running") return;
    await Bun.sleep(25);
  }
  throw new Error("exec did not finish");
}

async function queued() {
  const run = await createRun(db, scope, {
    workflowPath: "w.yml",
    event: "push",
    ref: "main",
    sha: "a".repeat(40),
  });
  const job = (await createJob(db, scope, { runId: run.id, jobKey: "hello", name: "hello" }))!;
  const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "fake" }))!;
  return { run, job, attempt };
}

const logOf = async (attemptId: string) =>
  Buffer.concat((await readLog(db, scope, attemptId)).map((c) => c.bytes)).toString();

test("executeJob can resume an exec that finished while nobody watched", async () => {
  const { sandboxId, execId } = await startJob("success.jsonl", "true");
  await untilDone(sandboxId, execId);
  let text = "";
  const steps: string[] = [];
  let resets = 0;
  const store = {
    setSandbox: async () => {},
    setExec: async () => {},
    resetOutput: async () => void resets++,
    appendLog: async (_id: string, _o: number, bytes: Uint8Array) =>
      void (text += new TextDecoder().decode(bytes)),
    recordStep: async (_id: string, s: { stepKey: string; result?: string }) =>
      void steps.push(`${s.stepKey}:${s.result ?? "running"}`),
    finishJob: async () => {},
  } as unknown as RunStore;
  const res = await executeJob(
    { provider, store, out: () => {}, registry: new SecretRegistry(), pollMs: 25 },
    { runId: "r", jobId: "j", attemptId: "a" },
    undefined,
    { sandboxId, execId },
  );
  expect(res).toMatchObject({ state: "success", exitCode: 0 });
  expect(resets).toBe(1); // the stored output is cleared once, then rewritten from the replay
  expect(text).toContain("✓ Set up job");
  expect(text).toContain("job success");
  expect(steps.length).toBeGreaterThan(0);
  expect(await provider.list({})).toEqual([]); // the sandbox is destroyed afterwards
});

test("reconcile hands a still-running exec to a worker, which re-attaches and records the real result", async () => {
  const { attempt, job, run } = await queued();
  await claimNextAttempt(db, {
    owner: "dead-worker",
    leaseMs: 1000,
    now: T0,
    globalCap: 9,
    perOrgCap: 9,
  });
  const { sandboxId, execId } = await startJob("success.jsonl", "sleep 0.4");
  await recordExec(db, scope, attempt.id, "dead-worker", { sandboxId, execId });
  // the dead worker had stored some of the log before it died
  expect(
    await appendLogFenced(
      db,
      scope,
      attempt.id,
      "dead-worker",
      0,
      new TextEncoder().encode("stale partial\n"),
    ),
  ).toBe(true);

  const sched = new Scheduler({
    db,
    providers: () => provider,
    runner: createActRunner({
      db,
      source,
      pollMs: 25,
    }),
    leaseMs: 60_000,
  });
  const report = await reconcileExpired(db, () => provider, {
    now: () => T0 + 5000,
    owner: sched.owner,
    leaseMs: 60_000,
    adopt: (claim, resume) => sched.adopt(claim, resume),
  });
  expect(report.adopted).toHaveLength(1);
  expect(report.adopted[0]).toMatchObject({ attemptId: attempt.id, probe: "exec running" });
  expect(report.resolved).toEqual([]);
  await sched.idle();

  const after = (await listAttempts(db, scope, job.id))[0]!;
  expect(after).toMatchObject({ state: "success", exitCode: 0, leaseOwner: null });
  expect((await getJob(db, scope, job.id))?.state).toBe("success");
  expect((await getRun(db, scope, run.id))?.status).toBe("success");
  const log = await logOf(attempt.id);
  expect(log).not.toContain("stale partial"); // rewritten from the full replay, not appended to
  expect(log).toContain("✓ Set up job");
  expect(log).toContain("job success");
  expect((await listSteps(db, scope, attempt.id)).length).toBeGreaterThan(0);
  expect(await provider.list({})).toEqual([]);
});

test("an exec that exited or failed meanwhile keeps its real verdict", async () => {
  for (const [fixture, expected, tail] of [
    ["success.jsonl", "success", "true"],
    ["failure.jsonl", "failure", "exit 1"],
  ] as const) {
    const q = await queued();
    await claimNextAttempt(db, {
      owner: "dead",
      leaseMs: 1000,
      now: T0,
      globalCap: 9,
      perOrgCap: 9,
    });
    const { sandboxId, execId } = await startJob(fixture, tail);
    await untilDone(sandboxId, execId);
    await recordExec(db, scope, q.attempt.id, "dead", { sandboxId, execId });
    const sched = new Scheduler({
      db,
      providers: () => provider,
      runner: createActRunner({
        db,
        source,
        pollMs: 25,
      }),
      leaseMs: 60_000,
    });
    const rep = await reconcileExpired(db, () => provider, {
      now: () => T0 + 5000,
      owner: sched.owner,
      leaseMs: 60_000,
      adopt: (c, r) => sched.adopt(c, r),
    });
    expect(rep.adopted[0]?.probe).toBe("exec exited");
    await sched.idle();
    expect((await listAttempts(db, scope, q.job.id))[0]?.state).toBe(expected);
    expect((await getRun(db, scope, q.run.id))?.status).toBe(expected);
  }
});

test("a lost exec or a vanished sandbox is not adopted: it is infra_error", async () => {
  const lost = await queued();
  const gone = await queued();
  await claimNextAttempt(db, { owner: "dead", leaseMs: 1000, now: T0, globalCap: 9, perOrgCap: 9 });
  await claimNextAttempt(db, { owner: "dead", leaseMs: 1000, now: T0, globalCap: 9, perOrgCap: 9 });
  const a = await startJob("success.jsonl", "sleep 5");
  world.loseExec(a.sandboxId, a.execId);
  await recordExec(db, scope, lost.attempt.id, "dead", a);
  await recordExec(db, scope, gone.attempt.id, "dead", {
    sandboxId: "no-such-sandbox",
    execId: "e1",
  });
  const adopted: string[] = [];
  const rep = await reconcileExpired(db, () => provider, {
    now: () => T0 + 5000,
    owner: "new",
    adopt: (c) => void adopted.push(c.attempt.id),
  });
  expect(adopted).toEqual([]);
  const probes = Object.fromEntries(rep.resolved.map((r) => [r.attemptId, r.probe]));
  expect(probes[lost.attempt.id]).toBe("exec lost");
  expect(probes[gone.attempt.id]).toMatch(/^probe failed/);
  expect((await listAttempts(db, scope, lost.job.id))[0]?.state).toBe("infra_error");
  expect((await listAttempts(db, scope, gone.job.id))[0]?.state).toBe("infra_error");
});

test("after takeover the dead worker is fenced out of the log", async () => {
  const { attempt } = await queued();
  await claimNextAttempt(db, { owner: "old", leaseMs: 1000, now: T0, globalCap: 9, perOrgCap: 9 });
  const { sandboxId, execId } = await startJob("success.jsonl", "true");
  await recordExec(db, scope, attempt.id, "old", { sandboxId, execId });
  const { takeExpiredLease } = await import("../src/db");
  expect(
    await takeExpiredLease(db, attempt.id, { owner: "new", leaseMs: 1000, now: T0 + 500 }),
  ).toBeUndefined(); // not expired
  expect(
    await takeExpiredLease(db, attempt.id, { owner: "new", leaseMs: 1000, now: T0 + 2000 }),
  ).toBeDefined();
  expect(
    await appendLogFenced(
      db,
      scope,
      attempt.id,
      "old",
      0,
      new TextEncoder().encode("zombie write"),
    ),
  ).toBe(false);
  expect(
    await appendLogFenced(db, scope, attempt.id, "new", 0, new TextEncoder().encode("owner write")),
  ).toBe(true);
  expect(await logOf(attempt.id)).toBe("owner write");
  // and only one taker wins
  expect(
    await takeExpiredLease(db, attempt.id, { owner: "third", leaseMs: 1000, now: T0 + 2500 }),
  ).toBeUndefined();
});

test.skipIf(onPostgres)(
  "kill -9 the worker while the job runs, let the job finish, reboot: success with the full log",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-kill9-attach-"));
    const path = join(dir, "turntable.db");
    try {
      db = openDatabase(path);
      const org = await createOrg(db, { slug: "k", name: "k" });
      const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "app" });
      scope = { orgId: org.id, projectId: project.id };
      await bindRepo(db, scope, { forge: "github", owner: "acme", repo: "web" });
      const q = await queued();

      // the job runs in a sandbox that outlives the worker (a separate process tree)
      const { sandboxId, execId } = await startJob("success.jsonl", "sleep 0.6");
      const child = Bun.spawn(
        [
          "bun",
          "run",
          join(import.meta.dir, "helpers/kill9-attach-worker.ts"),
          path,
          "800",
          sandboxId,
          execId,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const reader = child.stdout.getReader();
      let said = "";
      const deadline = Date.now() + 15_000;
      while (!said.includes("claimed") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        said += new TextDecoder().decode(value);
      }
      expect(said).toContain(`claimed ${q.attempt.id}`);
      expect((await listAttempts(db, scope, q.job.id))[0]).toMatchObject({
        state: "running",
        sandboxId,
        execId,
      });
      expect(await logOf(q.attempt.id)).toBe("partial output from the dead worker\n");

      child.kill("SIGKILL");
      await child.exited;
      await untilDone(sandboxId, execId); // the job finishes while no controller is alive
      await Bun.sleep(900); // the lease lapses

      // reboot: a new process opens the same database and reconciles on boot
      db.close();
      db = openDatabase(path);
      const sched = new Scheduler({
        db,
        providers: () => provider,
        runner: createActRunner({
          db,
          source,
          pollMs: 25,
        }),
        leaseMs: 60_000,
      });
      const report = await reconcileExpired(db, () => provider, {
        owner: sched.owner,
        leaseMs: 60_000,
        adopt: (c, r) => sched.adopt(c, r),
      });
      expect(report.adopted).toHaveLength(1);
      expect(report.adopted[0]?.probe).toBe("exec exited");
      await sched.idle();

      expect((await listAttempts(db, scope, q.job.id))[0]).toMatchObject({
        state: "success",
        exitCode: 0,
        leaseOwner: null,
      });
      expect((await getRun(db, scope, q.run.id))?.status).toBe("success");
      const log = await logOf(q.attempt.id);
      expect(log).not.toContain("partial output from the dead worker");
      expect(log).toContain("✓ Set up job");
      expect(log).toContain("job success");
      expect((await listSteps(db, scope, q.attempt.id)).length).toBeGreaterThan(0);
    } finally {
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  40_000,
);
