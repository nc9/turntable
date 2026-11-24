// Within a project, default-branch pushes and merge-queue runs (trust class protected) are claimed
// ahead of PR runs; FIFO holds inside each class; yield across projects is unchanged (#454).
// Runs on SQLite and, with TURNTABLE_TEST_DB, Postgres.
import { beforeEach, expect, test } from "bun:test";
import {
  claimNextAttempt,
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  type Db,
  finishAttempt,
  openDatabase,
  type Scope,
} from "../src/db";
import { putStoredSetting } from "../src/db/repos/settings";

let db: Db;
let app: Required<Scope>;
let other: Required<Scope>;
const T0 = 1_800_000_000_000;

beforeEach(async () => {
  db = openDatabase(":memory:");
  const org = await createOrg(db, { slug: "acme", name: "acme" });
  const a = await createProject(db, { orgId: org.id }, { slug: "app", name: "app" });
  const b = await createProject(db, { orgId: org.id }, { slug: "dogfood", name: "dogfood" });
  app = { orgId: org.id, projectId: a.id };
  other = { orgId: org.id, projectId: b.id };
});

/** One run with one queued job and attempt. Ids ascend with creation order. */
async function queue(scope: Required<Scope>, event: string) {
  const run = await createRun(db, scope, {
    workflowPath: "w.yml",
    event,
    ref: event === "pull_request" ? "refs/pull/1/merge" : "main",
    sha: "a".repeat(40),
  });
  const job = (await createJob(db, scope, { runId: run.id, jobKey: "build", name: "build" }))!;
  const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "fake" }))!;
  return attempt.id;
}

// Cap of one running attempt at a time: a slot frees only when the previous claim finishes.
const claim = () =>
  claimNextAttempt(db, { owner: "w1", leaseMs: 1000, now: T0, globalCap: 1, perOrgCap: 1 });

async function done(scope: Required<Scope>, attemptId: string) {
  await finishAttempt(db, scope, { attemptId, owner: "w1", state: "success", exitCode: 0 });
}

test("a push queued behind a PR backlog is claimed first when a slot frees", async () => {
  const running = await queue(app, "pull_request");
  expect((await claim())!.attempt.id).toBe(running);
  const pr1 = await queue(app, "pull_request");
  const pr2 = await queue(app, "pull_request");
  const push = await queue(app, "push");
  expect(await claim()).toBeUndefined(); // at the cap; the running PR attempt is not preempted
  await done(app, running);
  const first = (await claim())!;
  expect(first.attempt.id).toBe(push);
  await done(app, first.attempt.id);
  expect((await claim())!.attempt.id).toBe(pr1);
  await done(app, pr1);
  expect((await claim())!.attempt.id).toBe(pr2);
});

test("a merge-queue run is also ahead of PR runs", async () => {
  const pr = await queue(app, "pull_request");
  const mq = await queue(app, "merge_group");
  expect((await claim())!.attempt.id).toBe(mq);
  await done(app, mq);
  expect((await claim())!.attempt.id).toBe(pr);
});

test("FIFO holds within each class", async () => {
  const pr1 = await queue(app, "pull_request");
  const push1 = await queue(app, "push");
  const pr2 = await queue(app, "pull_request");
  const mq = await queue(app, "merge_group");
  const order: string[] = [];
  for (let i = 0; i < 4; i++) {
    const c = (await claim())!;
    order.push(c.attempt.id);
    await done(app, c.attempt.id);
  }
  expect(order).toEqual([push1, mq, pr1, pr2]);
});

test("yield across projects is unchanged: yield work waits while normal PR work is queued", async () => {
  await putStoredSetting(
    db,
    { kind: "project", id: other.projectId, orgId: other.orgId },
    "scheduling_class",
    "yield",
    "test",
    T0,
  );
  const yieldPush = await queue(other, "push"); // older, protected, but its project yields
  const normalPr = await queue(app, "pull_request");
  const c1 = (await claim())!;
  expect(c1.attempt.id).toBe(normalPr);
  await done(app, c1.attempt.id);
  expect((await claim())!.attempt.id).toBe(yieldPush);
});

test("across orgs the order stays tier-agnostic: another org's older PR is not starved by pushes", async () => {
  const orgB = await createOrg(db, { slug: "beta", name: "beta" });
  const pb = await createProject(db, { orgId: orgB.id }, { slug: "site", name: "site" });
  const b: Required<Scope> = { orgId: orgB.id, projectId: pb.id };
  const bPr = await queue(b, "pull_request"); // oldest overall
  const aPr = await queue(app, "pull_request");
  const aPush1 = await queue(app, "push");
  const aPush2 = await queue(app, "push");
  const order: string[] = [];
  for (let i = 0; i < 4; i++) {
    const c = (await claim())!;
    order.push(c.attempt.id);
    await done(c.scope as Required<Scope>, c.attempt.id);
  }
  // Orgs alternate by the fewest running then oldest waiting; inside org A the pushes go first.
  expect(order[0]).toBe(bPr);
  expect(order.slice(1)).toEqual([aPush1, aPush2, aPr]);
});
