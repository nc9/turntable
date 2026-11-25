import { beforeEach, expect, test } from "bun:test";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  addMember,
  appendLog,
  bindRepo,
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  createUser,
  type Db,
  ensureLocalTenant,
  getAttempt,
  getJob,
  getProject,
  getRun,
  listAttempts,
  listJobs,
  listMembers,
  listProjects,
  listRepos,
  listRuns,
  openDatabase,
  readLog,
  renameProject,
  resolveRepoScope,
  schema,
  setRunStatus,
  transitionJob,
  updateAttempt,
} from "../src/db";
import { onPostgres } from "./pg-mode";

/** Tables that legitimately have no org_id. Adding to this list needs a reason. */
const NO_ORG_ID = new Set([
  "instance", // instance-level config
  "orgs", // the tenant itself
  "users", // global identity; membership is org_members
  "instance_tokens", // the instance administrator: holds no org grant by design (#205)
  "github_identities", // a GitHub account linked to a global user (#430)
  "login_states", // a sign-in attempt in flight, before anyone is known (#430)
  "web_sessions", // a signed-in user's session; its orgs come from org_members (#430)
  "user_tokens", // user-scoped, not org-scoped: a user token acts in an org only through a current membership resolved per call (#547)
]);

test.skipIf(onPostgres)("every table except the allowlist has an org_id column", () => {
  const tables = Object.values(schema).filter((v) => v instanceof SQLiteTable);
  expect(tables.length).toBeGreaterThanOrEqual(10);
  const missing = tables
    .map((t) => getTableConfig(t))
    .filter((c) => !NO_ORG_ID.has(c.name) && !c.columns.some((col) => col.name === "org_id"))
    .map((c) => c.name);
  expect(missing).toEqual([]);
});

test("ulid ids are 26 chars and sort by creation", async () => {
  const { ulid } = await import("../src/db/ulid");
  const ids = Array.from({ length: 50 }, () => ulid());
  expect(ids.every((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))).toBe(true);
  expect(ids.toSorted()).toEqual(ids);
});

let db: Db;
let a: { orgId: string; projectId: string };
let b: { orgId: string; projectId: string };

async function seed(slug: string) {
  const org = await createOrg(db, { slug, name: slug });
  const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "App" });
  return { orgId: org.id, projectId: project.id };
}

beforeEach(async () => {
  db = openDatabase(":memory:");
  a = await seed("org-a");
  b = await seed("org-b");
});

test("org B cannot read, update or list org A's project, run, job or logs", async () => {
  const run = await createRun(db, a, {
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    ref: "main",
  });
  const job = (await createJob(db, a, { runId: run.id, jobKey: "build", name: "build" }))!;
  const attempt = (await createAttempt(db, a, { jobId: job.id, provider: "local-docker" }))!;
  await appendLog(db, a, attempt.id, 0, new TextEncoder().encode("secret-ish output"));

  // sanity: A sees all of it
  expect(await getRun(db, a, run.id)).toBeDefined();
  expect(await readLog(db, a, attempt.id)).toHaveLength(1);

  const bOrgOnly = { orgId: b.orgId };
  for (const scope of [b, bOrgOnly]) {
    expect(await getProject(db, scope, a.projectId)).toBeUndefined();
    expect(await getRun(db, scope, run.id)).toBeUndefined();
    expect(await getJob(db, scope, job.id)).toBeUndefined();
    expect(await getAttempt(db, scope, attempt.id)).toBeUndefined();
    expect(await listJobs(db, scope, run.id)).toEqual([]);
    expect(await listAttempts(db, scope, job.id)).toEqual([]);
    expect(await readLog(db, scope, attempt.id)).toEqual([]);
    expect(await listRuns(db, scope)).toEqual([]);
    expect((await listProjects(db, scope)).map((p) => p.id)).not.toContain(a.projectId);
    expect(await listMembers(db, scope)).toEqual([]);
    expect(await listRepos(db, scope)).toEqual([]);
  }

  // writes
  expect(await renameProject(db, b, a.projectId, "pwned")).toBeUndefined();
  expect((await getProject(db, a, a.projectId))!.name).toBe("App");
  expect(await setRunStatus(db, b, run.id, "cancelled")).toBeUndefined();
  expect((await getRun(db, a, run.id))!.status).toBe("queued");
  expect(await transitionJob(db, b, job.id, "cancelled")).toBeUndefined();
  expect((await getJob(db, a, job.id))!.state).toBe("queued");
  expect(await updateAttempt(db, b, attempt.id, { state: "running" })).toBeUndefined();
  expect(await appendLog(db, b, attempt.id, 99, new Uint8Array([1]))).toBe(false);
  expect(await readLog(db, a, attempt.id)).toHaveLength(1);
  expect(await createJob(db, b, { runId: run.id, jobKey: "x", name: "x" })).toBeUndefined();
  expect(await createAttempt(db, b, { jobId: job.id, provider: "p" })).toBeUndefined();
});

test("project-narrowed scope cannot see sibling projects in the same org", async () => {
  const sibling = await createProject(db, { orgId: a.orgId }, { slug: "other", name: "Other" });
  const sib = { orgId: a.orgId, projectId: sibling.id };
  const run = await createRun(db, a, { workflowPath: "w.yml", event: "push", ref: "main" });
  expect(await getRun(db, sib, run.id)).toBeUndefined();
  expect(await listRuns(db, sib)).toEqual([]);
  expect((await listProjects(db, sib)).map((p) => p.id)).toEqual([sibling.id]);
});

test("writes need a project in scope and the composite FK blocks cross-org rows", async () => {
  await expect(
    createRun(db, { orgId: a.orgId }, { workflowPath: "w", event: "e", ref: "r" }),
  ).rejects.toThrow();
  // Forge a mismatched (org, project) pair directly: the DB refuses it.
  await expect(
    createRun(
      db,
      { orgId: b.orgId, projectId: a.projectId },
      { workflowPath: "w", event: "e", ref: "r" },
    ),
  ).rejects.toThrow();
});

test("repo binding is globally unique and resolves to its owning scope", async () => {
  await bindRepo(db, a, { forge: "github", owner: "acme", repo: "web", installationId: "42" });
  await expect(bindRepo(db, b, { forge: "github", owner: "acme", repo: "web" })).rejects.toThrow();
  expect(
    await resolveRepoScope(db, {
      forge: "github",
      owner: "acme",
      repo: "web",
      installationId: "42",
    }),
  ).toEqual(a);
  expect(
    await resolveRepoScope(db, { forge: "github", owner: "acme", repo: "nope" }),
  ).toBeUndefined();
  expect(await listRepos(db, b)).toEqual([]);
});

test("members are per org", async () => {
  const user = await createUser(db, { email: "x@example.com", displayName: "X" });
  await addMember(db, { orgId: a.orgId }, { userId: user.id, role: "owner" });
  expect(await listMembers(db, { orgId: a.orgId })).toHaveLength(1);
  expect(await listMembers(db, { orgId: b.orgId })).toHaveLength(0);
  await expect(
    addMember(db, { orgId: b.orgId }, { userId: user.id, role: "root" as never }),
  ).rejects.toThrow();
});

test("ensureLocalTenant is idempotent and returns a usable scope", async () => {
  const first = await ensureLocalTenant(db);
  const second = await ensureLocalTenant(db);
  expect(second).toEqual(first);
  expect(
    (await createRun(db, first, { workflowPath: "w", event: "push", ref: "main" })).orgId,
  ).toBe(first.orgId);
  const orgs = await db.orm.select().from(schema.orgs);
  expect(orgs.filter((o) => o.slug === "local")).toHaveLength(1);
});

test("project A cannot read, update or append to project B's attempts and logs (same org)", async () => {
  const pb = await createProject(db, { orgId: a.orgId }, { slug: "b", name: "B" });
  const sb = { orgId: a.orgId, projectId: pb.id };
  const run = await createRun(db, a, { workflowPath: "w", event: "push", ref: "main" });
  const job = (await createJob(db, a, { runId: run.id, jobKey: "k", name: "k" }))!;
  const attempt = (await createAttempt(db, a, { jobId: job.id, provider: "p" }))!;
  await appendLog(db, a, attempt.id, 0, new Uint8Array([1, 2]));

  expect(await getAttempt(db, sb, attempt.id)).toBeUndefined();
  expect(await listAttempts(db, sb, job.id)).toEqual([]);
  expect(await readLog(db, sb, attempt.id)).toEqual([]);
  expect(await updateAttempt(db, sb, attempt.id, { state: "running" })).toBeUndefined();
  expect(await appendLog(db, sb, attempt.id, 2, new Uint8Array([3]))).toBe(false);
  expect(await createAttempt(db, sb, { jobId: job.id, provider: "p" })).toBeUndefined();
  expect((await getAttempt(db, a, attempt.id))!.state).toBe("queued");
  expect(await readLog(db, a, attempt.id)).toHaveLength(1);
});

test("db rejects a job pointing at a run in another project of the same org", async () => {
  const pb = await createProject(db, { orgId: a.orgId }, { slug: "b", name: "B" });
  const run = await createRun(db, a, { workflowPath: "w", event: "push", ref: "main" });
  const raw = { orgId: a.orgId, projectId: pb.id };
  await expect(
    createJob(db, raw, { runId: run.id, jobKey: "k", name: "k" }),
  ).resolves.toBeUndefined();
  // createJob returns undefined (parent not in scope); force the insert to hit the FK.
  const forged = db.orm.insert(schema.jobs).values({
    id: "J1",
    orgId: a.orgId,
    projectId: pb.id,
    runId: run.id,
    jobKey: "k",
    name: "k",
  });
  await expect(Promise.resolve(forged)).rejects.toThrow();
});

test("repo owner and name are case-insensitive; forge repo id survives renames", async () => {
  await bindRepo(db, a, { forge: "github", owner: "Acme", repo: "Web", forgeRepoId: "999" });
  expect(
    await resolveRepoScope(db, { forge: "github", owner: "ACME", repo: "WEB", forgeRepoId: "999" }),
  ).toEqual(a);
  expect((await listRepos(db, a))[0]).toMatchObject({ owner: "acme", repo: "web" });
  // renamed upstream: the id still routes
  expect(
    await resolveRepoScope(db, {
      forge: "github",
      owner: "acme",
      repo: "renamed",
      forgeRepoId: "999",
    }),
  ).toEqual(a);
  await expect(
    bindRepo(db, b, { forge: "github", owner: "other", repo: "x", forgeRepoId: "999" }),
  ).rejects.toThrow();
  await expect(bindRepo(db, b, { forge: "github", owner: "ACME", repo: "web" })).rejects.toThrow();
  // two repos without an id do not collide on the id index
  await bindRepo(db, b, { forge: "github", owner: "o1", repo: "r1" });
  await bindRepo(db, b, { forge: "github", owner: "o2", repo: "r2" });
});

test("resolveRepoScope requires a matching installation when the binding has one", async () => {
  await bindRepo(db, a, { forge: "github", owner: "acme", repo: "app", installationId: "100" });
  const q = { forge: "github", owner: "acme", repo: "app" } as const;
  expect(await resolveRepoScope(db, { ...q, installationId: "100" })).toEqual(a);
  expect(await resolveRepoScope(db, { ...q, installationId: "200" })).toBeUndefined();
  expect(await resolveRepoScope(db, q)).toBeUndefined();
  // unbound installation (null) still routes by name
  await bindRepo(db, b, { forge: "github", owner: "acme", repo: "legacy" });
  expect(await resolveRepoScope(db, { forge: "github", owner: "acme", repo: "legacy" })).toEqual(b);
});

test("name fallback never routes to a row bound to a different forge repo id", async () => {
  await bindRepo(db, a, { forge: "github", owner: "acme", repo: "svc", forgeRepoId: "1" });
  const q = { forge: "github", owner: "acme", repo: "svc" } as const;
  // recreated or taken-over name: different id finds no row, name match has another id
  expect(await resolveRepoScope(db, { ...q, forgeRepoId: "2" })).toBeUndefined();
  // no id on the event: cannot prove identity of an id-bound row
  expect(await resolveRepoScope(db, q)).toBeUndefined();
  expect(await resolveRepoScope(db, { ...q, forgeRepoId: "1" })).toEqual(a);
  // id-less rows still route by name, with or without an incoming id
  await bindRepo(db, b, { forge: "github", owner: "acme", repo: "old" });
  expect(
    await resolveRepoScope(db, { forge: "github", owner: "acme", repo: "old", forgeRepoId: "7" }),
  ).toEqual(b);
});
