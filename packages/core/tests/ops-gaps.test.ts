import { beforeEach, expect, test } from "bun:test";
import {
  bindRepo,
  createAttempt,
  createJob,
  createProject,
  createRun,
  type Db,
  getJob,
  getRun,
  listAttempts,
  listAudit,
  listEvents,
  resolveDependents,
  setRunStatus,
  transitionJob,
  updateAttempt,
} from "../src/db";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { waiterLimits, waitingCount } from "../src/ops/definitions/events";
import { mintToken, seedTenant, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let env: DispatchEnv;
let reader: string;
let operator: string;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  env = { registry, db };
  reader = (await mintToken(db, { orgId: a.orgId }, "reader")).secret;
  operator = (await mintToken(db, { orgId: a.orgId }, "operator")).secret;
});

async function call(tok: string, op: string, input: unknown = {}) {
  return dispatch(env, { kind: "bearer", token: tok }, op, input);
}
async function run<T = any>(tok: string, op: string, input: unknown = {}): Promise<T> {
  const res = await call(tok, op, input);
  if (!res.ok) throw new Error(`${op}: ${res.error.code} ${res.error.message}`);
  return res.output as T;
}

test("whoami: token, pinned token and person", async () => {
  const me = await run(reader, "whoami");
  expect(me).toMatchObject({
    kind: "token",
    name: "test-reader",
    role: "reader",
    org: "org-a",
    project: null,
  });
  expect(me.expires_at).toBeNull();

  const pinned = await mintToken(db, a.scope, "operator", {
    name: "pinned",
    expiresAt: 1_900_000_000_000,
  });
  expect(await run(pinned.secret, "whoami")).toMatchObject({
    name: "pinned",
    role: "operator",
    project: "app",
    expires_at: new Date(1_900_000_000_000).toISOString(),
  });

  const person = await dispatch(env, { kind: "principal", principal: a.admin }, "whoami", {});
  expect(person.ok && person.output).toMatchObject({
    kind: "member",
    name: null,
    role: "admin",
    org: "org-a",
    project: null,
  });
  // it never reveals another org: naming one is the usual not_found
  const cross = await call(reader, "whoami", { org: b.slug });
  expect(!cross.ok && cross.error.code).toBe("not_found");
});

test("list_orgs returns only the principal's org", async () => {
  const out = await run(reader, "list_orgs");
  expect(out.orgs).toEqual([{ id: a.orgId, slug: "org-a", name: "org-a" }]);
  expect(out.next_cursor).toBeNull();
  const bTok = (await mintToken(db, { orgId: b.orgId }, "reader")).secret;
  expect((await run(bTok, "list_orgs")).orgs.map((o: { slug: string }) => o.slug)).toEqual([
    "org-b",
  ]);
});

test("list_projects: bound repos, paging, project-scoped narrowing, tenant isolation", async () => {
  await bindRepo(db, a.scope, { forge: "github", owner: "Acme", repo: "Web" });
  await bindRepo(db, a.scope, { forge: "github", owner: "acme", repo: "api" });
  const second = await createProject(db, { orgId: a.orgId }, { slug: "second", name: "Second" });
  const third = await createProject(db, { orgId: a.orgId }, { slug: "third", name: "Third" });
  await bindRepo(
    db,
    { orgId: a.orgId, projectId: second.id },
    { forge: "github", owner: "acme", repo: "docs" },
  );

  const all = await run(reader, "list_projects");
  expect(all.projects.map((p: { slug: string }) => p.slug)).toEqual(["app", "second", "third"]);
  expect(all.projects[0].repos).toEqual([
    { forge: "github", owner: "acme", repo: "api" },
    { forge: "github", owner: "acme", repo: "web" },
  ]);
  expect(all.projects[1].repos).toEqual([{ forge: "github", owner: "acme", repo: "docs" }]);
  expect(all.projects[2].repos).toEqual([]);

  const first = await run(reader, "list_projects", { limit: 2 });
  expect(first.projects).toHaveLength(2);
  const rest = await run(reader, "list_projects", { limit: 2, cursor: first.next_cursor });
  expect(rest.projects.map((p: { id: string }) => p.id)).toEqual([third.id]);
  expect(rest.next_cursor).toBeNull();

  const pinned = (await mintToken(db, a.scope, "reader")).secret;
  expect(
    (await run(pinned, "list_projects")).projects.map((p: { slug: string }) => p.slug),
  ).toEqual(["app"]);
  const bTok = (await mintToken(db, { orgId: b.orgId }, "reader")).secret;
  expect((await run(bTok, "list_projects")).projects.map((p: { slug: string }) => p.slug)).toEqual([
    "app",
  ]);
  expect(JSON.stringify(await run(bTok, "list_projects"))).not.toContain("acme");
  const bad = await call(reader, "list_projects", { cursor: "garbage" });
  expect(!bad.ok && bad.error.code).toBe("invalid_input");
});

test("run and job metadata are stored, capped and returned by list_runs and get_run", async () => {
  const r = await createRun(db, a.scope, {
    workflowPath: ".github/workflows/ci.yml",
    event: "pull_request",
    ref: "refs/pull/7/merge",
    sha: "b".repeat(40),
    workflowName: "CI",
    commitMessage: `fix: thing\n\n${"x".repeat(5000)}`,
    actor: "octocat",
    headBranch: "feature/x",
    prNumber: 7,
  });
  const job = (await createJob(db, a.scope, {
    runId: r.id,
    jobKey: "test",
    name: "test (node 22)",
    needs: ["build", "lint"],
    matrix: { node: 22, os: "linux" },
    approvalKind: "untrusted_author",
  }))!;
  expect(r.commitMessage!.length).toBe(2000);

  const got = await run(reader, "get_run", { run_id: r.id });
  expect(got).toMatchObject({
    workflow_name: "CI",
    actor: "octocat",
    head_branch: "feature/x",
    pr_number: 7,
  });
  expect(got.commit_message.startsWith("fix: thing")).toBe(true);
  expect(got.jobs[0]).toMatchObject({
    id: job.id,
    needs: ["build", "lint"],
    matrix: { node: 22, os: "linux" },
    approval_kind: "untrusted_author",
  });
  const listed = (await run(reader, "list_runs", { sha: "b".repeat(40) })).runs[0];
  expect(listed).toMatchObject({ workflow_name: "CI", pr_number: 7, head_branch: "feature/x" });

  // defaults: no metadata, no needs, no matrix, no approval
  const plain = await run(reader, "get_run", { run_id: a.runId });
  expect(plain).toMatchObject({
    workflow_name: null,
    commit_message: null,
    actor: null,
    head_branch: null,
    pr_number: null,
  });
  expect(plain.jobs[0]).toMatchObject({ needs: [], matrix: null, approval_kind: null });
  // the schema refuses an unknown approval kind
  await expect(
    createJob(db, a.scope, { runId: r.id, jobKey: "z", name: "z", approvalKind: "bogus" as never }),
  ).rejects.toThrow();
});

async function finishRun(
  t: Tenant,
  jobs: { key: string; state: "success" | "failure" | "infra_error" }[],
  sha = "c".repeat(40),
) {
  const r = await createRun(db, t.scope, {
    workflowPath: "w.yml",
    event: "push",
    ref: "main",
    sha,
  });
  const ids: Record<string, string> = {};
  for (const j of jobs) {
    const job = (await createJob(db, t.scope, { runId: r.id, jobKey: j.key, name: j.key }))!;
    ids[j.key] = job.id;
    const at = (await createAttempt(db, t.scope, { jobId: job.id, provider: "docker" }))!;
    await transitionJob(db, t.scope, job.id, "running");
    await updateAttempt(db, t.scope, at.id, { state: "running" });
    if (j.state === "infra_error") {
      await updateAttempt(db, t.scope, at.id, { state: "infra_error", errorClass: "lost" });
      await transitionJob(db, t.scope, job.id, "infra_error");
    } else {
      const code = j.state === "success" ? 0 : 1;
      await updateAttempt(db, t.scope, at.id, { state: j.state, exitCode: code });
      await transitionJob(db, t.scope, job.id, j.state, { exitCode: code });
    }
  }
  await setRunStatus(
    db,
    t.scope,
    r.id,
    jobs.some((j) => j.state !== "success") ? "failure" : "success",
  );
  return { run: r, ids };
}

test("rerun: failed jobs get a queued attempt, the run reopens, the reason is kept and audited", async () => {
  const { run: r, ids } = await finishRun(a, [
    { key: "build", state: "success" },
    { key: "test", state: "failure" },
    { key: "deploy", state: "infra_error" },
  ]);
  const out = await run(operator, "rerun", { run_id: r.id, reason: "flaky network" });
  expect(out.run_id).toBe(r.id);
  expect(out.state).toBe("running"); // some jobs finished, others queued
  expect(out.reruns.map((x: { job_key: string }) => x.job_key).toSorted()).toEqual([
    "deploy",
    "test",
  ]);
  expect(out.reruns.find((x: { job_key: string }) => x.job_key === "test")).toMatchObject({
    attempt: 2,
    previous_state: "failure",
    reruns_used: 1,
  });

  expect((await getJob(db, a.scope, ids.test!))?.state).toBe("queued");
  expect((await getJob(db, a.scope, ids.test!))?.exitCode).toBeNull();
  expect((await getJob(db, a.scope, ids.build!))?.state).toBe("success"); // untouched
  const attempts = await listAttempts(db, a.scope, ids.test!);
  expect(attempts.map((x) => [x.attempt, x.state, x.rerunReason])).toEqual([
    [1, "failure", null],
    [2, "queued", "flaky network"],
  ]);
  const reopened = await getRun(db, a.scope, r.id);
  expect(reopened).toMatchObject({ status: "running", finishedAt: null });

  const events = await listEvents(db, a.scope, { after: 0, limit: 500 });
  const rerunEvents = events.filter((e) => e.payload.includes('"rerun":true'));
  expect(rerunEvents.map((e) => e.type).toSorted()).toEqual([
    "job.state_changed",
    "job.state_changed",
    "run.queued",
  ]);
  const audit = await listAudit(db, { orgId: a.orgId });
  const row = audit.find((x) => x.op === "rerun")!;
  expect(row).toMatchObject({ effect: "write", outcome: "ok", principalKind: "token" });
  expect(row.input).toContain("flaky network");
});

test("cancel: reason is optional, audited, capped at 500 and blank counts as absent", async () => {
  const r = (await finishRun(a, [{ key: "build", state: "success" }])).run;
  expect((await call(operator, "cancel", { run_id: r.id })).ok).toBe(true);
  const r2 = (await finishRun(a, [{ key: "build", state: "success" }])).run;
  await run(operator, "cancel", { run_id: r2.id, reason: "  superseded by newer push  " });
  const audit = await listAudit(db, { orgId: a.orgId });
  const rows = audit.filter((x) => x.op === "cancel" && x.outcome === "ok");
  expect(rows.some((x) => JSON.parse(x.input).reason === "superseded by newer push")).toBe(true);
  const r3 = (await finishRun(a, [{ key: "build", state: "success" }])).run;
  const long = await call(operator, "cancel", { run_id: r3.id, reason: "x".repeat(501) });
  expect(!long.ok && long.error.code).toBe("invalid_input");
  const padded = await call(operator, "cancel", { run_id: r3.id, reason: ` ${"x".repeat(500)} ` });
  expect(padded.ok).toBe(true);
  expect((await call(operator, "cancel", { run_id: r3.id, reason: "   " })).ok).toBe(true);
  const rerun = await call(operator, "rerun", { run_id: r3.id });
  expect(!rerun.ok && rerun.error.code).toBe("invalid_input");
});

test("rerun: named jobs, refusals and role are enforced; refusals change nothing", async () => {
  const { run: r, ids } = await finishRun(a, [
    { key: "build", state: "success" },
    { key: "test", state: "failure" },
  ]);
  expect(!(await call(reader, "rerun", { run_id: r.id, reason: "x" })).ok).toBe(true);
  const denied = await call(reader, "rerun", { run_id: r.id, reason: "x" });
  expect(!denied.ok && denied.error.code).toBe("forbidden");
  const noReason = await call(operator, "rerun", { run_id: r.id });
  expect(!noReason.ok && noReason.error.code).toBe("invalid_input");
  const empty = await call(operator, "rerun", { run_id: r.id, reason: "" });
  expect(!empty.ok && empty.error.code).toBe("invalid_input");
  const unknown = await call(operator, "rerun", { run_id: r.id, jobs: ["nope"], reason: "x" });
  expect(!unknown.ok && unknown.error.code).toBe("invalid_input");
  const missing = await call(operator, "rerun", {
    run_id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
    reason: "x",
  });
  expect(!missing.ok && missing.error.code).toBe("not_found");

  // a success job can be rerun by key; a queued job cannot
  const named = await run(operator, "rerun", { run_id: r.id, jobs: ["build"], reason: "verify" });
  expect(named.reruns).toHaveLength(1);
  const busy = await call(operator, "rerun", {
    run_id: r.id,
    jobs: ["build", "test"],
    reason: "x",
  });
  expect(!busy.ok && busy.error.code).toBe("conflict");
  expect(!busy.ok && busy.error.message).toContain("not finished");
  // all or nothing: test was not touched by the refused call
  expect((await getJob(db, a.scope, ids.test!))?.state).toBe("failure");
  expect(await listAttempts(db, a.scope, ids.test!)).toHaveLength(1);

  // nothing failed: refused clearly
  const { run: ok } = await finishRun(a, [{ key: "only", state: "success" }], "d".repeat(40));
  const none = await call(operator, "rerun", { run_id: ok.id, reason: "x" });
  expect(!none.ok && none.error.code).toBe("conflict");
  expect(!none.ok && none.error.message).toContain("no failed jobs");
  // refusals are audited
  const audit = await listAudit(db, { orgId: a.orgId });
  expect(audit.some((x) => x.op === "rerun" && x.outcome === "error:forbidden")).toBe(true);
  expect(audit.some((x) => x.op === "rerun" && x.outcome === "error:conflict")).toBe(true);
});

test("rerun: at most 2 per job per commit, across runs of the same sha", async () => {
  const sha = "e".repeat(40);
  const first = await finishRun(a, [{ key: "test", state: "failure" }], sha);
  const settle = async (runId: string, jobId: string) => {
    const attempt = (await listAttempts(db, a.scope, jobId)).at(-1)!;
    await transitionJob(db, a.scope, jobId, "running");
    await updateAttempt(db, a.scope, attempt.id, { state: "running" });
    await updateAttempt(db, a.scope, attempt.id, { state: "failure", exitCode: 1 });
    await transitionJob(db, a.scope, jobId, "failure", { exitCode: 1 });
    await setRunStatus(db, a.scope, runId, "failure");
  };
  const one = await run(operator, "rerun", { run_id: first.run.id, reason: "1" });
  expect(one.reruns[0].reruns_used).toBe(1);
  await settle(first.run.id, first.ids.test!);
  const two = await run(operator, "rerun", { run_id: first.run.id, reason: "2" });
  expect(two.reruns[0].reruns_used).toBe(2);
  await settle(first.run.id, first.ids.test!);

  const third = await call(operator, "rerun", { run_id: first.run.id, reason: "3" });
  expect(!third.ok && third.error.code).toBe("conflict");
  expect(!third.ok && third.error.message).toMatch(/already rerun 2 times.*limit 2/);
  expect((await listAttempts(db, a.scope, first.ids.test!)).length).toBe(3);

  // a different run of the same commit shares the cap
  const sibling = await finishRun(a, [{ key: "test", state: "failure" }], sha);
  const shared = await call(operator, "rerun", { run_id: sibling.run.id, reason: "x" });
  expect(!shared.ok && shared.error.code).toBe("conflict");
  // another commit, another job key, and another org are independent
  const other = await finishRun(a, [{ key: "test", state: "failure" }], "f".repeat(40));
  expect((await call(operator, "rerun", { run_id: other.run.id, reason: "x" })).ok).toBe(true);
  const bTok = (await mintToken(db, { orgId: b.orgId }, "operator")).secret;
  const bRun = await finishRun(b, [{ key: "test", state: "failure" }], sha);
  expect(
    (await run(bTok, "rerun", { run_id: bRun.run.id, reason: "x" })).reruns[0].reruns_used,
  ).toBe(1);
});

async function failAgain(runId: string, jobId: string, state: "failure" | "infra_error") {
  const attempt = (await listAttempts(db, a.scope, jobId)).at(-1)!;
  await transitionJob(db, a.scope, jobId, "running");
  await updateAttempt(db, a.scope, attempt.id, { state: "running" });
  if (state === "infra_error") {
    await updateAttempt(db, a.scope, attempt.id, { state, errorClass: "lost" });
    await transitionJob(db, a.scope, jobId, state);
  } else {
    await updateAttempt(db, a.scope, attempt.id, { state, exitCode: 1 });
    await transitionJob(db, a.scope, jobId, state, { exitCode: 1 });
  }
  await setRunStatus(db, a.scope, runId, "failure");
}

test("rerun: infra-error reruns leave the user budget, bounded by their own limit", async () => {
  const sha = "1".repeat(40);
  const first = await finishRun(a, [{ key: "test", state: "infra_error" }], sha);
  const id = first.ids.test!;
  // two reruns after infra errors: the user budget is still full
  for (let i = 0; i < 2; i++) {
    const out = await run(operator, "rerun", { run_id: first.run.id, reason: `infra ${i}` });
    expect(out.reruns[0].reruns_used).toBe(0);
    await failAgain(first.run.id, id, "infra_error");
  }
  // this rerun replaces an infra attempt, so it is the third infra rerun; it then fails for real
  await run(operator, "rerun", { run_id: first.run.id, reason: "infra 2" });
  await failAgain(first.run.id, id, "failure");
  // user-outcome reruns still stop at 2
  await run(operator, "rerun", { run_id: first.run.id, reason: "u1" });
  await failAgain(first.run.id, id, "failure");
  const u2 = await run(operator, "rerun", { run_id: first.run.id, reason: "u2" });
  expect(u2.reruns[0].reruns_used).toBe(2);
  await failAgain(first.run.id, id, "failure");
  const refused = await call(operator, "rerun", { run_id: first.run.id, reason: "u3" });
  expect(!refused.ok && refused.error.code).toBe("conflict");
  // the message names both budgets
  expect(!refused.ok && refused.error.message).toMatch(
    /already rerun 2 times.*limit 2.*0 of 2 job-outcome reruns and 2 of 5 infra-error reruns remain/,
  );
});

test("rerun: the infra streak is bounded at 5 per job per commit", async () => {
  const sha = "2".repeat(40);
  const first = await finishRun(a, [{ key: "test", state: "infra_error" }], sha);
  const id = first.ids.test!;
  for (let i = 0; i < 5; i++) {
    await run(operator, "rerun", { run_id: first.run.id, reason: `infra ${i}` });
    await failAgain(first.run.id, id, "infra_error");
  }
  const refused = await call(operator, "rerun", { run_id: first.run.id, reason: "again" });
  expect(!refused.ok && refused.error.code).toBe("conflict");
  expect(!refused.ok && refused.error.message).toMatch(
    /after infra errors.*infra limit 5.*2 of 2 job-outcome reruns and 0 of 5 infra-error reruns remain/,
  );
  expect(await listAttempts(db, a.scope, id)).toHaveLength(6);
});

async function finishWithDependent(sha: string, upstream: "failure" | "infra_error") {
  const first = await finishRun(a, [{ key: "build", state: upstream }], sha);
  const dep = (await createJob(db, a.scope, {
    runId: first.run.id,
    jobKey: "deploy",
    name: "deploy",
    needs: ["build"],
  }))!;
  const at = (await createAttempt(db, a.scope, { jobId: dep.id, provider: "docker" }))!;
  await updateAttempt(db, a.scope, at.id, {
    state: "skipped",
    errorClass: `dependency:${upstream}`,
  });
  await transitionJob(db, a.scope, dep.id, "skipped");
  return { run: first.run, build: first.ids.build!, deploy: dep.id };
}

test("rerun: a dependent skipped by an infra_error upstream uses the infra budget", async () => {
  const f = await finishWithDependent("3".repeat(40), "infra_error");
  // three upstream infra failures, the dependent rerun each time; the 4th rerun is accepted
  for (let i = 0; i < 3; i++) {
    const out = await run(operator, "rerun", {
      run_id: f.run.id,
      jobs: ["deploy"],
      reason: `i${i}`,
    });
    expect(out.reruns[0].reruns_used).toBe(0);
    const att = (await listAttempts(db, a.scope, f.deploy)).at(-1)!;
    await updateAttempt(db, a.scope, att.id, {
      state: "skipped",
      errorClass: "dependency:infra_error",
    });
    await transitionJob(db, a.scope, f.deploy, "skipped");
  }
  const fourth = await call(operator, "rerun", {
    run_id: f.run.id,
    jobs: ["deploy"],
    reason: "i3",
  });
  expect(fourth.ok).toBe(true);
});

test("rerun: the refusal for a dependency-skipped job reports both budgets", async () => {
  const f = await finishWithDependent("4".repeat(40), "infra_error");
  for (let i = 0; i < 5; i++) {
    await run(operator, "rerun", { run_id: f.run.id, jobs: ["deploy"], reason: `i${i}` });
    const att = (await listAttempts(db, a.scope, f.deploy)).at(-1)!;
    await updateAttempt(db, a.scope, att.id, {
      state: "skipped",
      errorClass: "dependency:infra_error",
    });
    await transitionJob(db, a.scope, f.deploy, "skipped");
  }
  const refused = await call(operator, "rerun", {
    run_id: f.run.id,
    jobs: ["deploy"],
    reason: "x",
  });
  expect(!refused.ok && refused.error.message).toMatch(
    /after infra errors.*infra limit 5.*2 of 2 job-outcome reruns and 0 of 5 infra-error reruns remain/,
  );
});

test("rerun: a dependent skipped by a real failure is charged to the job-outcome budget", async () => {
  const f = await finishWithDependent("5".repeat(40), "failure");
  const one = await run(operator, "rerun", { run_id: f.run.id, jobs: ["deploy"], reason: "u1" });
  expect(one.reruns[0].reruns_used).toBe(1);
  const att = (await listAttempts(db, a.scope, f.deploy)).at(-1)!;
  await updateAttempt(db, a.scope, att.id, { state: "skipped", errorClass: "dependency:failure" });
  await transitionJob(db, a.scope, f.deploy, "skipped");
  const two = await run(operator, "rerun", { run_id: f.run.id, jobs: ["deploy"], reason: "u2" });
  expect(two.reruns[0].reruns_used).toBe(2);
  const att2 = (await listAttempts(db, a.scope, f.deploy)).at(-1)!;
  await updateAttempt(db, a.scope, att2.id, { state: "skipped", errorClass: "dependency:failure" });
  await transitionJob(db, a.scope, f.deploy, "skipped");
  const refused = await call(operator, "rerun", {
    run_id: f.run.id,
    jobs: ["deploy"],
    reason: "u3",
  });
  expect(!refused.ok && refused.error.message).toMatch(
    /already rerun 2 times.*limit 2.*0 of 2 job-outcome reruns and 5 of 5 infra-error reruns remain/,
  );
});

/** build -> test -> deploy: build ends `upstream`, readiness skips the two dependents. */
async function chain(sha: string, upstream: "failure" | "infra_error") {
  const r = await createRun(db, a.scope, {
    workflowPath: "w.yml",
    event: "push",
    ref: "main",
    sha,
  });
  const mk = async (key: string, needs: string[]) => {
    const j = (await createJob(db, a.scope, { runId: r.id, jobKey: key, name: key, needs }))!;
    await createAttempt(db, a.scope, { jobId: j.id, provider: "docker" });
    return j.id;
  };
  const ids = {
    build: await mk("build", []),
    test: await mk("test", ["build"]),
    deploy: await mk("deploy", ["test"]),
  };
  const endBuild = async () => {
    const at = (await listAttempts(db, a.scope, ids.build)).at(-1)!;
    await transitionJob(db, a.scope, ids.build, "running");
    await updateAttempt(db, a.scope, at.id, { state: "running" });
    await updateAttempt(db, a.scope, at.id, {
      state: upstream,
      errorClass: upstream === "infra_error" ? "lost" : null,
      exitCode: upstream === "failure" ? 1 : null,
    });
    await transitionJob(
      db,
      a.scope,
      ids.build,
      upstream,
      upstream === "failure" ? { exitCode: 1 } : {},
    );
    await resolveDependents(db, a.scope, r.id);
  };
  await endBuild();
  return { run: r, ids, endBuild };
}

test("readiness: the root cause carries down a three-level chain", async () => {
  for (const [upstream, sha] of [
    ["infra_error", "6".repeat(40)],
    ["failure", "7".repeat(40)],
  ] as const) {
    const c = await chain(sha, upstream);
    for (const id of [c.ids.test, c.ids.deploy]) {
      expect((await getJob(db, a.scope, id))!.state).toBe("skipped");
      expect((await listAttempts(db, a.scope, id)).at(-1)!.errorClass).toBe(
        `dependency:${upstream}`,
      );
    }
  }
});

test("rerun: jobs=failed on a three-level infra chain uses the infra budget, 5 times", async () => {
  const c = await chain("8".repeat(40), "infra_error");
  for (let i = 0; i < 5; i++) {
    const out = await run(operator, "rerun", { run_id: c.run.id, jobs: "failed", reason: `i${i}` });
    expect(out.reruns.map((x: { job_key: string }) => x.job_key).sort()).toEqual([
      "build",
      "deploy",
      "test",
    ]);
    expect(out.reruns.every((x: { reruns_used: number }) => x.reruns_used === 0)).toBe(true);
    await c.endBuild();
  }
  const sixth = await call(operator, "rerun", { run_id: c.run.id, jobs: "failed", reason: "x" });
  expect(!sixth.ok && sixth.error.message).toMatch(/after infra errors.*infra limit 5/);
});

test("rerun: cross-tenant denial", async () => {
  const bRun = await finishRun(b, [{ key: "test", state: "failure" }]);
  const res = await call(operator, "rerun", { run_id: bRun.run.id, reason: "x" });
  expect(!res.ok && res.error.code).toBe("not_found");
  expect((await getJob(db, b.scope, bRun.ids.test!))?.state).toBe("failure");
  expect(await listAttempts(db, b.scope, bRun.ids.test!)).toHaveLength(1);
});

test("events long-poll: a per-org cap keeps one org from using every slot", async () => {
  const saved = { ...waiterLimits };
  waiterLimits.perOrg = 3;
  waiterLimits.global = 5;
  // Barrier on the long-poll's own slot count, never on a sleep: each call queries the database
  // before it takes a slot, which can take arbitrarily long under load.
  const until = async (n: number, orgId?: string) => {
    const stop = Date.now() + 20_000;
    while (waitingCount(orgId) !== n) {
      if (Date.now() > stop) throw new Error(`waiters stuck at ${waitingCount(orgId)}, want ${n}`);
      await Bun.sleep(5);
    }
  };
  try {
    const bTok = (await mintToken(db, { orgId: b.orgId }, "reader")).secret;
    // Held waiters outlive every step below; an over-cap call that wrongly waited (5000 ms) would
    // outlast them and the slot counts would drop, so the asserts need no wall-clock bound.
    const hold = 2500;
    const poll = (tok: string, wait = hold) =>
      run(tok, "events", { after: 999_999, wait_ms: wait });

    const aWaiters = Array.from({ length: 3 }, () => poll(reader));
    await until(3, a.orgId);
    expect(waitingCount(a.orgId)).toBe(3);

    // org A is at its cap: a fourth call returns at once, without taking a slot
    await poll(reader, 5000);
    expect(waitingCount(a.orgId)).toBe(3);

    // org B still gets slots while A is saturated
    const bWaiters = Array.from({ length: 2 }, () => poll(bTok));
    await until(2, b.orgId);
    expect(waitingCount(b.orgId)).toBe(2);
    expect(waitingCount()).toBe(5);

    // the global cap still binds: a third org waiter in B is over it
    await poll(bTok, 5000);
    expect(waitingCount()).toBe(5);

    await Promise.all([...aWaiters, ...bWaiters]);
    expect(waitingCount()).toBe(0);
    expect(waitingCount(a.orgId)).toBe(0);
    expect(waitingCount(b.orgId)).toBe(0);
    // slots are released: waiting works again
    const again = poll(reader, 100);
    await until(1, a.orgId);
    await again;
    expect(waitingCount(a.orgId)).toBe(0);
  } finally {
    Object.assign(waiterLimits, saved);
  }
  void seedTenant;
});

async function gatedRun(sha: string) {
  const r = await createRun(db, a.scope, {
    workflowPath: "w.yml",
    event: "pull_request",
    ref: "main",
    sha,
  });
  const mk = async (key: string, approvalKind?: "untrusted_author" | "environment") => {
    const job = (await createJob(db, a.scope, {
      runId: r.id,
      jobKey: key,
      name: key,
      approvalKind,
    }))!;
    await createAttempt(db, a.scope, { jobId: job.id, provider: "docker" });
    return job.id;
  };
  return { run: r, mk };
}

test("rerun never bypasses approval: a gated job goes back to awaiting_approval, never queued", async () => {
  const { run: r, mk } = await gatedRun("a1".repeat(20));
  const started = await mk("ran-then-cancelled", "untrusted_author");
  const failedGated = await mk("failed-gated", "environment");
  const plain = await mk("plain-failure");
  // started jobs: run, then end as cancelled / failure
  for (const id of [started, failedGated, plain]) {
    await transitionJob(db, a.scope, id, "running");
    const at = (await listAttempts(db, a.scope, id)).at(-1)!;
    await updateAttempt(db, a.scope, at.id, { state: "running" });
  }
  await transitionJob(db, a.scope, started, "cancelled");
  for (const id of [failedGated, plain]) {
    const at = (await listAttempts(db, a.scope, id)).at(-1)!;
    await updateAttempt(db, a.scope, at.id, { state: "failure", exitCode: 1 });
    await transitionJob(db, a.scope, id, "failure", { exitCode: 1 });
  }
  await setRunStatus(db, a.scope, r.id, "failure");

  const out = await run(operator, "rerun", {
    run_id: r.id,
    jobs: ["ran-then-cancelled", "failed-gated", "plain-failure"],
    reason: "again",
  });
  const byKey = Object.fromEntries(out.reruns.map((x: { job_key: string }) => [x.job_key, x]));
  expect(byKey["ran-then-cancelled"]).toMatchObject({
    state: "awaiting_approval",
    previous_state: "cancelled",
  });
  expect(byKey["failed-gated"]).toMatchObject({
    state: "awaiting_approval",
    previous_state: "failure",
  });
  expect(byKey["plain-failure"]).toMatchObject({ state: "queued" });
  expect((await getJob(db, a.scope, started))?.state).toBe("awaiting_approval");
  expect((await getJob(db, a.scope, failedGated))?.state).toBe("awaiting_approval");
  expect((await getJob(db, a.scope, plain))?.state).toBe("queued");
  // the new attempts wait too
  expect((await listAttempts(db, a.scope, started)).at(-1)).toMatchObject({
    attempt: 2,
    state: "awaiting_approval",
    rerunReason: "again",
  });
  expect((await listAttempts(db, a.scope, plain)).at(-1)).toMatchObject({
    attempt: 2,
    state: "queued",
  });
  // approval.required is emitted for each gated job, none for the plain one
  const events = await listEvents(db, a.scope, {
    after: 0,
    limit: 500,
    types: ["approval.required"],
  });
  const rerunApprovals = events.filter((e) => e.payload.includes('"rerun":true'));
  expect(rerunApprovals.map((e) => e.jobId).toSorted()).toEqual([started, failedGated].toSorted());
  expect(JSON.parse(rerunApprovals[0]!.payload).approval_kind).toBeString();
  // the run is waiting on a human, not finished
  expect((await getRun(db, a.scope, r.id))?.status).toBe("running");
});

test("rerun refuses a gated job that never ran: cancelled while awaiting approval, or skipped", async () => {
  const { run: r, mk } = await gatedRun("b2".repeat(20));
  const waiting = await mk("cancelled-while-waiting", "untrusted_author");
  const skippedGated = await mk("skipped-gated", "environment");
  const skippedPlain = await mk("skipped-plain");
  await transitionJob(db, a.scope, waiting, "awaiting_approval");
  await transitionJob(db, a.scope, waiting, "cancelled");
  await transitionJob(db, a.scope, skippedGated, "skipped");
  await transitionJob(db, a.scope, skippedPlain, "skipped");

  for (const key of ["cancelled-while-waiting", "skipped-gated"]) {
    const res = await call(operator, "rerun", { run_id: r.id, jobs: [key], reason: "try" });
    expect(!res.ok && res.error.code).toBe("conflict");
    expect(!res.ok && res.error.message).toContain("never ran and needs approval");
  }
  expect((await getJob(db, a.scope, waiting))?.state).toBe("cancelled"); // not queued, not awaiting
  expect((await getJob(db, a.scope, skippedGated))?.state).toBe("skipped");
  expect(await listAttempts(db, a.scope, waiting)).toHaveLength(1);
  // all or nothing: one refusable job in the list blocks the rest
  const mixed = await call(operator, "rerun", {
    run_id: r.id,
    jobs: ["skipped-plain", "skipped-gated"],
    reason: "try",
  });
  expect(!mixed.ok && mixed.error.code).toBe("conflict");
  expect((await getJob(db, a.scope, skippedPlain))?.state).toBe("skipped");
  // a never-started job with no approval kind may be rerun, and goes to queued
  const ok = await run(operator, "rerun", { run_id: r.id, jobs: ["skipped-plain"], reason: "now" });
  expect(ok.reruns[0]).toMatchObject({ state: "queued", previous_state: "skipped" });
  expect((await getJob(db, a.scope, skippedPlain))?.state).toBe("queued");
});
