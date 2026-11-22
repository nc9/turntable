import { beforeEach, expect, test } from "bun:test";
import {
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  type Db,
  getJob,
  InvalidTransitionError,
  openDatabase,
  schema,
  transitionJob,
  updateAttempt,
} from "../src/db";
import { aggregateRunStatus, canTransition, TRANSITIONS } from "../src/db/job-state";

test("transition table covers every state and only references known states", () => {
  expect(Object.keys(TRANSITIONS).toSorted()).toEqual([...schema.JOB_STATES].toSorted());
  for (const targets of Object.values(TRANSITIONS)) {
    for (const t of targets) expect(schema.JOB_STATES).toContain(t);
  }
});

test("terminal states have no exits; infra_error can only retry", () => {
  for (const s of ["success", "failure", "cancelled"] as const) {
    for (const to of schema.JOB_STATES) expect(canTransition(s, to)).toBe(false);
  }
  expect(canTransition("infra_error", "queued")).toBe(true);
  expect(canTransition("infra_error", "success")).toBe(false);
});

test("run status aggregation", () => {
  expect(aggregateRunStatus([])).toBe("queued");
  expect(aggregateRunStatus(["success", "success"])).toBe("success");
  expect(aggregateRunStatus(["success", "failure"])).toBe("failure");
  expect(aggregateRunStatus(["failure", "infra_error"])).toBe("infra_error");
  expect(aggregateRunStatus(["success", "running"])).toBe("running");
  expect(aggregateRunStatus(["success", "queued"])).toBe("running");
  expect(aggregateRunStatus(["queued", "queued"])).toBe("queued");
  expect(aggregateRunStatus(["cancelled", "cancelled"])).toBe("cancelled");
  expect(aggregateRunStatus(["success", "awaiting_approval"])).toBe("awaiting_approval");
});

let db: Db;
let scope: { orgId: string; projectId: string };
let jobId: string;

beforeEach(async () => {
  db = openDatabase(":memory:");
  const org = await createOrg(db, { slug: "o", name: "o" });
  const p = await createProject(db, { orgId: org.id }, { slug: "p", name: "p" });
  scope = { orgId: org.id, projectId: p.id };
  const run = await createRun(db, scope, { workflowPath: "w", event: "push", ref: "main" });
  jobId = (await createJob(db, scope, { runId: run.id, jobKey: "build", name: "build" }))!.id;
});

test("success path stamps timestamps and exit code", async () => {
  const running = (await transitionJob(db, scope, jobId, "running"))!;
  expect(running.startedAt).not.toBeNull();
  const done = (await transitionJob(db, scope, jobId, "success", { exitCode: 0 }))!;
  expect(done).toMatchObject({ state: "success", exitCode: 0 });
  expect(done.finishedAt).not.toBeNull();
});

test("failure needs a non-zero exit; success needs zero; infra_error has none", async () => {
  await transitionJob(db, scope, jobId, "running");
  await expect(transitionJob(db, scope, jobId, "failure", { exitCode: 0 })).rejects.toThrow(
    InvalidTransitionError,
  );
  await expect(transitionJob(db, scope, jobId, "failure")).rejects.toThrow(InvalidTransitionError);
  await expect(transitionJob(db, scope, jobId, "success", { exitCode: 1 })).rejects.toThrow(
    InvalidTransitionError,
  );
  await expect(transitionJob(db, scope, jobId, "infra_error", { exitCode: 2 })).rejects.toThrow(
    InvalidTransitionError,
  );
  expect((await getJob(db, scope, jobId))!.state).toBe("running");
  expect((await transitionJob(db, scope, jobId, "failure", { exitCode: 2 }))!.state).toBe(
    "failure",
  );
});

test("illegal transitions throw and leave state alone", async () => {
  await expect(transitionJob(db, scope, jobId, "success", { exitCode: 0 })).rejects.toThrow(
    InvalidTransitionError,
  );
  await transitionJob(db, scope, jobId, "running");
  await transitionJob(db, scope, jobId, "failure", { exitCode: 1 });
  await expect(transitionJob(db, scope, jobId, "queued")).rejects.toThrow(InvalidTransitionError);
  expect((await getJob(db, scope, jobId))!.state).toBe("failure");
});

test("approval gate and infra_error retry flow", async () => {
  await transitionJob(db, scope, jobId, "awaiting_approval");
  await transitionJob(db, scope, jobId, "queued");
  await transitionJob(db, scope, jobId, "running");
  const infra = (await transitionJob(db, scope, jobId, "infra_error"))!;
  expect(infra.exitCode).toBeNull();
  await transitionJob(db, scope, jobId, "queued");
  await transitionJob(db, scope, jobId, "running");
  expect((await transitionJob(db, scope, jobId, "cancelled"))!.state).toBe("cancelled");
});

test("attempts number per job and follow the same transition rules", async () => {
  const a1 = (await createAttempt(db, scope, { jobId, provider: "local-docker" }))!;
  const a2 = (await createAttempt(db, scope, { jobId, provider: "local-docker" }))!;
  expect([a1.attempt, a2.attempt]).toEqual([1, 2]);
  await updateAttempt(db, scope, a1.id, { state: "running", sandboxId: "sb-1" });
  const failed = (await updateAttempt(db, scope, a1.id, {
    state: "infra_error",
    errorClass: "sandbox_create",
  }))!;
  expect(failed).toMatchObject({
    state: "infra_error",
    errorClass: "sandbox_create",
    sandboxId: "sb-1",
  });
  await expect(updateAttempt(db, scope, a1.id, { state: "success", exitCode: 0 })).rejects.toThrow(
    InvalidTransitionError,
  );
});

test("db rejects an unknown state via CHECK", async () => {
  await expect(
    Promise.resolve(db.orm.update(schema.jobs).set({ state: "bogus" })),
  ).rejects.toThrow();
});
