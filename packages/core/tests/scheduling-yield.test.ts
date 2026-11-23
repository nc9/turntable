// scheduling_class `yield` (#334): a yield project's work is claimed only while no normal work can
// be, and a normal attempt waiting at a cap preempts the newest running yield attempt, which is
// requeued under a new attempt (never failed). Runs on SQLite and, with TURNTABLE_TEST_DB, Postgres.
import { beforeEach, expect, test } from "bun:test";
import {
  appendLog,
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
  listAttempts,
  listAudit,
  listEvents,
  onAttemptsCancelled,
  openDatabase,
  readLog,
  recordExec,
  type Scope,
} from "../src/db";
import { sandboxUsageByProject } from "../src/db/repos/usage";
import { putStoredSetting } from "../src/db/repos/settings";

let db: Db;
let normal: Required<Scope>;
let yielding: Required<Scope>;
const T0 = 1_800_000_000_000;

beforeEach(async () => {
  db = openDatabase(":memory:");
  const org = await createOrg(db, { slug: "acme", name: "acme" });
  const a = await createProject(db, { orgId: org.id }, { slug: "app", name: "app" });
  const b = await createProject(db, { orgId: org.id }, { slug: "dogfood", name: "dogfood" });
  normal = { orgId: org.id, projectId: a.id };
  yielding = { orgId: org.id, projectId: b.id };
  await putStoredSetting(
    db,
    { kind: "project", id: b.id, orgId: org.id },
    "scheduling_class",
    "yield",
    "test",
    T0,
  );
});

/** One run with one queued job and attempt. Ids ascend with creation order. */
async function queue(scope: Required<Scope>, key = "build") {
  const run = await createRun(db, scope, {
    workflowPath: "w.yml",
    event: "push",
    ref: "main",
    sha: "a".repeat(40),
  });
  const job = (await createJob(db, scope, { runId: run.id, jobKey: key, name: key }))!;
  const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "fake" }))!;
  return { runId: run.id, jobId: job.id, attemptId: attempt.id };
}

const claim = (cap: { globalCap: number; perOrgCap?: number }, now = T0) =>
  claimNextAttempt(db, {
    owner: "w1",
    leaseMs: 1000,
    now,
    globalCap: cap.globalCap,
    perOrgCap: cap.perOrgCap ?? 1000,
  });

const big = { globalCap: 1000 };

test("yield waits while normal work is queued, and runs once none is", async () => {
  const y = await queue(yielding); // older
  const n = await queue(normal);
  expect((await claim(big))!.attempt.id).toBe(n.attemptId);
  expect((await claim(big))!.attempt.id).toBe(y.attemptId);
});

test("starvation bound: yield runs whenever the fleet has room and no normal work waits", async () => {
  const y = await queue(yielding);
  expect((await claim({ globalCap: 1 }))!.attempt.id).toBe(y.attemptId);
});

test("normal work that cannot run yet (a dependency is running) does not hold yield back", async () => {
  const run = await createRun(db, normal, {
    workflowPath: "w.yml",
    event: "push",
    ref: "main",
    sha: "b".repeat(40),
  });
  const build = (await createJob(db, normal, { runId: run.id, jobKey: "build", name: "build" }))!;
  await createAttempt(db, normal, { jobId: build.id, provider: "fake" });
  const test_ = (await createJob(db, normal, {
    runId: run.id,
    jobKey: "test",
    name: "test",
    needs: ["build"],
  }))!;
  await createAttempt(db, normal, { jobId: test_.id, provider: "fake" });
  const y = await queue(yielding);
  expect((await claim(big))!.job.id).toBe(build.id);
  expect((await claim(big))!.attempt.id).toBe(y.attemptId);
});

test("a normal attempt waiting at the cap preempts the newest yield attempt, which is requeued and later completes", async () => {
  const y1 = await queue(yielding);
  const y2 = await queue(yielding);
  expect((await claim({ globalCap: 2 }))!.attempt.id).toBe(y1.attemptId);
  expect((await claim({ globalCap: 2 }))!.attempt.id).toBe(y2.attemptId);
  const n = await queue(normal);

  const stopped: string[] = [];
  const off = onAttemptsCancelled((a) => stopped.push(...a.map((x) => x.attemptId)));
  await appendLog(db, yielding, y2.attemptId, 0, new TextEncoder().encode("partial\n"));
  const c = (await claim({ globalCap: 2 }))!;
  off();

  expect(c.attempt.id).toBe(n.attemptId);
  expect(stopped).toEqual([y2.attemptId]); // the worker is told through the cancel path
  const attempts = await listAttempts(db, yielding, y2.jobId);
  expect(attempts.map((a) => [a.attempt, a.state, a.errorClass])).toEqual([
    [1, "cancelled", "preempted"],
    [2, "queued", null],
  ]);
  expect(attempts[0]!.leaseOwner).toBeNull();
  expect(attempts[1]!.rerunReason).toBeNull(); // no rerun is spent
  // The newest was chosen: the older yield attempt keeps running.
  expect((await listAttempts(db, yielding, y1.jobId))[0]!.state).toBe("running");
  expect((await getJob(db, yielding, y2.jobId))!.state).toBe("queued");
  // The partial log stays readable under the old attempt id.
  const log = await readLog(db, yielding, y2.attemptId);
  expect(Buffer.concat(log.map((l) => l.bytes)).toString()).toBe("partial\n");

  // Normal work done, the requeued job runs under its new attempt and the run concludes success.
  expect(
    await finishAttempt(db, normal, {
      attemptId: n.attemptId,
      owner: "w1",
      state: "success",
      exitCode: 0,
    }),
  ).toBe(true);
  const again = (await claim({ globalCap: 2 }))!;
  expect(again.attempt).toMatchObject({ jobId: y2.jobId, attempt: 2 });
  expect(
    await finishAttempt(db, yielding, {
      attemptId: again.attempt.id,
      owner: "w1",
      state: "success",
      exitCode: 0,
    }),
  ).toBe(true);
  expect((await getRun(db, yielding, y2.runId))!.status).toBe("success");
});

test("a preempted attempt is not a failure: the run and job are never failed", async () => {
  const y = await queue(yielding);
  await claim({ globalCap: 1 });
  await queue(normal);
  await claim({ globalCap: 1 });
  expect((await getRun(db, yielding, y.runId))!.status).toBe("queued");
  const states = (await listAttempts(db, yielding, y.jobId)).map((a) => a.state);
  expect(states).not.toContain("failure");
  expect(states).not.toContain("infra_error");
});

test("audit and event rows are written for a preemption", async () => {
  const y = await queue(yielding);
  await claim({ globalCap: 1 });
  await queue(normal);
  await claim({ globalCap: 1 });
  const audit = (await listAudit(db, yielding)).filter((r) => r.op === "scheduler.preempt");
  expect(audit).toHaveLength(1);
  expect(JSON.parse(audit[0]!.input)).toMatchObject({ attempt_id: y.attemptId, job_id: y.jobId });
  const events = await listEvents(db, yielding, { after: 0, limit: 200 });
  const requeued = events.filter(
    (e) =>
      e.type === "job.state_changed" &&
      e.jobId === y.jobId &&
      JSON.parse(e.payload).to === "queued" &&
      JSON.parse(e.payload).reason === "preempted",
  );
  expect(requeued).toHaveLength(1);
});

test("a normal attempt is never preempted, and nothing is preempted when no normal work waits", async () => {
  const n1 = await queue(normal);
  await claim({ globalCap: 1 });
  await queue(normal);
  expect(await claim({ globalCap: 1 })).toBeUndefined();
  expect((await listAttempts(db, normal, n1.jobId))[0]!.state).toBe("running");

  const y = await queue(yielding);
  expect(await claim({ globalCap: 1 })).toBeUndefined(); // full: yield just waits
  expect((await listAttempts(db, yielding, y.jobId))[0]!.state).toBe("queued");
});

test("fairness: a normal fan-out with four yield jobs running starts one normal job per pass, preempting each yield once", async () => {
  const ys = [];
  for (let i = 0; i < 4; i++) ys.push(await queue(yielding));
  for (let i = 0; i < 4; i++) await claim({ globalCap: 4 });
  const ns = [];
  for (let i = 0; i < 10; i++) ns.push(await queue(normal));

  const started: string[] = [];
  for (let i = 0; i < 6; i++) {
    const c = await claim({ globalCap: 4 });
    if (c) started.push(c.attempt.id);
  }
  // One pass per slot: all four slots go to normal work, in order, and the other six wait.
  expect(started).toEqual(ns.slice(0, 4).map((n) => n.attemptId));
  expect(await countRunning(db)).toBe(4);
  for (const y of ys) {
    const a = await listAttempts(db, yielding, y.jobId);
    expect(a.map((x) => x.state)).toEqual(["cancelled", "queued"]); // preempted once, requeued once
  }
});

test("a full org cap preempts a yield attempt of that org only", async () => {
  const other = await createOrg(db, { slug: "other", name: "other" });
  const op = await createProject(db, { orgId: other.id }, { slug: "ci", name: "ci" });
  const otherScope = { orgId: other.id, projectId: op.id };
  await putStoredSetting(
    db,
    { kind: "project", id: op.id, orgId: other.id },
    "scheduling_class",
    "yield",
    "test",
    T0,
  );

  const mine = await queue(yielding);
  const theirs = await queue(otherScope);
  await claim({ globalCap: 10, perOrgCap: 1 });
  await claim({ globalCap: 10, perOrgCap: 1 });
  await queue(normal);
  const c = (await claim({ globalCap: 10, perOrgCap: 1 }))!;
  expect(c.scope.orgId).toBe(normal.orgId);
  expect((await listAttempts(db, yielding, mine.jobId))[0]!.errorClass).toBe("preempted");
  expect((await listAttempts(db, otherScope, theirs.jobId))[0]!.state).toBe("running");
});

test("sandbox minutes are reported per project with its scheduling class, preempted attempts included", async () => {
  const N = Date.now(); // the row clock stamps start and finish, so use the real one here
  const y = await queue(yielding);
  await claim({ globalCap: 1 }, N);
  await recordExec(db, yielding, y.attemptId, "w1", { sandboxCreatedAt: N - 120_000 });
  await queue(normal);
  await claim({ globalCap: 1 }, N);
  await recordExec(db, yielding, y.attemptId, "w1", { sandboxDestroyedAt: N }).catch(() => {});
  const rows = await sandboxUsageByProject(
    db,
    { orgId: normal.orgId },
    {
      from: N - 86_400_000,
      to: N + 86_400_000,
      now: N + 120_000,
    },
  );
  const mine = rows.find((r) => r.projectId === yielding.projectId)!;
  expect(mine.schedulingClass).toBe("yield");
  // The preempted attempt's sandbox counts to the yield project (its finish ends the estimate).
  expect(mine.days.reduce((n, d) => n + d.seconds, 0)).toBeGreaterThanOrEqual(60);
});
