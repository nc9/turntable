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

/** Tables that legitimately have no org_id. Adding to this list needs a reason. */
const NO_ORG_ID = new Set([
  "instance", // instance-level config
  "orgs", // the tenant itself
  "users", // global identity; membership is org_members
]);

test("every table except the allowlist has an org_id column", () => {
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

function seed(slug: string) {
  const org = createOrg(db, { slug, name: slug });
  const project = createProject(db, { orgId: org.id }, { slug: "app", name: "App" });
  return { orgId: org.id, projectId: project.id };
}

beforeEach(() => {
  db = openDatabase(":memory:");
  a = seed("org-a");
  b = seed("org-b");
});

test("org B cannot read, update or list org A's project, run, job or logs", () => {
  const run = createRun(db, a, {
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    ref: "main",
  });
  const job = createJob(db, a, { runId: run.id, jobKey: "build", name: "build" })!;
  const attempt = createAttempt(db, a, { jobId: job.id, provider: "local-docker" })!;
  appendLog(db, a, attempt.id, 0, new TextEncoder().encode("secret-ish output"));

  // sanity: A sees all of it
  expect(getRun(db, a, run.id)).toBeDefined();
  expect(readLog(db, a, attempt.id)).toHaveLength(1);

  const bOrgOnly = { orgId: b.orgId };
  for (const scope of [b, bOrgOnly]) {
    expect(getProject(db, scope, a.projectId)).toBeUndefined();
    expect(getRun(db, scope, run.id)).toBeUndefined();
    expect(getJob(db, scope, job.id)).toBeUndefined();
    expect(getAttempt(db, scope, attempt.id)).toBeUndefined();
    expect(listJobs(db, scope, run.id)).toEqual([]);
    expect(listAttempts(db, scope, job.id)).toEqual([]);
    expect(readLog(db, scope, attempt.id)).toEqual([]);
    expect(listRuns(db, scope)).toEqual([]);
    expect(listProjects(db, scope).map((p) => p.id)).not.toContain(a.projectId);
    expect(listMembers(db, scope)).toEqual([]);
    expect(listRepos(db, scope)).toEqual([]);
  }

  // writes
  expect(renameProject(db, b, a.projectId, "pwned")).toBeUndefined();
  expect(getProject(db, a, a.projectId)!.name).toBe("App");
  expect(setRunStatus(db, b, run.id, "cancelled")).toBeUndefined();
  expect(getRun(db, a, run.id)!.status).toBe("queued");
  expect(transitionJob(db, b, job.id, "cancelled")).toBeUndefined();
  expect(getJob(db, a, job.id)!.state).toBe("queued");
  expect(updateAttempt(db, b, attempt.id, { state: "running" })).toBeUndefined();
  expect(appendLog(db, b, attempt.id, 99, new Uint8Array([1]))).toBe(false);
  expect(readLog(db, a, attempt.id)).toHaveLength(1);
  expect(createJob(db, b, { runId: run.id, jobKey: "x", name: "x" })).toBeUndefined();
  expect(createAttempt(db, b, { jobId: job.id, provider: "p" })).toBeUndefined();
});

test("project-narrowed scope cannot see sibling projects in the same org", () => {
  const sibling = createProject(db, { orgId: a.orgId }, { slug: "other", name: "Other" });
  const sib = { orgId: a.orgId, projectId: sibling.id };
  const run = createRun(db, a, { workflowPath: "w.yml", event: "push", ref: "main" });
  expect(getRun(db, sib, run.id)).toBeUndefined();
  expect(listRuns(db, sib)).toEqual([]);
  expect(listProjects(db, sib).map((p) => p.id)).toEqual([sibling.id]);
});

test("writes need a project in scope and the composite FK blocks cross-org rows", () => {
  expect(() =>
    createRun(db, { orgId: a.orgId }, { workflowPath: "w", event: "e", ref: "r" }),
  ).toThrow();
  // Forge a mismatched (org, project) pair directly: the DB refuses it.
  expect(() =>
    createRun(
      db,
      { orgId: b.orgId, projectId: a.projectId },
      { workflowPath: "w", event: "e", ref: "r" },
    ),
  ).toThrow();
});

test("repo binding is globally unique and resolves to its owning scope", () => {
  bindRepo(db, a, { forge: "github", owner: "acme", repo: "web", installationId: "42" });
  expect(() => bindRepo(db, b, { forge: "github", owner: "acme", repo: "web" })).toThrow();
  expect(
    resolveRepoScope(db, { forge: "github", owner: "acme", repo: "web", installationId: "42" }),
  ).toEqual(a);
  expect(resolveRepoScope(db, { forge: "github", owner: "acme", repo: "nope" })).toBeUndefined();
  expect(listRepos(db, b)).toEqual([]);
});

test("members are per org", () => {
  const user = createUser(db, { email: "x@example.com", displayName: "X" });
  addMember(db, { orgId: a.orgId }, { userId: user.id, role: "owner" });
  expect(listMembers(db, { orgId: a.orgId })).toHaveLength(1);
  expect(listMembers(db, { orgId: b.orgId })).toHaveLength(0);
  expect(() =>
    addMember(db, { orgId: b.orgId }, { userId: user.id, role: "root" as never }),
  ).toThrow();
});

test("ensureLocalTenant is idempotent and returns a usable scope", () => {
  const first = ensureLocalTenant(db);
  const second = ensureLocalTenant(db);
  expect(second).toEqual(first);
  expect(createRun(db, first, { workflowPath: "w", event: "push", ref: "main" }).orgId).toBe(
    first.orgId,
  );
  expect(
    db.orm
      .select()
      .from(schema.orgs)
      .all()
      .filter((o) => o.slug === "local"),
  ).toHaveLength(1);
});

test("project A cannot read, update or append to project B's attempts and logs (same org)", () => {
  const pb = createProject(db, { orgId: a.orgId }, { slug: "b", name: "B" });
  const sb = { orgId: a.orgId, projectId: pb.id };
  const run = createRun(db, a, { workflowPath: "w", event: "push", ref: "main" });
  const job = createJob(db, a, { runId: run.id, jobKey: "k", name: "k" })!;
  const attempt = createAttempt(db, a, { jobId: job.id, provider: "p" })!;
  appendLog(db, a, attempt.id, 0, new Uint8Array([1, 2]));

  expect(getAttempt(db, sb, attempt.id)).toBeUndefined();
  expect(listAttempts(db, sb, job.id)).toEqual([]);
  expect(readLog(db, sb, attempt.id)).toEqual([]);
  expect(updateAttempt(db, sb, attempt.id, { state: "running" })).toBeUndefined();
  expect(appendLog(db, sb, attempt.id, 2, new Uint8Array([3]))).toBe(false);
  expect(createAttempt(db, sb, { jobId: job.id, provider: "p" })).toBeUndefined();
  expect(getAttempt(db, a, attempt.id)!.state).toBe("queued");
  expect(readLog(db, a, attempt.id)).toHaveLength(1);
});

test("db rejects a job pointing at a run in another project of the same org", () => {
  const pb = createProject(db, { orgId: a.orgId }, { slug: "b", name: "B" });
  const run = createRun(db, a, { workflowPath: "w", event: "push", ref: "main" });
  const raw = { orgId: a.orgId, projectId: pb.id };
  expect(() => createJob(db, raw, { runId: run.id, jobKey: "k", name: "k" })).not.toThrow();
  // createJob returns undefined (parent not in scope); force the insert to hit the FK.
  expect(() =>
    db.orm
      .insert(schema.jobs)
      .values({ id: "J1", orgId: a.orgId, projectId: pb.id, runId: run.id, jobKey: "k", name: "k" })
      .run(),
  ).toThrow();
});

test("repo owner and name are case-insensitive; forge repo id survives renames", () => {
  bindRepo(db, a, { forge: "github", owner: "Acme", repo: "Web", forgeRepoId: "999" });
  expect(
    resolveRepoScope(db, { forge: "github", owner: "ACME", repo: "WEB", forgeRepoId: "999" }),
  ).toEqual(a);
  expect(listRepos(db, a)[0]).toMatchObject({ owner: "acme", repo: "web" });
  // renamed upstream: the id still routes
  expect(
    resolveRepoScope(db, { forge: "github", owner: "acme", repo: "renamed", forgeRepoId: "999" }),
  ).toEqual(a);
  expect(() =>
    bindRepo(db, b, { forge: "github", owner: "other", repo: "x", forgeRepoId: "999" }),
  ).toThrow();
  expect(() => bindRepo(db, b, { forge: "github", owner: "ACME", repo: "web" })).toThrow();
  // two repos without an id do not collide on the id index
  bindRepo(db, b, { forge: "github", owner: "o1", repo: "r1" });
  bindRepo(db, b, { forge: "github", owner: "o2", repo: "r2" });
});

test("resolveRepoScope requires a matching installation when the binding has one", () => {
  bindRepo(db, a, { forge: "github", owner: "acme", repo: "app", installationId: "100" });
  const q = { forge: "github", owner: "acme", repo: "app" } as const;
  expect(resolveRepoScope(db, { ...q, installationId: "100" })).toEqual(a);
  expect(resolveRepoScope(db, { ...q, installationId: "200" })).toBeUndefined();
  expect(resolveRepoScope(db, q)).toBeUndefined();
  // unbound installation (null) still routes by name
  bindRepo(db, b, { forge: "github", owner: "acme", repo: "legacy" });
  expect(resolveRepoScope(db, { forge: "github", owner: "acme", repo: "legacy" })).toEqual(b);
});

test("name fallback never routes to a row bound to a different forge repo id", () => {
  bindRepo(db, a, { forge: "github", owner: "acme", repo: "svc", forgeRepoId: "1" });
  const q = { forge: "github", owner: "acme", repo: "svc" } as const;
  // recreated or taken-over name: different id finds no row, name match has another id
  expect(resolveRepoScope(db, { ...q, forgeRepoId: "2" })).toBeUndefined();
  // no id on the event: cannot prove identity of an id-bound row
  expect(resolveRepoScope(db, q)).toBeUndefined();
  expect(resolveRepoScope(db, { ...q, forgeRepoId: "1" })).toEqual(a);
  // id-less rows still route by name, with or without an incoming id
  bindRepo(db, b, { forge: "github", owner: "acme", repo: "old" });
  expect(
    resolveRepoScope(db, { forge: "github", owner: "acme", repo: "old", forgeRepoId: "7" }),
  ).toEqual(b);
});
