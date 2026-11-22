import { beforeEach, expect, test } from "bun:test";
import {
  createAttempt,
  createJob,
  createRun,
  type Db,
  getJob,
  getRun,
  setRunStatus,
  transitionJob,
  updateAttempt,
} from "../src/db";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { verdict } from "../src/ops/definitions/checks-for-sha";
import { completeLength, leadingPartial } from "../src/ops/utf8";
import { addLog, mintToken, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let token: string;
let env: DispatchEnv;

beforeEach(async () => {
  ({ db, a } = await seedWorld());
  env = { registry, db, now: () => Date.now() };
  token = (await mintToken(db, { orgId: a.orgId }, "operator")).secret;
});

async function run<T = Record<string, any>>(op: string, input: unknown = {}): Promise<T> {
  const res = await dispatch(env, { kind: "bearer", token }, op, input);
  if (!res.ok) throw new Error(`${op}: ${res.error.code} ${res.error.message}`);
  return res.output as T;
}

async function fail(op: string, input: unknown = {}): Promise<string> {
  const res = await dispatch(env, { kind: "bearer", token }, op, input);
  return res.ok ? "ok" : res.error.code;
}

const SHA = (c: string) => c.repeat(40);

async function newRun(
  opts: { sha?: string; ref?: string; event?: string; workflow?: string } = {},
) {
  return createRun(db, a.scope, {
    workflowPath: opts.workflow ?? ".github/workflows/ci.yml",
    event: opts.event ?? "push",
    ref: opts.ref ?? "refs/heads/main",
    ...(opts.sha ? { sha: opts.sha } : {}),
  });
}

test("list_runs: filters, newest first, cursor pages cover everything once", async () => {
  const ids = [a.runId];
  for (let i = 0; i < 6; i++)
    ids.push(
      (
        await newRun({
          ref: i % 2 ? "feature/x" : "main",
          event: i < 3 ? "push" : "pull_request",
          sha: SHA(String(i)),
        })
      ).id,
    );
  const all = await run("list_runs", { limit: 100 });
  expect(all.runs.map((r: { id: string }) => r.id)).toEqual([...ids].toReversed());
  expect(all.next_cursor).toBeNull();
  expect(all.runs[0]).toMatchObject({ project: "app", workflow_path: ".github/workflows/ci.yml" });

  // pagination: pages of 3 cover all 7 exactly once, in order
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await run("list_runs", { limit: 3, ...(cursor ? { cursor } : {}) });
    seen.push(...page.runs.map((r: { id: string }) => r.id));
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  expect(seen).toEqual([...ids].toReversed());

  // filters (branch matches main and refs/heads/main)
  const main = await run("list_runs", { branch: "main" });
  expect(
    main.runs.every((r: { ref: string }) => r.ref === "main" || r.ref === "refs/heads/main"),
  ).toBe(true);
  expect(main.runs.length).toBe(4);
  expect((await run("list_runs", { branch: "feature/x" })).runs).toHaveLength(3);
  expect((await run("list_runs", { event: "pull_request" })).runs).toHaveLength(3);
  expect((await run("list_runs", { sha: SHA("2").toUpperCase() })).runs).toHaveLength(1);
  expect((await run("list_runs", { state: "queued" })).runs).toHaveLength(7);
  expect((await run("list_runs", { state: "success" })).runs).toHaveLength(0);
  expect(
    (await run("list_runs", { since: new Date(Date.now() + 60_000).toISOString() })).runs,
  ).toHaveLength(0);
  expect(
    (await run("list_runs", { since: new Date(Date.now() - 60_000).toISOString() })).runs,
  ).toHaveLength(7);
});

test("get_run: jobs, attempts, durations and the infra_error reason", async () => {
  const j2 = (await createJob(db, a.scope, { runId: a.runId, jobKey: "test", name: "test" }))!;
  const at2 = (await createAttempt(db, a.scope, { jobId: j2.id, provider: "p" }))!;
  await updateAttempt(db, a.scope, at2.id, { state: "running" });
  await updateAttempt(db, a.scope, at2.id, {
    state: "infra_error",
    errorClass: "sandbox_create_failed",
  });
  await transitionJob(db, a.scope, a.jobId, "running");
  await transitionJob(db, a.scope, a.jobId, "success", { exitCode: 0 });
  await transitionJob(db, a.scope, j2.id, "running");
  await transitionJob(db, a.scope, j2.id, "infra_error");

  const r = await run("get_run", { run_id: a.runId });
  expect(r.id).toBe(a.runId);
  expect(r.jobs.map((j: { job_key: string }) => j.job_key)).toEqual(["build", "test"]);
  const build = r.jobs.find((j: { job_key: string }) => j.job_key === "build");
  const testJob = r.jobs.find((j: { job_key: string }) => j.job_key === "test");
  expect(build).toMatchObject({ state: "success", exit_code: 0, infra_error_reason: null });
  expect(build.duration_ms).toBeGreaterThanOrEqual(0);
  expect(build.log_path).toBe(`/api/v1/jobs/${a.jobId}/log`);
  expect(testJob).toMatchObject({
    state: "infra_error",
    infra_error_reason: "sandbox_create_failed",
  });
  expect(testJob.attempts[0]).toMatchObject({
    attempt: 1,
    state: "infra_error",
    error_class: "sandbox_create_failed",
    provider: "p",
  });
  expect(await fail("get_run", { run_id: "01HZZZZZZZZZZZZZZZZZZZZZZZ" })).toBe("not_found");
});

test("job_log: head, tail, range paging, caps and total size", async () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
  await addLog(db, a, `${lines.join("\n")}\n`);
  const total = new TextEncoder().encode(`${lines.join("\n")}\n`).length;

  const tail = await run("job_log", { job_id: a.jobId, lines: 3 });
  expect(tail.text).toBe("line 48\nline 49\nline 50\n");
  expect(tail).toMatchObject({
    mode: "tail",
    total_bytes: total,
    next_offset: null,
    truncated: true,
    attempt: 1,
  });

  const head = await run("job_log", { job_id: a.jobId, mode: "head", lines: 2 });
  expect(head.text).toBe("line 1\nline 2\n");
  expect(head).toMatchObject({ offset: 0, next_offset: head.bytes, truncated: true });

  // byte cap, then paging by next_offset reassembles the log exactly
  let offset = 0;
  let assembled = "";
  for (let guard = 0; guard < 100; guard++) {
    const page = await run("job_log", { job_id: a.jobId, mode: "range", offset, max_bytes: 40 });
    expect(page.bytes).toBeLessThanOrEqual(40);
    assembled += page.text;
    if (page.next_offset === null) break;
    offset = page.next_offset;
  }
  expect(assembled).toBe(`${lines.join("\n")}\n`);

  // tail with a small byte cap never returns half a line
  const capped = await run("job_log", { job_id: a.jobId, lines: 100, max_bytes: 30 });
  expect(capped.text.startsWith("line ")).toBe(true);
  expect(capped.bytes).toBeLessThanOrEqual(30);

  // unknown attempt, unknown job
  expect(await fail("job_log", { job_id: a.jobId, attempt: 9 })).toBe("not_found");
  expect(await fail("job_log", { job_id: "nope" })).toBe("not_found");
});

test("job_log: no attempt or no log yet is empty, not an error", async () => {
  const j = (await createJob(db, a.scope, { runId: a.runId, jobKey: "x", name: "x" }))!;
  const none = await run("job_log", { job_id: j.id });
  expect(none).toMatchObject({ attempt: null, text: "", total_bytes: 0, next_offset: null });
  const empty = await run("job_log", { job_id: a.jobId });
  expect(empty).toMatchObject({ attempt: 1, text: "", total_bytes: 0 });
});

test("job_log: multi-byte characters are never cut, and paging is lossless", async () => {
  const text = `héllo wörld 日本語のログ 😀 end\n`.repeat(8);
  await addLog(db, a, text);
  let offset = 0;
  let assembled = "";
  for (let guard = 0; guard < 400; guard++) {
    const page = await run("job_log", { job_id: a.jobId, mode: "range", offset, max_bytes: 7 });
    expect(page.text).not.toContain("�");
    assembled += page.text;
    if (page.next_offset === null) break;
    expect(page.next_offset).toBeGreaterThan(offset);
    offset = page.next_offset;
  }
  expect(assembled).toBe(text);
  // head and tail with tiny caps stay clean too
  for (const mode of ["head", "tail"] as const) {
    const r = await run("job_log", { job_id: a.jobId, mode, lines: 50, max_bytes: 13 });
    expect(r.text).not.toContain("�");
  }
  // an offset that lands mid-character skips to the next one
  const mid = await run("job_log", { job_id: a.jobId, mode: "range", offset: 2, max_bytes: 8 });
  expect(mid.text).not.toContain("�");
  expect(mid.offset).toBeGreaterThanOrEqual(2);
});

test("utf8 trimming helpers", () => {
  const e = new TextEncoder().encode("日本");
  expect(completeLength(e.subarray(0, 4))).toBe(3);
  expect(completeLength(e.subarray(0, 6))).toBe(6);
  expect(completeLength(e.subarray(0, 1))).toBe(0);
  expect(leadingPartial(e.subarray(1))).toBe(2);
  expect(leadingPartial(e)).toBe(0);
});

test("job_log redacts secrets as defense in depth", async () => {
  const secret = `gh${""}p_${"a1B2".repeat(10)}`;
  await addLog(db, a, `token is ${secret}\nok\n`);
  const r = await run("job_log", { job_id: a.jobId });
  expect(r.text).toBe("token is ***\nok\n");
});

test("checks_for_sha: NONE is not PENDING, and the verdict rules hold", async () => {
  const sha = SHA("c");
  const none = await run("checks_for_sha", { sha });
  expect(none).toMatchObject({ state: "NONE", runs: [] });

  const r1 = await newRun({ sha, workflow: "ci.yml" });
  expect((await run("checks_for_sha", { sha })).state).toBe("PENDING"); // queued is not NONE
  expect((await run("checks_for_sha", { sha })).counts.queued).toBe(1);

  const r2 = await newRun({ sha, workflow: "lint.yml" });
  for (const r of [r1, r2]) {
    const j = (await createJob(db, a.scope, { runId: r.id, jobKey: "j", name: "j" }))!;
    await transitionJob(db, a.scope, j.id, "running");
    await transitionJob(db, a.scope, j.id, "success", { exitCode: 0 });
    await setRunStatus(db, a.scope, r.id, "success");
  }
  expect((await run("checks_for_sha", { sha })).state).toBe("GREEN");

  // a newer failing run of ci.yml wins over the older success
  const r3 = await newRun({ sha, workflow: "ci.yml" });
  await setRunStatus(db, a.scope, r3.id, "failure");
  const red = await run("checks_for_sha", { sha });
  expect(red.state).toBe("RED");
  expect(red.runs).toHaveLength(2);
  expect(red.counts).toMatchObject({ failure: 1, success: 1 });
  // a rerun that succeeds turns it GREEN again
  const r4 = await newRun({ sha, workflow: "ci.yml" });
  await setRunStatus(db, a.scope, r4.id, "success");
  expect((await run("checks_for_sha", { sha })).state).toBe("GREEN");

  expect(verdict([])).toBe("NONE");
  expect(verdict(["success", "running"])).toBe("PENDING");
  expect(verdict(["success", "awaiting_approval"])).toBe("PENDING");
  expect(verdict(["success", "infra_error"])).toBe("RED");
  expect(verdict(["success", "cancelled"])).toBe("RED");
  expect(verdict(["failure", "queued"])).toBe("RED");
  expect(verdict(["success"])).toBe("GREEN");
  expect(verdict(["success", "skipped"])).toBe("GREEN");
  expect(verdict(["skipped"])).toBe("GREEN");
  expect(verdict(["skipped", "running"])).toBe("PENDING");
});

test("checks_for_sha: a short sha is rejected and repo narrows to its project", async () => {
  expect(await fail("checks_for_sha", { sha: "abc1234" })).toBe("invalid_input");
  expect(await fail("checks_for_sha", { sha: SHA("d"), repo: "acme/nope" })).toBe("not_found");
  const { bindRepo } = await import("../src/db");
  await bindRepo(db, a.scope, { forge: "github", owner: "Acme", repo: "Web" });
  expect((await run("checks_for_sha", { sha: SHA("d"), repo: "acme/web" })).state).toBe("NONE");
});

test("cancel: queued and running jobs become cancelled, finished ones are left alone", async () => {
  const j2 = (await createJob(db, a.scope, { runId: a.runId, jobKey: "two", name: "two" }))!;
  const j3 = (await createJob(db, a.scope, { runId: a.runId, jobKey: "three", name: "three" }))!;
  await createAttempt(db, a.scope, { jobId: j2.id, provider: "p" });
  await transitionJob(db, a.scope, a.jobId, "running"); // running, has a queued attempt
  await transitionJob(db, a.scope, j3.id, "running");
  await transitionJob(db, a.scope, j3.id, "success", { exitCode: 0 });

  const out = await run("cancel", { run_id: a.runId });
  expect(out).toMatchObject({ run_id: a.runId, cancelled_jobs: 2, unchanged_jobs: 1 });
  expect((await getJob(db, a.scope, a.jobId))?.state).toBe("cancelled");
  expect((await getJob(db, a.scope, j2.id))?.state).toBe("cancelled");
  expect((await getJob(db, a.scope, j3.id))?.state).toBe("success");
  expect((await getRun(db, a.scope, a.runId))?.status).toBe(out.state);
  const { listAttempts } = await import("../src/db");
  expect((await listAttempts(db, a.scope, a.jobId)).map((x) => x.state)).toEqual(["cancelled"]);
  // idempotent
  expect(await run("cancel", { run_id: a.runId })).toMatchObject({
    cancelled_jobs: 0,
    unchanged_jobs: 3,
  });
  expect(await fail("cancel", { run_id: "nope" })).toBe("not_found");
});

test("create_api_token and cancel are audited writes; reads are not", async () => {
  const { listAudit } = await import("../src/db");
  await run("list_runs");
  await run("cancel", { run_id: a.runId });
  const rows = await listAudit(db, { orgId: a.orgId });
  expect(rows.map((r) => [r.op, r.effect, r.outcome])).toEqual([["cancel", "destructive", "ok"]]);
});
