import { beforeEach, expect, test } from "bun:test";
import {
  addCut,
  addNotice,
  appendLog,
  listNotices,
  MAX_NOTICES_PER_ATTEMPT,
  appendEvent,
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  type Db,
  listCuts,
  listEvents,
  listSteps,
  latestEventId,
  onEventsAppended,
  openDatabase,
  setRunStatus,
  transitionJob,
  updateAttempt,
  upsertStep,
  type Scope,
} from "../src/db";
import { aggregateRunStatus, canTransition, TERMINAL_STATES } from "../src/db/job-state";

let db: Db;
type T = { scope: Required<Scope>; runId: string; jobId: string; attemptId: string };
let a: T;
let b: T;
let a2: T; // second project in org A

async function seed(slug: string, projectSlug = "app", orgId?: string): Promise<T> {
  const org = orgId ? { id: orgId } : await createOrg(db, { slug, name: slug });
  const project = await createProject(
    db,
    { orgId: org.id },
    { slug: projectSlug, name: projectSlug },
  );
  const scope = { orgId: org.id, projectId: project.id };
  const run = await createRun(db, scope, { workflowPath: "w.yml", event: "push", ref: "main" });
  const job = (await createJob(db, scope, { runId: run.id, jobKey: "j", name: "j" }))!;
  const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "p" }))!;
  return { scope, runId: run.id, jobId: job.id, attemptId: attempt.id };
}

beforeEach(async () => {
  db = openDatabase(":memory:");
  a = await seed("org-a");
  b = await seed("org-b");
  a2 = await seed("unused", "other", a.scope.orgId);
});

const types = async (scope: Scope) =>
  (await listEvents(db, scope, { after: 0, limit: 500 })).map((e) => e.type);

test("state changes emit events in order, in the same transaction", async () => {
  expect(await types(a.scope)).toEqual(["run.queued"]);
  await transitionJob(db, a.scope, a.jobId, "running");
  await updateAttempt(db, a.scope, a.attemptId, { state: "running" });
  await setRunStatus(db, a.scope, a.runId, "running");
  await updateAttempt(db, a.scope, a.attemptId, { state: "success", exitCode: 0 });
  await transitionJob(db, a.scope, a.jobId, "success", { exitCode: 0 });
  await setRunStatus(db, a.scope, a.runId, "success");
  expect(await types(a.scope)).toEqual([
    "run.queued",
    "job.state_changed",
    "job.state_changed",
    "run.started",
    "job.state_changed",
    "job.state_changed",
    "run.finished",
  ]);
  const events = await listEvents(db, a.scope, { after: 0, limit: 100 });
  expect(events.map((e) => e.id)).toEqual(events.map((e) => e.id).toSorted((x, y) => x - y));
  expect(new Set(events.map((e) => e.publicId)).size).toBe(events.length);
  const job = events.find((e) => e.type === "job.state_changed" && e.attemptId === null)!;
  expect(JSON.parse(job.payload)).toMatchObject({ from: "queued", to: "running" });
  expect(job).toMatchObject({ runId: a.runId, jobId: a.jobId, projectId: a.scope.projectId });
  const finished = events.find((e) => e.type === "run.finished")!;
  expect(JSON.parse(finished.payload)).toEqual({ status: "success", from: "running" });
  // an unchanged run status is not a new event
  await setRunStatus(db, a.scope, a.runId, "success");
  expect((await types(a.scope)).filter((t) => t === "run.finished")).toHaveLength(1);
});

test("infra_error and approval gates emit their own events", async () => {
  await transitionJob(db, a.scope, a.jobId, "running");
  await updateAttempt(db, a.scope, a.attemptId, { state: "running" });
  await updateAttempt(db, a.scope, a.attemptId, {
    state: "infra_error",
    errorClass: "sandbox_lost",
  });
  await transitionJob(db, a.scope, a.jobId, "infra_error");
  const t = await types(a.scope);
  expect(t.filter((x) => x === "infra.error")).toHaveLength(2); // attempt and job
  const infra = (
    await listEvents(db, a.scope, { after: 0, limit: 100, types: ["infra.error"] })
  )[0]!;
  expect(JSON.parse(infra.payload)).toEqual({ error_class: "sandbox_lost" });

  const j2 = (await createJob(db, a.scope, { runId: a.runId, jobKey: "gate", name: "gate" }))!;
  await transitionJob(db, a.scope, j2.id, "awaiting_approval");
  expect(await types(a.scope)).toContain("approval.required");
});

test("a rolled-back or failed change leaves no event and does not wake the feed", async () => {
  const woken: string[] = [];
  const off = onEventsAppended((orgId) => woken.push(orgId));
  const before = await latestEventId(db, a.scope);

  await expect(
    db.transaction(async (tx) => {
      await transitionJob(tx, a.scope, a.jobId, "running");
      await setRunStatus(tx, a.scope, a.runId, "running");
      expect((await listEvents(tx, a.scope, { after: before, limit: 10 })).length).toBe(2);
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect(await latestEventId(db, a.scope)).toBe(before);
  expect(
    (await db.orm.select().from((await import("../src/db")).schema.jobs)).find(
      (j) => j.id === a.jobId,
    )?.state,
  ).toBe("queued");
  expect(woken).toEqual([]);

  // an invalid transition throws before any event
  await expect(transitionJob(db, a.scope, a.jobId, "success", { exitCode: 0 })).rejects.toThrow();
  expect(await latestEventId(db, a.scope)).toBe(before);

  // a rolled-back savepoint keeps its events out, the outer work stays
  await db.transaction(async (tx) => {
    await transitionJob(tx, a.scope, a.jobId, "running");
    await expect(
      tx.transaction(async (inner) => {
        await upsertStep(inner, a.scope, {
          attemptId: a.attemptId,
          stepKey: "s",
          stage: "main",
          index: 0,
          name: "n",
        });
        throw new Error("inner");
      }),
    ).rejects.toThrow("inner");
  });
  expect(await types(a.scope)).toEqual(["run.queued", "job.state_changed"]);
  expect(woken).toEqual([a.scope.orgId]); // once, after the commit

  // and a committed change wakes it after commit, when the row is visible
  let seenAtWake = 0;
  const off2 = onEventsAppended(
    () => void latestEventId(db, a.scope).then((n) => (seenAtWake = n)),
  );
  await setRunStatus(db, a.scope, a.runId, "running");
  await Bun.sleep(10);
  expect(seenAtWake).toBe(await latestEventId(db, a.scope));
  off();
  off2();
});

test("listEvents pages by cursor, filters by type, and is tenant and project scoped", async () => {
  await transitionJob(db, a.scope, a.jobId, "running");
  await transitionJob(db, a2.scope, a2.jobId, "running");
  await transitionJob(db, b.scope, b.jobId, "running");

  const all = await listEvents(db, { orgId: a.scope.orgId }, { after: 0, limit: 100 });
  // org-wide sees both projects of org A, never org B
  expect(all.map((e) => e.projectId)).toEqual([
    a.scope.projectId,
    a2.scope.projectId,
    a.scope.projectId,
    a2.scope.projectId,
  ]);
  expect(all.every((e) => e.orgId === a.scope.orgId)).toBe(true);
  expect(all.length).toBe(4);
  // project-narrowed scope sees only that project
  const onlyA = await listEvents(db, a.scope, { after: 0, limit: 100 });
  expect(onlyA.every((e) => e.projectId === a.scope.projectId)).toBe(true);
  expect(onlyA).toHaveLength(2);
  // org B sees only its own, and org-level scope cannot be widened by id
  const bAll = await listEvents(db, { orgId: b.scope.orgId }, { after: 0, limit: 100 });
  expect(bAll.every((e) => e.orgId === b.scope.orgId)).toBe(true);
  expect(
    await listEvents(
      db,
      { orgId: b.scope.orgId, projectId: a.scope.projectId },
      { after: 0, limit: 100 },
    ),
  ).toEqual([]);

  // paging walks everything exactly once
  const seen: number[] = [];
  let after = 0;
  for (;;) {
    const page = await listEvents(db, { orgId: a.scope.orgId }, { after, limit: 3 });
    if (page.length === 0) break;
    seen.push(...page.map((e) => e.id));
    after = page.at(-1)!.id;
  }
  expect(seen).toEqual(all.map((e) => e.id));
  expect(
    await listEvents(db, a.scope, { after: 0, limit: 100, types: ["run.queued"] }),
  ).toHaveLength(1);
  expect(await listEvents(db, a.scope, { after: 0, limit: 100, types: [] })).toHaveLength(2);
  expect(await latestEventId(db, { orgId: a.scope.orgId })).toBe(all.at(-1)!.id);
  expect(await latestEventId(db, { orgId: "nobody" })).toBe(0);
});

test("steps: upsert is idempotent per (attempt, step, stage), isolated by tenant and project", async () => {
  const step = {
    attemptId: a.attemptId,
    stepKey: "checkout",
    stage: "main" as const,
    index: 1,
    name: "Checkout",
  };
  const first = await upsertStep(db, a.scope, { ...step, startedAt: 10, logOffset: 5 });
  expect(first).toMatchObject({ stepKey: "checkout", result: null, logOffset: 5 });
  const done = await upsertStep(db, a.scope, {
    ...step,
    result: "success",
    startedAt: 10,
    finishedAt: 20,
    logOffset: 5,
  });
  expect(done).toMatchObject({ result: "success", finishedAt: 20 });
  await upsertStep(db, a.scope, { ...step, stage: "pre", index: 0, name: "Set up" });
  await upsertStep(db, a.scope, { ...step, stage: "post", index: 9, name: "Post" });
  const steps = await listSteps(db, a.scope, a.attemptId);
  expect(steps.map((s) => [s.stage, s.stepIndex])).toEqual([
    ["pre", 0],
    ["main", 1],
    ["post", 9],
  ]);
  expect((await types(a.scope)).filter((t) => t === "attempt.step")).toHaveLength(4);

  // another tenant or project cannot write or read them
  expect(await upsertStep(db, b.scope, step)).toBeUndefined();
  expect(await upsertStep(db, a2.scope, step)).toBeUndefined();
  expect(await listSteps(db, b.scope, a.attemptId)).toEqual([]);
  expect(await listSteps(db, a2.scope, a.attemptId)).toEqual([]);
  expect(await listSteps(db, { orgId: b.scope.orgId }, a.attemptId)).toEqual([]);
  expect((await listSteps(db, { orgId: a.scope.orgId }, a.attemptId)).length).toBe(3);
  // bad stage or result is refused by the schema
  await expect(
    upsertStep(db, a.scope, { ...step, stepKey: "x", stage: "bogus" as never }),
  ).rejects.toThrow();
  await expect(
    upsertStep(db, a.scope, { ...step, stepKey: "y", result: "weird" as never }),
  ).rejects.toThrow();
});

test("cuts: idempotent per offset, isolated by tenant and project, emit an event", async () => {
  const cut = { attemptId: a.attemptId, atOffset: 1000, omittedBytes: 4096, reason: "head-cap" };
  expect(await addCut(db, a.scope, cut)).toBe(true);
  expect(await addCut(db, a.scope, cut)).toBe(true); // idempotent
  await addCut(db, a.scope, { ...cut, atOffset: 500, reason: "tail-cap" });
  expect(
    (await listCuts(db, a.scope, a.attemptId)).map((c) => [c.atOffset, c.omittedBytes, c.reason]),
  ).toEqual([
    [500, 4096, "tail-cap"],
    [1000, 4096, "head-cap"],
  ]);
  expect((await types(a.scope)).filter((t) => t === "attempt.cut")).toHaveLength(3);

  expect(await addCut(db, b.scope, cut)).toBe(false);
  expect(await addCut(db, a2.scope, cut)).toBe(false);
  expect(await listCuts(db, b.scope, a.attemptId)).toEqual([]);
  expect(await listCuts(db, a2.scope, a.attemptId)).toEqual([]);
  expect(await types(b.scope)).not.toContain("attempt.cut");
});

test("appendEvent writes tenant columns from the scope and rejects unknown types", async () => {
  const id = await appendEvent(db, a.scope, {
    type: "run.queued",
    runId: a.runId,
    payload: { x: 1 },
  });
  const row = (await listEvents(db, a.scope, { after: id - 1, limit: 1 }))[0]!;
  expect(row).toMatchObject({
    id,
    orgId: a.scope.orgId,
    projectId: a.scope.projectId,
    type: "run.queued",
  });
  await expect(appendEvent(db, a.scope, { type: "bogus" as never })).rejects.toThrow();
  // org-level event (no project)
  const orgLevel = await appendEvent(db, { orgId: a.scope.orgId }, { type: "infra.error" });
  expect(await listEvents(db, a.scope, { after: orgLevel - 1, limit: 5 })).toEqual([]); // project scope excludes it
  expect(
    await listEvents(db, { orgId: a.scope.orgId }, { after: orgLevel - 1, limit: 5 }),
  ).toHaveLength(1);
});

test("skipped is a terminal state reachable from queued and running, with no exit code", async () => {
  expect(canTransition("queued", "skipped")).toBe(true);
  expect(canTransition("running", "skipped")).toBe(true);
  expect(canTransition("awaiting_approval", "skipped")).toBe(false);
  expect(TERMINAL_STATES).toContain("skipped");
  for (const to of ["queued", "running", "success", "failure", "cancelled", "skipped"] as const) {
    expect(canTransition("skipped", to)).toBe(false);
  }
  const j = await transitionJob(db, a.scope, a.jobId, "skipped");
  expect(j).toMatchObject({ state: "skipped", exitCode: null });
  expect(j!.finishedAt).not.toBeNull();
  const j2 = (await createJob(db, a.scope, { runId: a.runId, jobKey: "r", name: "r" }))!;
  await transitionJob(db, a.scope, j2.id, "running");
  expect((await transitionJob(db, a.scope, j2.id, "skipped"))?.state).toBe("skipped");
  await expect(transitionJob(db, a.scope, j2.id, "running")).rejects.toThrow();
  // runs and attempts accept the state too
  const run = await setRunStatus(db, a.scope, a.runId, "skipped");
  expect(run).toMatchObject({ status: "skipped" });
  expect(run!.finishedAt).not.toBeNull();
  expect((await updateAttempt(db, a.scope, a.attemptId, { state: "skipped" }))?.state).toBe(
    "skipped",
  );
});

test("a skipped job is neutral in the run aggregate", () => {
  expect(aggregateRunStatus(["skipped", "skipped"])).toBe("skipped");
  expect(aggregateRunStatus(["success", "skipped"])).toBe("success");
  expect(aggregateRunStatus(["failure", "skipped"])).toBe("failure");
  expect(aggregateRunStatus(["running", "skipped"])).toBe("running");
  expect(aggregateRunStatus(["cancelled", "skipped"])).toBe("cancelled");
  expect(aggregateRunStatus([])).toBe("queued");
});

test("notices: out-of-band, offset-anchored, sanitised, capped, tenant-isolated", async () => {
  const n = (text: string) => ({ attemptId: a.attemptId, source: "cache", text });
  expect(await addNotice(db, a.scope, n("cache: 2 entries dropped (denied paths)"))).toBe(true);
  await appendLog(db, a.scope, a.attemptId, 0, new TextEncoder().encode("hello\n"));
  expect(await addNotice(db, a.scope, n("later\u001b[31m\nforged"))).toBe(true);
  const rows = await listNotices(db, a.scope, a.attemptId);
  expect(rows.map((r) => [r.atOffset, r.source])).toEqual([
    [0, "cache"],
    [6, "cache"],
  ]);
  expect([...rows[1]!.text].every((c) => c.charCodeAt(0) >= 32)).toBe(true);
  expect(await addNotice(db, a.scope, n("x".repeat(1000)))).toBe(true);
  expect(
    Math.max(...(await listNotices(db, a.scope, a.attemptId)).map((r) => r.text.length)),
  ).toBeLessThanOrEqual(300);
  expect(await addNotice(db, b.scope, n("cross"))).toBe(false);
  expect(await addNotice(db, a2.scope, n("cross"))).toBe(false);
  expect(await listNotices(db, b.scope, a.attemptId)).toEqual([]);
  for (let i = 0; i < MAX_NOTICES_PER_ATTEMPT + 5; i++) await addNotice(db, a.scope, n(`n${i}`));
  expect((await listNotices(db, a.scope, a.attemptId)).length).toBe(MAX_NOTICES_PER_ATTEMPT);
  expect(await addNotice(db, a.scope, n("over"))).toBe(false);
});
