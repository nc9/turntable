import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeWorld } from "@turntable/provider-sdk/testing";
import {
  addCut,
  claimNextAttempt,
  countRunning,
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  type Db,
  finishAttempt,
  getJob,
  getRun,
  heartbeatAttempt,
  listAttempts,
  listEvents,
  listExpiredLeases,
  listSteps,
  openDatabase,
  recordExec,
  rerunJobs,
  type Scope,
  setRunStatus,
  transitionJob,
  updateAttempt,
} from "../src/db";
import { readLog } from "../src/db";
import { reconcileExpired, Scheduler, type AttemptRunner } from "../src/scheduler";

let db: Db;
const T0 = 1_800_000_000_000;
const big = { globalCap: 1000, perOrgCap: 1000 };

async function seedOrg(slug: string): Promise<Required<Scope>> {
  const org = await createOrg(db, { slug, name: slug });
  const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "app" });
  return { orgId: org.id, projectId: project.id };
}

/** A run with one queued job and attempt per key. `needs` maps a key to its dependencies. */
async function queueRun(
  scope: Required<Scope>,
  keys: string[] = ["build"],
  needs: Record<string, string[]> = {},
) {
  const run = await createRun(db, scope, {
    workflowPath: "w.yml",
    event: "push",
    ref: "main",
    sha: "a".repeat(40),
  });
  const out: Record<string, { jobId: string; attemptId: string }> = {};
  for (const key of keys) {
    const job = (await createJob(db, scope, {
      runId: run.id,
      jobKey: key,
      name: key,
      needs: needs[key] ?? [],
    }))!;
    const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "fake" }))!;
    out[key] = { jobId: job.id, attemptId: attempt.id };
  }
  type Key =
    | "build"
    | "test"
    | "deploy"
    | "ok"
    | "bad"
    | "boom"
    | "skip"
    | "exited"
    | "bare"
    | "noprov";
  return { run, ...out } as { run: typeof run } & Record<Key, { jobId: string; attemptId: string }>;
}

beforeEach(() => {
  db = openDatabase(":memory:");
});

const claim = (owner: string, over: Partial<Parameters<typeof claimNextAttempt>[1]> = {}) =>
  claimNextAttempt(db, { owner, leaseMs: 1000, now: T0, ...big, ...over });

test("claim moves attempt, job and run to running under a lease, with events", async () => {
  const s = await seedOrg("a");
  const q = await queueRun(s);
  const c = (await claim("w1"))!;
  expect(c.attempt).toMatchObject({
    id: q.build.attemptId,
    state: "running",
    leaseOwner: "w1",
    leaseExpiresAt: T0 + 1000,
    heartbeatAt: T0,
  });
  expect(c.job.state).toBe("running");
  expect(c.run.status).toBe("running");
  expect(await claim("w2")).toBeUndefined(); // nothing left
  const types = (await listEvents(db, s, { after: 0, limit: 50 })).map((e) => e.type);
  expect(types).toContain("run.started");
  expect(types.filter((t) => t === "job.state_changed").length).toBeGreaterThanOrEqual(2);
});

test("claim exclusivity: concurrent workers never claim the same attempt", async () => {
  const s = await seedOrg("a");
  const total = 24;
  for (let i = 0; i < total; i++) await queueRun(s);
  const claimed: string[] = [];
  const worker = async (name: string) => {
    for (;;) {
      const c = await claim(name);
      if (!c) return;
      claimed.push(c.attempt.id);
      await Bun.sleep(0);
    }
  };
  await Promise.all(Array.from({ length: 8 }, (_, i) => worker(`w${i}`)));
  expect(claimed).toHaveLength(total);
  expect(new Set(claimed).size).toBe(total);
  expect(await countRunning(db)).toBe(total);
});

test("claim exclusivity across processes' worth of schedulers: each attempt runs once", async () => {
  const s = await seedOrg("a");
  for (let i = 0; i < 12; i++) await queueRun(s);
  const ran: string[] = [];
  const runner: AttemptRunner = async (ctx) => {
    ran.push(ctx.attempt.id);
    await Bun.sleep(5);
    return { state: "success", reason: "ok" };
  };
  const mk = () =>
    new Scheduler({ db, runner, providers: () => new FakeWorld().provider(), ...big, pollMs: 5 });
  const schedulers = [mk(), mk(), mk()];
  await Promise.all(schedulers.map((x) => x.tick()));
  await Promise.all(schedulers.map((x) => x.idle()));
  expect(ran).toHaveLength(12);
  expect(new Set(ran).size).toBe(12);
  expect(await countRunning(db)).toBe(0);
});

test("caps: global, and per org so one tenant cannot take every slot", async () => {
  const a = await seedOrg("a");
  const b = await seedOrg("b");
  for (let i = 0; i < 5; i++) await queueRun(a);
  for (let i = 0; i < 5; i++) await queueRun(b);

  const got: string[] = [];
  for (let i = 0; i < 10; i++) {
    const c = await claim("w", { perOrgCap: 2, globalCap: 100 });
    if (!c) break;
    got.push(c.scope.orgId);
  }
  expect(got.filter((o) => o === a.orgId)).toHaveLength(2);
  expect(got.filter((o) => o === b.orgId)).toHaveLength(2); // b is served although a's attempts are older
  expect(await countRunning(db, a.orgId)).toBe(2);

  // finishing one frees that org's slot
  const running = (
    await db.orm.select().from((await import("../src/db")).schema.jobAttempts)
  ).filter((x) => x.orgId === a.orgId && x.state === "running")[0]!;
  expect(
    await finishAttempt(db, a, {
      attemptId: running.id,
      owner: "w",
      state: "success",
      exitCode: 0,
    }),
  ).toBe(true);
  expect((await claim("w", { perOrgCap: 2, globalCap: 100 }))?.scope.orgId).toBe(a.orgId);

  // global cap binds across orgs
  const db2 = openDatabase(":memory:");
  db = db2;
  const x = await seedOrg("x");
  const y = await seedOrg("y");
  for (let i = 0; i < 3; i++) {
    await queueRun(x);
    await queueRun(y);
  }
  const g: string[] = [];
  for (let i = 0; i < 6; i++) {
    const c = await claim("w", { perOrgCap: 10, globalCap: 3 });
    if (c) g.push(c.attempt.id);
  }
  expect(g).toHaveLength(3);
});

test("needs: a job waits for its dependencies, and never runs behind a failed one", async () => {
  const s = await seedOrg("a");
  const q = await queueRun(s, ["build", "test", "deploy"], { test: ["build"], deploy: ["test"] });
  const first = (await claim("w"))!;
  expect(first.job.jobKey).toBe("build");
  expect(await claim("w")).toBeUndefined(); // test waits on build

  expect(
    await finishAttempt(db, s, {
      attemptId: q.build.attemptId,
      owner: "w",
      state: "success",
      exitCode: 0,
    }),
  ).toBe(true);
  const second = (await claim("w"))!;
  expect(second.job.jobKey).toBe("test");
  expect(await claim("w")).toBeUndefined(); // deploy waits on test

  expect(
    await finishAttempt(db, s, {
      attemptId: q.test.attemptId,
      owner: "w",
      state: "failure",
      exitCode: 1,
    }),
  ).toBe(true);
  expect(await claim("w")).toBeUndefined(); // deploy never runs behind a failure
  expect((await getJob(db, s, q.deploy.jobId))?.state).toBe("queued");
});

test("heartbeat extends the lease, and reports false once the attempt is gone", async () => {
  const s = await seedOrg("a");
  const q = await queueRun(s);
  await claim("w1");
  expect(await heartbeatAttempt(db, s, q.build.attemptId, "w1", T0 + 500, 1000)).toBe(true);
  expect((await listAttempts(db, s, q.build.jobId))[0]).toMatchObject({
    leaseExpiresAt: T0 + 1500,
    heartbeatAt: T0 + 500,
  });
  expect(await heartbeatAttempt(db, s, q.build.attemptId, "someone-else", T0, 1000)).toBe(false);
  await updateAttempt(db, s, q.build.attemptId, { state: "cancelled" });
  expect(await heartbeatAttempt(db, s, q.build.attemptId, "w1", T0, 1000)).toBe(false);
});

test("finishing is fenced by the lease owner and clears the lease", async () => {
  const s = await seedOrg("a");
  const q = await queueRun(s);
  await claim("w1");
  expect(
    await finishAttempt(db, s, {
      attemptId: q.build.attemptId,
      owner: "w2",
      state: "success",
      exitCode: 0,
    }),
  ).toBe(false);
  expect((await getJob(db, s, q.build.jobId))?.state).toBe("running");
  expect(
    await finishAttempt(db, s, {
      attemptId: q.build.attemptId,
      owner: "w1",
      state: "success",
      exitCode: 0,
    }),
  ).toBe(true);
  expect(
    await finishAttempt(db, s, {
      attemptId: q.build.attemptId,
      owner: "w1",
      state: "failure",
      exitCode: 1,
    }),
  ).toBe(false); // not twice
  expect((await listAttempts(db, s, q.build.jobId))[0]).toMatchObject({
    state: "success",
    leaseOwner: null,
    leaseExpiresAt: null,
    exitCode: 0,
  });
  expect(await getJob(db, s, q.build.jobId)).toMatchObject({ state: "success", exitCode: 0 });
  expect((await getRun(db, s, q.run.id))?.status).toBe("success");
  // an expiredBefore guard refuses a lease that is still alive
  const q2 = await queueRun(s);
  await claim("w1");
  expect(
    await finishAttempt(db, s, {
      attemptId: q2.build.attemptId,
      owner: "w1",
      state: "infra_error",
      expiredBefore: T0,
    }),
  ).toBe(false);
});

test("scheduler end to end: outcomes, store writes, and a thrown runner is infra_error", async () => {
  const s = await seedOrg("a");
  const ok = await queueRun(s, ["ok"]);
  const bad = await queueRun(s, ["bad"]);
  const boom = await queueRun(s, ["boom"]);
  const skip = await queueRun(s, ["skip"]);
  const runner: AttemptRunner = async (ctx) => {
    const key = ctx.job.jobKey;
    if (key === "ok") {
      await ctx.store.setExec({ sandboxId: "sb-1" });
      await ctx.store.appendLog(0, new TextEncoder().encode("hello\n"));
      await ctx.store.recordStep({
        stepKey: "s1",
        stage: "main",
        index: 0,
        name: "Build",
        result: "success",
        logOffset: 0,
      });
      await ctx.store.addCut({ atOffset: 6, omittedBytes: 100, reason: "cap" });
      return { state: "success", reason: "ok" };
    }
    if (key === "bad") return { state: "failure", exitCode: 3, reason: "tests failed" };
    if (key === "skip") return { state: "skipped", reason: "nothing to do" };
    throw new Error("sandbox exploded");
  };
  const sched = new Scheduler({ db, runner, providers: () => new FakeWorld().provider(), ...big });
  expect(await sched.tick()).toBe(4);
  await sched.idle();

  const state = async (t: { jobId: string }) => (await getJob(db, s, t.jobId))!;
  expect(await state(ok.ok)).toMatchObject({ state: "success", exitCode: 0 });
  expect(await state(bad.bad)).toMatchObject({ state: "failure", exitCode: 3 });
  expect(await state(skip.skip)).toMatchObject({ state: "skipped", exitCode: null });
  expect(await state(boom.boom)).toMatchObject({ state: "infra_error" });
  expect((await listAttempts(db, s, boom.boom.jobId))[0]!.errorClass).toBe("sandbox exploded");
  const att = (await listAttempts(db, s, ok.ok.jobId))[0]!;
  expect(att).toMatchObject({ sandboxId: "sb-1", state: "success", leaseOwner: null });
  expect(Buffer.concat((await readLog(db, s, att.id)).map((c) => c.bytes)).toString()).toBe(
    "hello\n",
  );
  expect((await listSteps(db, s, att.id)).map((x) => x.name)).toEqual(["Build"]);
  expect((await getRun(db, s, ok.run.id))?.status).toBe("success");
  expect((await getRun(db, s, bad.run.id))?.status).toBe("failure");
  expect((await getRun(db, s, boom.run.id))?.status).toBe("infra_error");
  void addCut;
});

test("an attempt whose provider is unknown ends as infra_error, not stuck", async () => {
  const s = await seedOrg("a");
  const q = await queueRun(s);
  const sched = new Scheduler({
    db,
    runner: async () => ({ state: "success", reason: "x" }),
    providers: () => undefined,
    ...big,
  });
  await sched.tick();
  await sched.idle();
  expect((await listAttempts(db, s, q.build.jobId))[0]).toMatchObject({
    state: "infra_error",
    errorClass: "no provider named fake",
  });
});

test("cancelling a running attempt aborts its runner and the result is not overwritten", async () => {
  const s = await seedOrg("a");
  const q = await queueRun(s);
  let aborted = false;
  const runner: AttemptRunner = (ctx) =>
    new Promise((resolve) => {
      ctx.signal.addEventListener("abort", () => {
        aborted = true;
        resolve({ state: "cancelled", reason: "lease lost" });
      });
    });
  const sched = new Scheduler({
    db,
    runner,
    providers: () => new FakeWorld().provider(),
    ...big,
    heartbeatMs: 20,
    leaseMs: 5000,
  });
  await sched.tick();
  await Bun.sleep(30);
  // cancel the way the cancel op does
  await updateAttempt(db, s, q.build.attemptId, { state: "cancelled" });
  await transitionJob(db, s, q.build.jobId, "cancelled");
  await sched.idle();
  expect(aborted).toBe(true);
  expect((await getJob(db, s, q.build.jobId))?.state).toBe("cancelled");
  expect((await listAttempts(db, s, q.build.jobId))[0]?.state).toBe("cancelled");
});

test("a rerun's queued attempt is picked up like any other", async () => {
  const s = await seedOrg("a");
  const q = await queueRun(s);
  const first = new Scheduler({
    db,
    runner: async () => ({ state: "failure", exitCode: 1, reason: "red" }),
    providers: () => new FakeWorld().provider(),
    ...big,
  });
  await first.tick();
  await first.idle();
  expect((await getJob(db, s, q.build.jobId))?.state).toBe("failure");

  expect(
    await rerunJobs(db, s, { runId: q.run.id, jobs: "failed", reason: "flaky" }),
  ).toBeDefined();
  const second = new Scheduler({
    db,
    runner: async () => ({ state: "success", reason: "green" }),
    providers: () => new FakeWorld().provider(),
    ...big,
  });
  expect(await second.tick()).toBe(1);
  await second.idle();
  expect(await getJob(db, s, q.build.jobId)).toMatchObject({ state: "success", exitCode: 0 });
  expect((await listAttempts(db, s, q.build.jobId)).map((x) => [x.attempt, x.state])).toEqual([
    [1, "failure"],
    [2, "success"],
  ]);
  expect((await getRun(db, s, q.run.id))?.status).toBe("success");
});

test("an attempt waiting for approval is never claimed", async () => {
  const s = await seedOrg("a");
  const q = await queueRun(s);
  await transitionJob(db, s, q.build.jobId, "awaiting_approval");
  expect(await claim("w")).toBeUndefined();
});

test("reconcile: an expired lease is resolved after probing and destroying the sandbox", async () => {
  const s = await seedOrg("a");
  const q = await queueRun(s);
  const world = new FakeWorld();
  const provider = world.provider();
  try {
    await claim("dead-worker");
    const sb = await provider.create({
      name: "x",
      labels: {},
      ttlSeconds: 600,
      network: { egress: "none" },
    });
    const { execId } = await provider.exec.start(sb.id, {
      argv: ["sleep", "30"],
      timeoutSeconds: 60,
    });
    await recordExec(db, s, q.build.attemptId, "dead-worker", { sandboxId: sb.id, execId });

    // lease still alive: untouched
    expect((await reconcileExpired(db, () => provider, { now: () => T0 + 500 })).resolved).toEqual(
      [],
    );
    expect(await listExpiredLeases(db, T0 + 500)).toEqual([]);

    const report = await reconcileExpired(db, () => provider, { now: () => T0 + 2000 });
    expect(report.resolved).toHaveLength(1);
    expect(report.resolved[0]).toMatchObject({
      attemptId: q.build.attemptId,
      sandboxId: sb.id,
      probe: "exec running",
    });
    expect(await provider.list({})).toEqual([]); // sandbox destroyed, the exec with it
    const att = (await listAttempts(db, s, q.build.jobId))[0]!;
    expect(att).toMatchObject({ state: "infra_error", leaseOwner: null });
    expect(att.errorClass).toBe("controller_lost (exec running)");
    expect((await getJob(db, s, q.build.jobId))?.state).toBe("infra_error");
    expect((await getRun(db, s, q.run.id))?.status).toBe("infra_error");
    const events = (await listEvents(db, s, { after: 0, limit: 100 })).map((e) => e.type);
    expect(events).toContain("infra.error");

    // the dead worker, if it comes back, cannot overwrite the resolution
    expect(
      await finishAttempt(db, s, {
        attemptId: q.build.attemptId,
        owner: "dead-worker",
        state: "success",
        exitCode: 0,
      }),
    ).toBe(false);
    // idempotent
    expect((await reconcileExpired(db, () => provider, { now: () => T0 + 3000 })).resolved).toEqual(
      [],
    );
  } finally {
    world.dispose();
  }
});

test("reconcile: exec already exited, no sandbox recorded, unknown provider, provider down", async () => {
  const s = await seedOrg("a");
  const world = new FakeWorld();
  const provider = world.provider();
  try {
    const exited = await queueRun(s, ["exited"]);
    const bare = await queueRun(s, ["bare"]);
    const noProv = await queueRun(s, ["noprov"]);
    for (let i = 0; i < 3; i++) await claim("dead");
    const sb = await provider.create({
      name: "x",
      labels: {},
      ttlSeconds: 600,
      network: { egress: "none" },
    });
    const { execId } = await provider.exec.start(sb.id, { argv: ["true"], timeoutSeconds: 10 });
    for (let i = 0; i < 50; i++) {
      if ((await provider.exec.status(sb.id, execId)).state !== "running") break;
      await Bun.sleep(20);
    }
    await recordExec(db, s, exited.exited.attemptId, "dead", { sandboxId: sb.id, execId });
    await recordExec(db, s, noProv.noprov.attemptId, "dead", { sandboxId: "sb-x" });

    const resolver = (name: string) => (name === "fake" ? provider : undefined);
    const report = await reconcileExpired(db, (n) => (n === "fake" ? provider : undefined), {
      now: () => T0 + 5000,
    });
    expect(report.resolved).toHaveLength(3);
    const byId = Object.fromEntries(report.resolved.map((r) => [r.attemptId, r.probe]));
    // an exec that finished while nobody watched is NOT trusted: infra_error, with the probe noted
    expect(byId[exited.exited.attemptId]).toBe("exec exited");
    expect(byId[bare.bare.attemptId]).toBe("no sandbox recorded");
    expect(byId[noProv.noprov.attemptId]).toBe("sandbox created, no exec recorded");
    for (const t of [exited.exited, bare.bare, noProv.noprov]) {
      expect((await getJob(db, s, t.jobId))?.state).toBe("infra_error");
    }
    void resolver;
  } finally {
    world.dispose();
  }
  // a provider that is down: still resolved, noted
  const s2 = await seedOrg("b");
  const q = await queueRun(s2);
  await claim("dead");
  await recordExec(db, s2, q.build.attemptId, "dead", { sandboxId: "gone", execId: "e" });
  const w2 = new FakeWorld();
  try {
    const rep = await reconcileExpired(db, () => w2.provider(), { now: () => T0 + 9000 });
    expect(rep.resolved.find((r) => r.attemptId === q.build.attemptId)?.probe).toStartWith(
      "probe failed",
    );
  } finally {
    w2.dispose();
  }
});

test("local runs (running, no lease) are never reconciled", async () => {
  const s = await seedOrg("a");
  const run = await createRun(db, s, { workflowPath: "w", event: "push", ref: "main" });
  const job = (await createJob(db, s, { runId: run.id, jobKey: "j", name: "j" }))!;
  const att = (await createAttempt(db, s, { jobId: job.id, provider: "docker" }))!;
  await transitionJob(db, s, job.id, "running");
  await updateAttempt(db, s, att.id, { state: "running" });
  await setRunStatus(db, s, run.id, "running");
  expect(
    (await reconcileExpired(db, () => undefined, { now: () => T0 + 10 ** 9 })).resolved,
  ).toEqual([]);
  expect((await getJob(db, s, job.id))?.state).toBe("running");
});

test("kill -9 mid-run: the next boot resolves the abandoned attempt as infra_error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-kill9-"));
  const path = join(dir, "turntable.db");
  try {
    db = openDatabase(path);
    const s = await seedOrg("a");
    const q = await queueRun(s);

    const child = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "helpers/kill9-worker.ts"), path, "800"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    // wait for the child to say it claimed the attempt
    const reader = child.stdout.getReader();
    let said = "";
    const deadline = Date.now() + 15_000;
    while (!said.includes("claimed") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      said += new TextDecoder().decode(value);
    }
    expect(said).toContain(`claimed ${q.build.attemptId}`);
    expect((await getJob(db, s, q.build.jobId))?.state).toBe("running");

    child.kill("SIGKILL");
    await child.exited;

    // before the lease expires nothing is resolved (the worker might only be slow)
    expect((await reconcileExpired(db, () => undefined)).resolved).toEqual([]);
    await Bun.sleep(900);

    const report = await reconcileExpired(db, () => undefined);
    expect(report.resolved.map((r) => r.attemptId)).toEqual([q.build.attemptId]);
    const att = (await listAttempts(db, s, q.build.jobId))[0]!;
    expect(att).toMatchObject({ state: "infra_error", leaseOwner: null });
    expect(att.errorClass).toStartWith("controller_lost");
    expect((await getJob(db, s, q.build.jobId))?.state).toBe("infra_error");
    expect((await getRun(db, s, q.run.id))?.status).toBe("infra_error");
    // and a rerun brings it back to the queue for the next worker
    expect(
      await rerunJobs(db, s, { runId: q.run.id, jobs: "failed", reason: "after crash" }),
    ).toBeDefined();
    expect((await getJob(db, s, q.build.jobId))?.state).toBe("queued");
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 40_000);

test("scoped lease operations cannot touch another org's attempt", async () => {
  const a = await seedOrg("a");
  const b = await seedOrg("b");
  const q = await queueRun(a);
  await claim("w1");
  const id = q.build.attemptId;
  expect(await heartbeatAttempt(db, b, id, "w1", T0, 1000)).toBe(false);
  expect(await recordExec(db, b, id, "w1", { sandboxId: "stolen" })).toBe(false);
  expect(
    await finishAttempt(db, b, { attemptId: id, owner: "w1", state: "success", exitCode: 0 }),
  ).toBe(false);
  expect((await listAttempts(db, a, q.build.jobId))[0]).toMatchObject({
    state: "running",
    sandboxId: null,
    leaseOwner: "w1",
  });
  // and the same org, other project
  const other = await createProject(db, { orgId: a.orgId }, { slug: "other", name: "other" });
  const sibling = { orgId: a.orgId, projectId: other.id };
  expect(
    await finishAttempt(db, sibling, { attemptId: id, owner: "w1", state: "success", exitCode: 0 }),
  ).toBe(false);
  expect(await heartbeatAttempt(db, sibling, id, "w1", T0, 1000)).toBe(false);
});

test("the act runner reports a rejected plan, a missing repo binding and a missing workflow as infra_error", async () => {
  const { bindRepo } = await import("../src/db");
  const { createActRunner } = await import("../src/scheduler");
  const world = new FakeWorld();
  try {
    const s = await seedOrg("a");
    const source = (yaml: string | undefined) => ({
      checkout: async () => ({
        tarball: new Uint8Array(),
        readFile: (p: string) => (p === "w.yml" ? yaml : undefined),
      }),
    });
    const run = async (yaml: string | undefined) => {
      const q = await queueRun(s);
      const sched = new Scheduler({
        db,
        providers: () => world.provider(),
        runner: createActRunner({ db, source: source(yaml) }),
        ...big,
      });
      await sched.tick();
      await sched.idle();
      return (await listAttempts(db, s, q.build.jobId))[0]!;
    };

    // no repo bound to the project yet
    expect((await run("jobs: {}")).errorClass).toBe("project has no bound repo to fetch from");
    await bindRepo(db, s, { forge: "github", owner: "acme", repo: "web" });
    expect((await run(undefined)).errorClass).toContain("workflow w.yml not found");
    const matrix = `jobs:\n  build:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        n: [1, 2]\n    steps:\n      - run: echo hi\n`;
    const rejected = await run(matrix);
    expect(rejected.state).toBe("infra_error");
    expect(rejected.errorClass).toStartWith("plan rejected:");
  } finally {
    world.dispose();
  }
});
