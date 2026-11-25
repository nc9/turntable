// The deploy gate (#561): one public bit, the same for every caller, that says whether release
// work is in flight or a drain is on. Every release state makes it unsafe, a non-release run does
// not, the body never carries a name or an id, and the route is rate limited per client.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  claimNextReleaseRequest,
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createReleaseRequest,
  createRun,
  type Db,
  finishReleaseRequest,
  insertRecord,
  openDatabase,
  setProjectSigning,
  setRunStatus,
  spendApprovalRecords,
  transitionJob,
} from "../src/db";
import { createDeployGate, DEPLOY_GATE_PATH } from "../src/deploy-gate";
import { resetProcessDrain, processDrain } from "../src/scheduler";

const MARKER = "zq7marker9x";
const T0 = 1_800_000_000_000;
let db: Db;
let scope: { orgId: string; projectId: string };
let clock = T0;

beforeEach(async () => {
  db = openDatabase(":memory:");
  const org = await createOrg(db, { slug: `org-${MARKER}`, name: `Org ${MARKER}` });
  const project = await createProject(
    db,
    { orgId: org.id },
    { slug: `proj-${MARKER}`, name: `Project ${MARKER}` },
  );
  scope = { orgId: org.id, projectId: project.id };
  clock = T0;
  resetProcessDrain();
});
afterEach(() => resetProcessDrain());

// A gate with no cache, so each call reads the database.
const mk = (o: { maxPerWindow?: number; cacheMs?: number } = {}) =>
  createDeployGate({ db, now: () => clock, cacheMs: 0, ...o });
const call = async (gate: ReturnType<typeof mk>, peer = "10.0.0.1", method = "GET") => {
  const res = await gate.handle(new Request(`http://x${DEPLOY_GATE_PATH}`, { method }), peer);
  return { res: res!, text: await res!.text() };
};
const verdict = async (gate = mk()) => JSON.parse((await call(gate)).text) as unknown;
const SAFE = { safe: true, reason: "ok" };
const BUSY = { safe: false, reason: "release_in_flight" };

const trust = (klass: string) => JSON.stringify({ class: klass });
async function run(klass: string, status: "queued" | "running" | "awaiting_approval" | "success") {
  const r = await createRun(db, scope, {
    workflowPath: `${MARKER}.yml`,
    event: "push",
    ref: `refs/tags/${MARKER}`,
    workflowName: MARKER,
    trust: trust(klass),
  });
  if (status !== "queued") await setRunStatus(db, scope, r.id, status);
  return r;
}

describe("the deploy gate", () => {
  test("an idle instance is safe", async () => {
    expect(await verdict()).toEqual(SAFE);
  });

  test("a release run queued, running or awaiting approval is unsafe; a finished one is not", async () => {
    for (const status of ["queued", "running", "awaiting_approval"] as const) {
      const r = await run("release", status);
      expect(await verdict()).toEqual(BUSY);
      await setRunStatus(db, scope, r.id, "success");
      expect(await verdict()).toEqual(SAFE);
    }
  });

  test("a non-release run does not hold a deploy", async () => {
    for (const klass of ["protected", "trusted_pr", "untrusted_pr"]) {
      await run(klass, "running");
      await run(klass, "queued");
    }
    expect(await verdict()).toEqual(SAFE);
  });

  test("a job waiting in the signing environment is unsafe (default and set environment)", async () => {
    const r = await run("trusted_pr", "awaiting_approval");
    const job = (await createJob(db, scope, {
      runId: r.id,
      jobKey: "sign",
      name: "sign",
      approvalKind: "environment",
      planned: { environment: "release" },
    }))!;
    await transitionJob(db, scope, job.id, "awaiting_approval");
    expect(await verdict()).toEqual(BUSY);
    // The project names another signing environment: "release" no longer matches it.
    await setProjectSigning(db, scope, { environment: "ship" });
    expect(await verdict()).toEqual(SAFE);
  });

  test("a release request is unsafe while pending and while claimed (the lane publishes), then safe", async () => {
    const r = await run("release", "success");
    const req = await createReleaseRequest(db, scope, {
      runId: r.id,
      tag: "v1.0.0",
      artifacts: ["a"],
      requestedBy: "test:1",
    });
    expect(await verdict()).toEqual(BUSY);
    const claimed = await claimNextReleaseRequest(db, "lane-1", T0);
    expect(claimed?.id).toBe(req.id);
    expect(await verdict()).toEqual(BUSY);
    await finishReleaseRequest(db, req.id, "lane-1", { status: "signed", result: {} }, T0 + 1);
    expect(await verdict()).toEqual(SAFE);
  });

  test("an unspent, unexpired signing-environment approval (a co-sign) is unsafe until spent or expired", async () => {
    const r = await run("release", "success");
    const base = {
      projectId: scope.projectId,
      kind: "environment" as const,
      runId: r.id,
      environment: "release",
      statement: "{}",
      method: "ed25519",
      approverId: "ap1",
      person: "p1",
      signature: "{}",
    };
    await insertRecord(
      db,
      scope.orgId,
      { ...base, statementHash: "h1", expiresAt: clock + 60_000 },
      clock,
    );
    expect(await verdict()).toEqual(BUSY);
    clock += 120_000;
    expect(await verdict()).toEqual(SAFE);
    await insertRecord(
      db,
      scope.orgId,
      { ...base, statementHash: "h2", expiresAt: clock + 60_000 },
      clock,
    );
    expect(await verdict()).toEqual(BUSY);
    const rows = await db.run((h) =>
      h.orm.select().from(require("../src/db/schema").approvalRecords),
    );
    const live = (rows as { id: string; statementHash: string }[]).find(
      (x) => x.statementHash === "h2",
    )!;
    expect(await spendApprovalRecords(db, scope.orgId, [live.id], clock)).toBe(true);
    expect(await verdict()).toEqual(SAFE);
  });

  test("an approval for another environment is not a co-sign", async () => {
    await insertRecord(
      db,
      scope.orgId,
      {
        projectId: scope.projectId,
        kind: "environment",
        environment: "staging",
        statementHash: "h3",
        statement: "{}",
        method: "ed25519",
        approverId: "ap1",
        person: "p1",
        signature: "{}",
        expiresAt: clock + 60_000,
      },
      clock,
    );
    expect(await verdict()).toEqual(SAFE);
  });

  test("a drain reports draining; a release in flight wins", async () => {
    processDrain.set(true, "test", T0);
    expect(await verdict()).toEqual({ safe: false, reason: "draining" });
    await run("release", "running");
    expect(await verdict()).toEqual(BUSY);
  });

  test("the body and headers never carry an id or a name", async () => {
    const r = await run("release", "running");
    const job = (await createJob(db, scope, { runId: r.id, jobKey: MARKER, name: MARKER }))!;
    await createAttempt(db, scope, { jobId: job.id, provider: "fake" });
    await createReleaseRequest(db, scope, {
      runId: r.id,
      tag: `v-${MARKER}`,
      artifacts: [MARKER],
      requestedBy: "test:1",
    });
    const { res, text } = await call(mk());
    expect(JSON.parse(text)).toEqual(BUSY);
    expect(Object.keys(JSON.parse(text))).toEqual(["safe", "reason"]);
    const everything = text + JSON.stringify([...res.headers.entries()]);
    for (const needle of [MARKER, scope.orgId, scope.projectId, r.id, job.id]) {
      expect(everything).not.toContain(needle);
    }
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("the answer is reused for at most 15 s", async () => {
    const gate = createDeployGate({ db, now: () => clock, cacheMs: 60_000 });
    expect(await verdict(gate)).toEqual(SAFE);
    const r = await run("release", "running");
    expect(await verdict(gate)).toEqual(SAFE); // cached
    clock += 14_000;
    expect(await verdict(gate)).toEqual(SAFE);
    clock += 2_000; // 16 s: the ceiling beats the 60 s asked for
    expect(await verdict(gate)).toEqual(BUSY);
    await setRunStatus(db, scope, r.id, "success");
  });

  test("a client over the limit gets 429, another client does not, and the window resets", async () => {
    const gate = mk({ maxPerWindow: 3 });
    for (let i = 0; i < 3; i++) expect((await call(gate, "10.0.0.1")).res.status).toBe(200);
    const limited = await call(gate, "10.0.0.1");
    expect(limited.res.status).toBe(429);
    expect(limited.res.headers.get("cache-control")).toBe("no-store");
    expect((await call(gate, "10.0.0.2")).res.status).toBe(200);
    clock += 61_000;
    expect((await call(gate, "10.0.0.1")).res.status).toBe(200);
  });

  test("other paths fall through and other methods are refused", async () => {
    const gate = mk();
    expect(await gate.handle(new Request("http://x/api/v1/other"), "10.0.0.1")).toBeUndefined();
    expect((await call(gate, "10.0.0.1", "POST")).res.status).toBe(405);
  });
});
