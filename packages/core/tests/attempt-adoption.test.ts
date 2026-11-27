// Re-adopting in-flight attempts across a controller restart (#761): a hand-off mid-step, the log
// checkpoint, the lease takeover between two controllers, and the drain op's adoptable count.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import type { Provider } from "@turntable/provider-sdk";
import {
  bindRepo,
  claimNextAttempt,
  countRunningByAdoptability,
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  type Db,
  DRAIN_CUT,
  getJob,
  listAttempts,
  listSteps,
  openDatabase,
  readLog,
  recordExec,
  recordTrustClass,
  type Scope,
} from "../src/db";
import { createActRunner, reconcileExpired, Scheduler } from "../src/scheduler";
import { DrainState } from "../src/scheduler/drain";

const FIXTURE = join(import.meta.dir, "../../act-runner/tests/fixtures/success.jsonl");
const WORKFLOW =
  "name: t\non: push\njobs:\n  hello:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n";
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

/**
 * act's output for one job, printed in two halves with a pause between, so a restart lands in the
 * middle of the "Say hello" step (its step-start and first output are in the first half). The
 * exec lives in the fake provider's world, not in a controller, so it outlives both of them.
 */
async function startExec(pause = "1.2") {
  const sb = await provider.create({
    name: "job",
    labels: {},
    ttlSeconds: 600,
    network: { egress: "none" },
  });
  const { execId } = await provider.exec.start(sb.id, {
    argv: ["sh", "-c", `head -n 6 '${FIXTURE}'; sleep ${pause}; tail -n +7 '${FIXTURE}'`],
    timeoutSeconds: 30,
  });
  return { sandboxId: sb.id, execId };
}

/** A running attempt whose first controller died after starting act: what a reconcile finds. */
async function orphaned(pause?: string) {
  const run = await createRun(db, scope, {
    workflowPath: "w.yml",
    event: "push",
    ref: "main",
    sha: "a".repeat(40),
  });
  const job = (await createJob(db, scope, { runId: run.id, jobKey: "hello", name: "hello" }))!;
  const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "fake" }))!;
  await claimNextAttempt(db, { owner: "dead", leaseMs: 1, now: 1, globalCap: 99, perOrgCap: 99 });
  const where = await startExec(pause);
  expect(await recordExec(db, scope, attempt.id, "dead", where)).toBe(true);
  return { run, job, attempt, ...where };
}

const controller = (owner: string) =>
  new Scheduler({
    db,
    owner,
    providers: () => provider,
    runner: createActRunner({ db, source, pollMs: 20 }),
    leaseMs: 60_000,
    drain: new DrainState(),
  });

const reconcile = (sched: Scheduler) =>
  reconcileExpired(db, () => provider, {
    owner: sched.owner,
    leaseMs: 60_000,
    adopt: (c, r) => void sched.adopt(c, r),
  });

const logOf = async (attemptId: string) =>
  Buffer.concat((await readLog(db, scope, attemptId)).map((c) => c.bytes)).toString();

const row = async (jobId: string) => (await listAttempts(db, scope, jobId))[0]!;

async function until(f: () => Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

/** The log one controller writes when it watches the same output from start to end. */
async function referenceLog(): Promise<string> {
  const ref = await orphaned("0.05");
  const sched = controller("reference");
  await reconcile(sched);
  await sched.idle();
  expect((await row(ref.job.id)).state).toBe("success");
  return logOf(ref.attempt.id);
}

test("a restart mid-step: the next controller finishes it with its real conclusion and the same log, byte for byte", async () => {
  const expected = await referenceLog();
  expect(expected).toContain("hello from act");

  const o = await orphaned();
  const a = controller("controller-a");
  expect((await reconcile(a)).adopted).toHaveLength(1);
  // A is in the middle of "Say hello": its output is stored and a checkpoint recorded.
  await until(async () => (await logOf(o.attempt.id)).includes("hello from act"));
  await until(async () => (await row(o.job.id)).logCheckpoint !== null);

  // A shuts down: the attempt is handed off at once, without waiting for the job.
  const t0 = Date.now();
  const out = await a.drainAndWait(30_000, "deploy", { handoff: true });
  expect(out).toEqual({ remaining: 0, handedOff: 1 });
  expect(Date.now() - t0).toBeLessThan(1000);
  const handed = await row(o.job.id);
  expect(handed).toMatchObject({
    state: "running",
    leaseOwner: "controller-a",
    leaseExpiresAt: 0,
    errorClass: DRAIN_CUT,
  });
  expect(await provider.exec.status(o.sandboxId, o.execId)).toMatchObject({ state: "running" });
  const before = await logOf(o.attempt.id);
  expect(Buffer.byteLength(before)).toBeGreaterThanOrEqual(handed.logCheckpoint!);
  expect(before).not.toContain("Job succeeded");
  const stepsBefore = await listSteps(db, scope, o.attempt.id);
  expect(stepsBefore.length).toBeGreaterThan(0);
  await Bun.sleep(20);

  // B boots and re-attaches at once (the lease was handed off, not left to expire).
  const b = controller("controller-b");
  const rep = await reconcile(b);
  expect(rep.adopted.map((x) => x.attemptId)).toEqual([o.attempt.id]);
  await b.idle();

  const done = await row(o.job.id);
  expect(done).toMatchObject({ state: "success", exitCode: 0, leaseOwner: null });
  expect((await getJob(db, scope, o.job.id))?.state).toBe("success");
  const log = await logOf(o.attempt.id);
  // No gap and no duplicate bytes: exactly what one uninterrupted controller writes.
  expect(log).toBe(expected);
  // The stored prefix up to the checkpoint was kept, not rewritten.
  expect(log.startsWith(before.slice(0, handed.logCheckpoint!))).toBe(true);
  const steps = await listSteps(db, scope, o.attempt.id);
  expect(steps.map((s) => s.name)).toContain("Say hello");
  expect(new Set(steps.map((s) => s.stepIndex)).size).toBe(steps.length);
  // B resumed from the checkpoint (it did not reset and replay): the steps stored before it are
  // the same rows, with the times A recorded.
  for (const s0 of stepsBefore.filter((x) => x.logOffset < handed.logCheckpoint!)) {
    expect(steps.find((x) => x.stepKey === s0.stepKey && x.stage === s0.stage)?.startedAt).toBe(
      s0.startedAt,
    );
  }
  expect(await provider.list({})).toEqual([]);
});

test("a handed-off attempt whose sandbox is gone at boot ends infra_error and is requeued once, using no rerun", async () => {
  const o = await orphaned("5");
  await recordTrustClass(db, scope, o.attempt.id, "dead", "trusted_pr");
  const a = controller("controller-a");
  await reconcile(a);
  await until(async () => (await logOf(o.attempt.id)).includes("hello from act"));
  expect((await a.drainAndWait(30_000, "deploy", { handoff: true })).handedOff).toBe(1);

  await provider.destroy(o.sandboxId);
  const b = controller("controller-b");
  const adopted: string[] = [];
  const rep = await reconcileExpired(db, () => provider, {
    owner: b.owner,
    adopt: (c) => void adopted.push(c.attempt.id),
  });
  expect(adopted).toEqual([]);
  expect(rep.resolved.map((r) => r.attemptId)).toEqual([o.attempt.id]);
  const attempts = await listAttempts(db, scope, o.job.id);
  const old = attempts.find((x) => x.id === o.attempt.id)!;
  expect(old.state).toBe("infra_error");
  expect(old.errorClass).toStartWith("controller_lost");
  // The drain-cut requeue: a new queued attempt with no rerun reason (#712: no rerun used).
  const fresh = attempts.filter((x) => x.id !== o.attempt.id);
  expect(fresh).toHaveLength(1);
  expect(fresh[0]).toMatchObject({ state: "queued", rerunReason: null });
  expect((await getJob(db, scope, o.job.id))?.state).toBe("queued");
});

test("two controllers: an attempt is never adopted while another live controller holds its lease, and only once after", async () => {
  const o = await orphaned("1.5");
  const a = controller("controller-a");
  await reconcile(a);
  await until(async () => (await logOf(o.attempt.id)).includes("hello from act"));

  // B reconciles while A is alive and heartbeating: nothing to take.
  const b = controller("controller-b");
  const adoptedByB: string[] = [];
  const whileLive = await reconcileExpired(db, () => provider, {
    owner: b.owner,
    leaseMs: 60_000,
    adopt: (c, r) => {
      adoptedByB.push(c.attempt.id);
      b.adopt(c, r);
    },
  });
  expect(whileLive.adopted).toEqual([]);
  expect(whileLive.resolved).toEqual([]);
  expect(adoptedByB).toEqual([]);
  expect((await row(o.job.id)).leaseOwner).toBe("controller-a");

  // A hands off; B and C race to reconcile it: exactly one takes it.
  await a.drainAndWait(30_000, "deploy", { handoff: true });
  const c = controller("controller-c");
  const [rb, rc] = await Promise.all([reconcile(b), reconcile(c)]);
  expect(rb.adopted.length + rc.adopted.length).toBe(1);
  const winner = rb.adopted.length === 1 ? b : c;
  expect((await row(o.job.id)).leaseOwner).toBe(winner.owner);
  // The winner's own periodic reconcile does not take it again: its lease is live.
  expect((await reconcile(winner)).adopted).toEqual([]);
  // And a scheduler never runs two watchers for one attempt.
  const claim = { attempt: await row(o.job.id) } as Parameters<Scheduler["adopt"]>[0];
  expect(winner.adopt(claim, { sandboxId: o.sandboxId, execId: o.execId })).toBe(false);
  await Promise.all([b.idle(), c.idle()]);
  expect((await row(o.job.id)).state).toBe("success");
});

test("the drain op counts a blocked attempt apart, and a crash still re-attaches to it with its real result", async () => {
  const blocked = await orphaned("0.3");
  await recordExec(db, scope, blocked.attempt.id, "dead", { adoptBlock: "job token" });
  const open = await orphaned("0.3");
  // A third attempt claimed but not yet in a sandbox (still setting up).
  const run = await createRun(db, scope, {
    workflowPath: "w.yml",
    event: "push",
    ref: "main",
    sha: "b".repeat(40),
  });
  const job = (await createJob(db, scope, { runId: run.id, jobKey: "x", name: "x" }))!;
  await createAttempt(db, scope, { jobId: job.id, provider: "fake" });
  await claimNextAttempt(db, {
    owner: "live",
    leaseMs: 60_000,
    now: Date.now(),
    globalCap: 99,
    perOrgCap: 99,
  });
  expect(await countRunningByAdoptability(db)).toEqual({ adoptable: 1, notAdoptable: 2 });

  // The block only keeps a drain from handing the attempt off. The controller died with its exec
  // alive, so the next boot re-attaches as it always did: never killed, sandbox kept.
  const next = controller("next");
  const rep = await reconcile(next);
  expect(rep.adopted.map((x) => x.attemptId).sort()).toEqual(
    [blocked.attempt.id, open.attempt.id].sort(),
  );
  expect(rep.resolved.find((r) => r.attemptId === blocked.attempt.id)).toBeUndefined();
  await next.idle();
  expect((await row(blocked.job.id)).state).toBe("success");
  expect((await row(blocked.job.id)).errorClass).toBeNull();
});
