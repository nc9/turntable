// Per-project sandbox settings (the instance operator's): a snapshot override and a concurrency
// cap. The repo functions, the claim-time cap, the ops (instance-only writes, project-scoped read),
// the CLI and tenant isolation. The snapshot reaching a sandbox spec is in worker-workflow.test.ts.
import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { systemOrgId } from "../src/audit/failures";
import {
  claimNextAttempt,
  createAttempt,
  createJob,
  createProject,
  createRun,
  type Db,
  getProjectSandboxSettings,
  listAudit,
  listProjects,
  projectsWithCaps,
  setProjectSandboxSettings,
  type Scope,
} from "../src/db";
import { AGENT_ROLES } from "../src/db/schema";
import { dispatch, type DispatchEnv, registry, type Credential } from "../src/ops";
import { mcpTools } from "../src/ops/mcp";
import { setSandboxPolicy, showSandbox } from "../src/ops/policy-cli";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { mintToken, rawExec, seedWorld, type Tenant } from "./ops-helpers";

let db: Db;
let a: Tenant;
let b: Tenant;
let p2: Required<Scope>; // a second project in org a
let env: DispatchEnv;
let secret: string;
const NOW = 1_800_000_000_000;

beforeEach(async () => {
  ({ db, a, b } = await seedWorld());
  const project = await createProject(db, { orgId: a.orgId }, { slug: "second", name: "Second" });
  p2 = { orgId: a.orgId, projectId: project.id };
  env = { registry, db, allowInstance: true, instanceOrgCap: 4 };
  secret = (await createInstanceTokenFromCli(db, { name: "ops" })).secret;
  // start from a clean slate: seedWorld leaves one queued attempt per tenant
  await db.run(async (h) => {
    await rawExec(h.orm, sql`update job_attempts set state = 'success'`);
    await rawExec(h.orm, sql`update jobs set state = 'success'`);
  });
});

const asInstance = (name: string, input: Record<string, unknown> = {}) =>
  dispatch(env, { kind: "bearer", token: secret }, name, input);

async function queued(scope: Scope, tag: string) {
  const run = await createRun(db, scope as Required<Scope>, {
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    ref: "refs/heads/main",
    sha: tag.padEnd(40, "0").slice(0, 40),
    repo: "acme/web",
  });
  const job = (await createJob(db, scope as Required<Scope>, {
    runId: run.id,
    jobKey: "j",
    name: "j",
  }))!;
  await createAttempt(db, scope as Required<Scope>, { jobId: job.id, provider: "test" });
}
const claim = (perOrgCap = 10) =>
  claimNextAttempt(db, { owner: "w", leaseMs: 10_000, now: NOW, globalCap: 50, perOrgCap });
async function claimAll(perOrgCap = 10): Promise<string[]> {
  const got: string[] = [];
  for (let i = 0; i < 12; i++) {
    const c = await claim(perOrgCap);
    if (c) got.push(c.scope.projectId!);
  }
  return got;
}

describe("the settings", () => {
  test("default to none, set, clear, and are validated", async () => {
    expect(await getProjectSandboxSettings(db, a.scope)).toEqual({
      sandboxSnapshot: null,
      maxConcurrent: null,
    });
    await setProjectSandboxSettings(db, a.scope, {
      sandboxSnapshot: "daytona-large",
      maxConcurrent: 4,
    });
    expect(await getProjectSandboxSettings(db, a.scope)).toEqual({
      sandboxSnapshot: "daytona-large",
      maxConcurrent: 4,
    });
    // naming one leaves the other
    await setProjectSandboxSettings(db, a.scope, { maxConcurrent: null });
    expect(await getProjectSandboxSettings(db, a.scope)).toEqual({
      sandboxSnapshot: "daytona-large",
      maxConcurrent: null,
    });
    for (const bad of ["", "-x", "a b", "a/b", "x".repeat(129), "snap;rm"])
      await expect(
        Promise.resolve().then(() =>
          setProjectSandboxSettings(db, a.scope, { sandboxSnapshot: bad }),
        ),
        bad,
      ).rejects.toThrow(/snapshot name/);
    await expect(
      Promise.resolve().then(() => setProjectSandboxSettings(db, a.scope, { maxConcurrent: -1 })),
    ).rejects.toThrow(/maxConcurrent/);
  });

  test("one project's settings never touch another's, in the same org or another", async () => {
    await setProjectSandboxSettings(db, a.scope, { sandboxSnapshot: "snap-a", maxConcurrent: 2 });
    expect(await getProjectSandboxSettings(db, p2)).toEqual({
      sandboxSnapshot: null,
      maxConcurrent: null,
    });
    expect(await getProjectSandboxSettings(db, b.scope)).toEqual({
      sandboxSnapshot: null,
      maxConcurrent: null,
    });
    // org B's scope cannot write org A's project: the org id is part of the match
    const crossed = { orgId: b.orgId, projectId: a.projectId };
    expect(
      await setProjectSandboxSettings(db, crossed, { sandboxSnapshot: "evil" }),
    ).toBeUndefined();
    expect((await getProjectSandboxSettings(db, a.scope)).sandboxSnapshot).toBe("snap-a");
    expect(await projectsWithCaps(db)).toEqual(new Map([[a.projectId, 2]]));
  });
});

describe("the cap at claim", () => {
  test("a project at its cap holds new work; another project of the same org still runs", async () => {
    await setProjectSandboxSettings(db, a.scope, { maxConcurrent: 1 });
    for (const t of ["a1", "a2", "a3"]) await queued(a.scope, t);
    for (const t of ["p1", "p2", "p3"]) await queued(p2, t);
    const got = await claimAll();
    expect(got.filter((p) => p === a.projectId)).toHaveLength(1);
    expect(got.filter((p) => p === p2.projectId)).toHaveLength(3);
  });

  test("a capped project's queued attempts do not hide another project's ready one", async () => {
    await setProjectSandboxSettings(db, a.scope, { maxConcurrent: 0 });
    for (let i = 0; i < 40; i++) await queued(a.scope, `h${i}`);
    await queued(p2, "later");
    const c = await claimNextAttempt(db, {
      owner: "w",
      leaseMs: 10_000,
      now: NOW,
      globalCap: 50,
      perOrgCap: 10,
      pageSize: 5,
      scanLimit: 5,
    });
    expect(c?.scope.projectId).toBe(p2.projectId);
  });

  test("it can only lower the instance's per-org cap; clearing it releases the project", async () => {
    await setProjectSandboxSettings(db, a.scope, { maxConcurrent: 50 });
    for (let i = 0; i < 4; i++) await queued(a.scope, `c${i}`);
    expect((await claimAll(2)).filter((p) => p === a.projectId)).toHaveLength(2);
    await setProjectSandboxSettings(db, a.scope, { maxConcurrent: 0 });
    expect(await claimAll(10)).toEqual([]); // held, even with room
    await setProjectSandboxSettings(db, a.scope, { maxConcurrent: null });
    expect((await claimAll(10)).length).toBeGreaterThan(0);
  });

  test("a project with no cap and no row behaves as before", async () => {
    for (let i = 0; i < 3; i++) await queued(a.scope, `n${i}`);
    expect(await claimAll(10)).toHaveLength(3);
  });
});

describe("the operations", () => {
  test("set_project_settings: instance token only, audited in the system chain and the org's, clamped to the instance cap", async () => {
    const r = await asInstance("set_project_settings", {
      target_org: "org-a",
      target_project: "app",
      sandbox_snapshot: "daytona-large",
      max_concurrent: 4,
    });
    expect(r.ok && r.output).toMatchObject({
      sandbox_snapshot: "daytona-large",
      max_concurrent: 4,
    });
    expect(await getProjectSandboxSettings(db, a.scope)).toEqual({
      sandboxSnapshot: "daytona-large",
      maxConcurrent: 4,
    });
    expect(await getProjectSandboxSettings(db, b.scope)).toEqual({
      sandboxSnapshot: null,
      maxConcurrent: null,
    });
    const sys = (await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 50 })).find(
      (x) => x.op === "set_project_settings",
    );
    expect(sys).toMatchObject({ principalKind: "instance", outcome: "ok" });
    const own = (await listAudit(db, { orgId: a.orgId }, { limit: 50 })).find(
      (x) => x.op === "set_project_settings",
    );
    expect(own).toMatchObject({ principalKind: "instance", outcome: "ok" });
    expect(JSON.parse(own!.input)).toMatchObject({
      target_project: "app",
      to: { sandboxSnapshot: "daytona-large", maxConcurrent: 4 },
    });
    // above the instance cap is refused; nothing named is refused; a bad name is refused
    const over = await asInstance("set_project_settings", {
      target_org: "org-a",
      target_project: "app",
      max_concurrent: 5,
    });
    expect(!over.ok && over.error.code).toBe("invalid_input");
    const none = await asInstance("set_project_settings", {
      target_org: "org-a",
      target_project: "app",
    });
    expect(!none.ok && none.error.code).toBe("invalid_input");
    const bad = await asInstance("set_project_settings", {
      target_org: "org-a",
      target_project: "app",
      sandbox_snapshot: "no spaces",
    });
    expect(!bad.ok && bad.error.code).toBe("invalid_input");
    // null removes
    await asInstance("set_project_settings", {
      target_org: "org-a",
      target_project: "app",
      sandbox_snapshot: null,
      max_concurrent: null,
    });
    expect(await getProjectSandboxSettings(db, a.scope)).toEqual({
      sandboxSnapshot: null,
      maxConcurrent: null,
    });
  });

  test("an unknown org or project, and the system org, are the same not_found", async () => {
    for (const input of [
      { target_org: "nope", target_project: "app" },
      { target_org: "org-a", target_project: "nope" },
      { target_org: "org-b", target_project: "second" }, // exists only in org a
    ]) {
      const r = await asInstance("set_project_settings", { ...input, max_concurrent: 1 });
      expect(!r.ok && r.error.code, JSON.stringify(input)).toBe("not_found");
    }
  });

  test("no org token of any role, no member, and no MCP session can set; set is not an MCP tool", async () => {
    const creds: Credential[] = [];
    for (const t of [a, b])
      for (const role of AGENT_ROLES)
        creds.push({
          kind: "bearer",
          token: (await mintToken(db, { orgId: t.orgId }, role)).secret,
        });
    creds.push({ kind: "principal", principal: a.admin });
    for (const cred of creds) {
      const r = await dispatch(env, cred, "set_project_settings", {
        target_org: "org-a",
        target_project: "app",
        max_concurrent: 1,
      });
      expect(!r.ok && r.error.code).toBe("forbidden");
    }
    expect(registry.get("set_project_settings")?.auth.type).toBe("instance");
    expect(mcpTools(registry).map((x) => x.name)).not.toContain("set_project_settings");
    expect(await getProjectSandboxSettings(db, a.scope)).toEqual({
      sandboxSnapshot: null,
      maxConcurrent: null,
    });
  });

  test("get_project_settings: a reader of the project sees its own; another org's project is not found", async () => {
    await setProjectSandboxSettings(db, a.scope, { sandboxSnapshot: "snap-a", maxConcurrent: 3 });
    await setProjectSandboxSettings(db, b.scope, { sandboxSnapshot: "snap-b" });
    const mine = await mintToken(db, a.scope, "reader");
    const r = await dispatch(
      env,
      { kind: "bearer", token: mine.secret },
      "get_project_settings",
      {},
    );
    expect(r.ok && r.output).toMatchObject({ sandbox_snapshot: "snap-a", max_concurrent: 3 });
    const orgTok = await mintToken(db, { orgId: a.orgId }, "reader");
    const r2 = await dispatch(
      env,
      { kind: "bearer", token: orgTok.secret },
      "get_project_settings",
      { project: "app" },
    );
    expect(r2.ok && r2.output).toMatchObject({ sandbox_snapshot: "snap-a" });
    // org A's token cannot name org B's project, and a project token cannot name a sibling
    const r3 = await dispatch(
      env,
      { kind: "bearer", token: orgTok.secret },
      "get_project_settings",
      { org: "org-b", project: "app" },
    );
    expect(r3.ok).toBe(false);
    const r4 = await dispatch(env, { kind: "bearer", token: mine.secret }, "get_project_settings", {
      project: "second",
    });
    expect(r4.ok).toBe(false);
    expect(JSON.stringify(r3) + JSON.stringify(r4)).not.toContain("snap-b");
  });
});

describe("create_project", () => {
  test("an instance token makes a project (audited in both chains), then it can be given settings; conflicts and bad slugs are refused", async () => {
    const r = await asInstance("create_project", {
      target_org: "org-a",
      slug: "dogfood",
      name: "Dogfood",
    });
    expect(r.ok && r.output).toMatchObject({ org: "org-a", project: "dogfood", name: "Dogfood" });
    expect((await listProjects(db, { orgId: a.orgId })).map((p) => p.slug)).toContain("dogfood");
    const s = await asInstance("set_project_settings", {
      target_org: "org-a",
      target_project: "dogfood",
      sandbox_snapshot: "daytona-large",
      max_concurrent: 4,
    });
    expect(s.ok && s.output).toMatchObject({
      sandbox_snapshot: "daytona-large",
      max_concurrent: 4,
    });
    const sys = (await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 50 })).find(
      (x) => x.op === "create_project",
    );
    expect(sys).toMatchObject({ principalKind: "instance", outcome: "ok" });
    const own = (await listAudit(db, { orgId: a.orgId }, { limit: 50 })).find(
      (x) => x.op === "create_project",
    );
    expect(own).toMatchObject({ principalKind: "instance", outcome: "ok" });
    const dup = await asInstance("create_project", {
      target_org: "org-a",
      slug: "dogfood",
      name: "again",
    });
    expect(!dup.ok && dup.error.code).toBe("conflict");
    // the same slug in another org is a different project
    expect(
      (await asInstance("create_project", { target_org: "org-b", slug: "dogfood", name: "b" })).ok,
    ).toBe(true);
    for (const slug of ["Bad", "-x", "a_b", "a b", "x".repeat(64)]) {
      const bad = await asInstance("create_project", { target_org: "org-a", slug, name: "x" });
      expect(!bad.ok && bad.error.code, slug).toBe("invalid_input");
    }
    const none = await asInstance("create_project", { target_org: "nope", slug: "x", name: "x" });
    expect(!none.ok && none.error.code).toBe("not_found");
  });

  test("no org token of any role, no member, and no MCP session can create a project", async () => {
    const creds: Credential[] = [];
    for (const t of [a, b])
      for (const role of AGENT_ROLES)
        creds.push({
          kind: "bearer",
          token: (await mintToken(db, { orgId: t.orgId }, role)).secret,
        });
    creds.push({ kind: "principal", principal: a.admin });
    for (const cred of creds) {
      const r = await dispatch(env, cred, "create_project", {
        target_org: "org-a",
        slug: "sneaky",
        name: "x",
      });
      expect(!r.ok && r.error.code).toBe("forbidden");
    }
    expect(mcpTools(registry).map((x) => x.name)).not.toContain("create_project");
    expect((await listProjects(db, { orgId: a.orgId })).map((p) => p.slug)).not.toContain("sneaky");
  });
});

describe("the CLI", () => {
  test("policy set --sandbox-snapshot / --max-concurrent sets, audits and shows; none clears; bad values are refused", async () => {
    const r = await setSandboxPolicy(db, "org-a", "app", {
      sandboxSnapshot: "daytona-large",
      maxConcurrent: "4",
    });
    expect(r.to).toEqual({ sandboxSnapshot: "daytona-large", maxConcurrent: 4 });
    expect((await showSandbox(db, "org-a")).find((x) => x.project === "app")?.settings).toEqual(
      r.to,
    );
    const audit = (await listAudit(db, a.scope, { limit: 20 })).find((x) => x.op === "policy_set");
    expect(JSON.parse(audit!.input)).toMatchObject({
      key: "sandbox",
      to: { sandboxSnapshot: "daytona-large" },
    });
    await setSandboxPolicy(db, "org-a", "app", { sandboxSnapshot: "none", maxConcurrent: "none" });
    expect(await getProjectSandboxSettings(db, a.scope)).toEqual({
      sandboxSnapshot: null,
      maxConcurrent: null,
    });
    await expect(setSandboxPolicy(db, "org-a", "app", { sandboxSnapshot: "a b" })).rejects.toThrow(
      /snapshot name/,
    );
    await expect(setSandboxPolicy(db, "org-a", "app", { maxConcurrent: "-1" })).rejects.toThrow(
      /whole number/,
    );
    await expect(setSandboxPolicy(db, "org-a", undefined, { maxConcurrent: "1" })).rejects.toThrow(
      /--project/,
    );
    await expect(setSandboxPolicy(db, "org-a", "nope", { maxConcurrent: "1" })).rejects.toThrow(
      /no project/,
    );
    await expect(setSandboxPolicy(db, "org-a", "app", {})).rejects.toThrow(/name --sandbox/);
  });
});
