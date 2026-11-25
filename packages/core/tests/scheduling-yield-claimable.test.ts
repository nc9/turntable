// A yield job defers to, and is preempted for, only a normal attempt that is claimable now (#625):
// one held by its project cap, a freeze, an org quota or a gate never blocks or preempts yield
// work. Runs on SQLite and, with TURNTABLE_TEST_DB, Postgres.
import { beforeEach, expect, test } from "bun:test";
import {
  claimNextAttempt,
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  type Db,
  listAttempts,
  openDatabase,
  recordTrustClass,
  type Scope,
} from "../src/db";
import { setFreeze } from "../src/db/repos/incident";
import { setOrgQuotas } from "../src/db/repos/quotas";
import { setProjectSandboxSettings } from "../src/db/repos/project-settings";
import { putStoredSetting } from "../src/db/repos/settings";

const T0 = 1_800_000_000_000;
let db: Db;
let normal: Required<Scope>; // org "acme"
let normal2: Required<Scope>; // org "acme", second normal project
let yielding: Required<Scope>; // org "dogfood-org"

beforeEach(async () => {
  db = openDatabase(":memory:");
  const org = await createOrg(db, { slug: "acme", name: "acme" });
  const org2 = await createOrg(db, { slug: "other", name: "other" });
  const a = await createProject(db, { orgId: org.id }, { slug: "app", name: "app" });
  const a2 = await createProject(db, { orgId: org.id }, { slug: "app2", name: "app2" });
  const b = await createProject(db, { orgId: org2.id }, { slug: "dogfood", name: "dogfood" });
  normal = { orgId: org.id, projectId: a.id };
  normal2 = { orgId: org.id, projectId: a2.id };
  yielding = { orgId: org2.id, projectId: b.id };
  await putStoredSetting(
    db,
    { kind: "project", id: b.id, orgId: org2.id },
    "scheduling_class",
    "yield",
    "test",
    T0,
  );
});

async function queue(scope: Required<Scope>, key = "build", event = "push") {
  const run = await createRun(db, scope, {
    workflowPath: "w.yml",
    event,
    ref: "main",
    sha: "a".repeat(40),
  });
  const job = (await createJob(db, scope, { runId: run.id, jobKey: key, name: key }))!;
  const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "fake" }))!;
  return { runId: run.id, jobId: job.id, attemptId: attempt.id };
}

/** Claims and records a PR trust class, so a running yield attempt can be a preemption victim. */
async function claim(globalCap: number, perOrgCap = 1000) {
  const c = await claimNextAttempt(db, {
    owner: "w1",
    leaseMs: 1000,
    now: T0,
    globalCap,
    perOrgCap,
  });
  if (c) {
    const scope = { orgId: c.attempt.orgId, projectId: c.attempt.projectId };
    await recordTrustClass(db, scope, c.attempt.id, "w1", "trusted_pr");
  }
  return c;
}

const states = async (scope: Required<Scope>, jobId: string) =>
  (await listAttempts(db, scope, jobId)).map((a) => [a.attempt, a.state, a.errorClass]);

test("a normal project at its own project cap neither blocks nor preempts yield jobs", async () => {
  await setProjectSandboxSettings(db, normal, { maxConcurrent: 2 });
  await queue(normal, "n1");
  await queue(normal, "n2");
  expect(await claim(10)).toBeDefined();
  expect(await claim(10)).toBeDefined(); // normal is now at its cap of 2
  const queuedNormal = await queue(normal, "n3");
  const y1 = await queue(yielding, "y1");
  const y2 = await queue(yielding, "y2");
  // Free global slots: both yield jobs claim even though normal work waits.
  expect((await claim(10))!.attempt.id).toBe(y1.attemptId);
  expect((await claim(10))!.attempt.id).toBe(y2.attemptId);
  // Global cap full (4 of 4): the capped normal job preempts nothing.
  expect(await claim(4)).toBeUndefined();
  expect(await states(yielding, y1.jobId)).toEqual([[1, "running", null]]);
  expect(await states(yielding, y2.jobId)).toEqual([[1, "running", null]]);
  expect(await states(normal, queuedNormal.jobId)).toEqual([[1, "queued", null]]);
});

test("a normal job blocked only by the global cap preempts one running yield job and is claimed", async () => {
  const y1 = await queue(yielding, "y1");
  expect((await claim(1))!.attempt.id).toBe(y1.attemptId);
  const n = await queue(normal);
  const c = await claim(1);
  expect(c!.attempt.id).toBe(n.attemptId);
  expect(await states(yielding, y1.jobId)).toEqual([
    [1, "cancelled", "preempted"],
    [2, "queued", null],
  ]);
});

test("a frozen normal project does not block or preempt yield", async () => {
  await setFreeze(db, normal, { reason: "test", by: "test", now: T0 });
  await queue(normal);
  const y = await queue(yielding);
  expect((await claim(10))!.attempt.id).toBe(y.attemptId);
  const y2 = await queue(yielding, "y2");
  expect(await claim(1)).toBeUndefined();
  expect(await states(yielding, y.jobId)).toEqual([[1, "running", null]]);
  expect(await states(yielding, y2.jobId)).toEqual([[1, "queued", null]]);
});

test("a quota-held normal org does not block or preempt yield", async () => {
  await setOrgQuotas(db, normal.orgId, { maxSandboxMinutesPerDay: 0 }, "test", T0);
  await queue(normal);
  const y = await queue(yielding);
  expect((await claim(10))!.attempt.id).toBe(y.attemptId);
  await queue(yielding, "y2");
  expect(await claim(1)).toBeUndefined();
  expect(await states(yielding, y.jobId)).toEqual([[1, "running", null]]);
});

test("a normal job waiting only on its dependency does not block or preempt yield", async () => {
  const run = await createRun(db, normal, {
    workflowPath: "w.yml",
    event: "push",
    ref: "main",
    sha: "b".repeat(40),
  });
  const build = (await createJob(db, normal, { runId: run.id, jobKey: "build", name: "build" }))!;
  await createAttempt(db, normal, { jobId: build.id, provider: "fake" });
  const dep = (await createJob(db, normal, {
    runId: run.id,
    jobKey: "test",
    name: "test",
    needs: ["build"],
  }))!;
  await createAttempt(db, normal, { jobId: dep.id, provider: "fake" });
  const y = await queue(yielding);
  expect((await claim(10))!.job.id).toBe(build.id);
  expect((await claim(10))!.attempt.id).toBe(y.attemptId);
  // Only the dependent job waits now: with the global cap full it preempts nothing.
  expect(await claim(2)).toBeUndefined();
  expect(await states(yielding, y.jobId)).toEqual([[1, "running", null]]);
});

test("a normal job held by its org's concurrency cap preempts only that org's yield work", async () => {
  // The yield project shares the normal org: one slot per org, one running yield attempt.
  const y = await queue({ orgId: normal.orgId, projectId: normal2.projectId }, "y");
  await putStoredSetting(
    db,
    { kind: "project", id: normal2.projectId, orgId: normal.orgId },
    "scheduling_class",
    "yield",
    "test",
    T0,
  );
  expect((await claim(10, 1))!.attempt.id).toBe(y.attemptId);
  const n = await queue(normal);
  expect((await claim(10, 1))!.attempt.id).toBe(n.attemptId);
  expect(await states(normal2, y.jobId)).toEqual([
    [1, "cancelled", "preempted"],
    [2, "queued", null],
  ]);
});

test("no thrash: an unclaimable normal job never preempts the same yield job repeatedly", async () => {
  await setProjectSandboxSettings(db, normal, { maxConcurrent: 1 });
  await queue(normal, "n1");
  expect(await claim(10)).toBeDefined(); // normal at its cap of 1
  await queue(normal, "n2");
  const y = await queue(yielding);
  expect((await claim(2))!.attempt.id).toBe(y.attemptId); // 2 of 2 running
  for (let i = 0; i < 5; i++) expect(await claim(2)).toBeUndefined();
  expect(await states(yielding, y.jobId)).toEqual([[1, "running", null]]);
});

test("a normal job held by its own org's cap does not mask another org's job that a preemption lets start", async () => {
  const org3 = await createOrg(db, { slug: "third", name: "third" });
  const c = await createProject(db, { orgId: org3.id }, { slug: "svc", name: "svc" });
  const third = { orgId: org3.id, projectId: c.id };
  await setOrgQuotas(db, normal.orgId, { maxConcurrent: 1 }, "test", T0);
  await queue(normal, "n1");
  const t1 = await queue(third, "t1");
  const y = await queue(yielding, "y");
  for (let i = 0; i < 3; i++) expect(await claim(3, 5)).toBeDefined(); // 3 of 3 running
  await queue(normal, "n2"); // older: held by acme's concurrency limit, no yield job runs in acme
  const t = await queue(third, "t2"); // held only by the global cap
  const got = await claim(3, 5);
  expect(got!.attempt.id).toBe(t.attemptId);
  expect(t1.attemptId).not.toBe(t.attemptId);
  expect(await states(yielding, y.jobId)).toEqual([
    [1, "cancelled", "preempted"],
    [2, "queued", null],
  ]);
});
