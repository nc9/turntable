// instance_run_summary (#574): per org and project counts of runs by trigger and conclusion, jobs
// by state, infra kinds and sandbox time for the instance administrator; counts only.
import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { systemOrgId } from "../src/audit/failures";
import {
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  type Db,
  listAudit,
  openDatabase,
  type Scope,
} from "../src/db";
import { AGENT_ROLES } from "../src/db/schema";
import { dispatch, type DispatchEnv, registry, type Credential, type Principal } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { mcpTools } from "../src/ops/mcp";
import { mintToken, rawExec } from "./ops-helpers";

type Cell = {
  runs: {
    total: number;
    by_trigger: Record<string, number>;
    by_conclusion: Record<string, number>;
  };
  jobs: Record<string, number>;
  infra_kinds: Record<string, number>;
  sandbox_minutes: number;
  newest_run_at: string | null;
  newest_run_conclusion: string | null;
};
type Out = {
  since: string;
  until: string;
  orgs: (Cell & { org: string; projects: (Cell & { project: string })[] })[];
};

const NOW = Date.parse("2026-06-10T12:00:00Z");
const H = 3_600_000;

let db: Db;
let env: DispatchEnv;
let secret: string;
type Tenant = { orgId: string; web: Required<Scope>; api: Required<Scope> };
let a: Tenant;
let b: Tenant;

const tenant = async (slug: string): Promise<Tenant> => {
  const org = await createOrg(db, { slug, name: slug });
  const web = await createProject(db, { orgId: org.id }, { slug: "web", name: "web" });
  const api = await createProject(db, { orgId: org.id }, { slug: "api", name: "api" });
  return {
    orgId: org.id,
    web: { orgId: org.id, projectId: web.id },
    api: { orgId: org.id, projectId: api.id },
  };
};

// A run whose ref, sha, branch and job name must never be echoed back.
async function seed(
  scope: Required<Scope>,
  o: {
    event: string;
    status: string;
    ageMs?: number;
    tag?: boolean;
    infraKind?: string;
    sandboxMs?: number;
  },
) {
  const run = await createRun(db, scope, {
    workflowPath: ".github/workflows/secret-deploy.yml",
    event: o.event,
    ref: o.tag ? "refs/tags/v9.9.9-private" : "refs/heads/very-private-branch",
    sha: "c0ffee".repeat(6) + "abcd",
    workflowName: "Private Workflow Name",
    headBranch: "very-private-branch",
  });
  const job = (await createJob(db, scope, {
    runId: run.id,
    jobKey: "build",
    name: "Private Job Name",
  }))!;
  const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "fake" }))!;
  const at = NOW - (o.ageMs ?? 1000);
  const start = at;
  const end = at + (o.sandboxMs ?? 0);
  await db.run(async (h) => {
    await rawExec(
      h.orm,
      sql`UPDATE runs SET status = ${o.status}, created_at = ${at} WHERE id = ${run.id}`,
    );
    await rawExec(
      h.orm,
      sql`UPDATE jobs SET state = ${o.status}, created_at = ${at} WHERE id = ${job.id}`,
    );
    await rawExec(
      h.orm,
      sql`UPDATE job_attempts SET state = ${o.status}, created_at = ${at}, infra_kind = ${o.infraKind ?? null},
        sandbox_created_at = ${o.sandboxMs ? start : null}, sandbox_destroyed_at = ${o.sandboxMs ? end : null}
        WHERE id = ${attempt.id}`,
    );
  });
  return { run, job, attempt };
}

beforeEach(async () => {
  db = openDatabase(":memory:");
  env = { registry, db, allowInstance: true, instanceOrgCap: 4, now: () => NOW };
  secret = (await createInstanceTokenFromCli(db, { name: "ops laptop" })).secret;
  a = await tenant("org-a");
  b = await tenant("org-b");
});

const call = (input: Record<string, unknown> = {}, e: DispatchEnv = env) =>
  dispatch(e, { kind: "bearer", token: secret }, "instance_run_summary", input);

const out = async (input: Record<string, unknown> = {}): Promise<Out> => {
  const r = await call(input);
  expect(r.ok).toBe(true);
  return (r.ok ? r.output : undefined) as Out;
};

describe("instance_run_summary", () => {
  test("counts match a seeded set across two orgs and projects", async () => {
    await seed(a.web, { event: "push", status: "success", sandboxMs: 3 * 60_000 });
    await seed(a.web, { event: "push", status: "failure", ageMs: 2 * H });
    await seed(a.web, { event: "push", status: "success", tag: true, ageMs: 3 * H });
    await seed(a.web, {
      event: "pull_request",
      status: "infra_error",
      infraKind: "checkout_auth_failed",
      ageMs: 500,
    });
    await seed(a.web, {
      event: "pull_request",
      status: "infra_error",
      infraKind: "checkout_auth_failed",
      ageMs: 4 * H,
    });
    await seed(a.web, { event: "merge_group", status: "cancelled", ageMs: 5 * H });
    await seed(a.api, { event: "workflow_dispatch", status: "skipped", ageMs: 6 * H });
    await seed(a.api, { event: "schedule", status: "awaiting_approval", ageMs: 7 * H });
    await seed(a.api, { event: "push", status: "running", sandboxMs: 2 * 60_000 });
    await seed(a.api, { event: "push", status: "queued", ageMs: 10 });
    await seed(b.web, { event: "pull_request", status: "success", ageMs: 8 * H });
    await seed(b.web, {
      event: "push",
      status: "failure",
      ageMs: 9 * H,
      infraKind: "provider_unavailable",
    });

    const o = await out();
    expect(o.orgs.map((x) => x.org)).toEqual(["org-a", "org-b"]);
    const oa = o.orgs[0]!;
    expect(oa.runs.total).toBe(10);
    expect(oa.runs.by_trigger).toEqual({
      push: 4,
      pull_request: 2,
      merge_group: 1,
      workflow_dispatch: 1,
      tag: 1,
      other: 1,
    });
    expect(oa.runs.by_conclusion).toEqual({
      success: 2,
      failure: 1,
      infra_error: 2,
      cancelled: 1,
      skipped: 1,
      awaiting_approval: 1,
      running: 1,
      queued: 1,
    });
    expect(oa.jobs).toEqual({
      queued: 1,
      running: 1,
      success: 2,
      failure: 1,
      infra_error: 2,
      awaiting_approval: 1,
      cancelled: 1,
      skipped: 1,
    });
    expect(oa.infra_kinds).toEqual({ checkout_auth_failed: 2 });
    expect(oa.sandbox_minutes).toBe(5);
    expect(oa.newest_run_conclusion).toBe("queued");
    expect(oa.newest_run_at).toBe(new Date(NOW - 10).toISOString());
    const [pweb, papi] = [
      oa.projects.find((p) => p.project === "web")!,
      oa.projects.find((p) => p.project === "api")!,
    ];
    expect(pweb.runs.total).toBe(6);
    expect(pweb.runs.by_trigger.tag).toBe(1);
    expect(pweb.runs.by_trigger.push).toBe(2);
    expect(pweb.sandbox_minutes).toBe(3);
    expect(pweb.newest_run_conclusion).toBe("infra_error");
    expect(papi.runs.total).toBe(4);
    expect(papi.runs.by_trigger.other).toBe(1);
    expect(papi.sandbox_minutes).toBe(2);
    expect(papi.infra_kinds).toEqual({});
    const ob = o.orgs[1]!;
    expect(ob.runs.total).toBe(2);
    expect(ob.runs.by_conclusion.success).toBe(1);
    expect(ob.runs.by_conclusion.failure).toBe(1);
    expect(ob.infra_kinds).toEqual({});
    expect(ob.projects.find((p) => p.project === "api")!.runs.total).toBe(0);
    expect(ob.projects.find((p) => p.project === "api")!.newest_run_at).toBeNull();
  });

  test("an infra_error attempt with no recorded kind counts as unknown", async () => {
    await seed(a.web, { event: "push", status: "infra_error" });
    expect((await out()).orgs[0]!.infra_kinds).toEqual({ unknown: 1 });
  });

  test("target_org and target_project narrow the answer", async () => {
    await seed(a.web, { event: "push", status: "success" });
    await seed(a.api, { event: "push", status: "failure" });
    await seed(b.web, { event: "push", status: "success" });
    const one = await out({ target_org: "org-a" });
    expect(one.orgs.map((x) => x.org)).toEqual(["org-a"]);
    expect(one.orgs[0]!.runs.total).toBe(2);
    const proj = await out({ target_org: "org-a", target_project: "api" });
    expect(proj.orgs[0]!.projects.map((p) => p.project)).toEqual(["api"]);
    expect(proj.orgs[0]!.runs.total).toBe(1);
    expect(proj.orgs[0]!.runs.by_conclusion.failure).toBe(1);
    for (const input of [
      { target_org: "nope" },
      { target_org: "org-a", target_project: "nope" },
      { target_project: "api" },
    ]) {
      const r = await call(input);
      expect(r.ok).toBe(false);
    }
  });

  test("since bounds the window; older runs are excluded; over 7 days is refused", async () => {
    await seed(a.web, { event: "push", status: "success", ageMs: 2 * H });
    await seed(a.web, { event: "push", status: "success", ageMs: 30 * H });
    await seed(a.web, { event: "push", status: "success", ageMs: 6 * 86_400_000 });
    expect((await out()).orgs[0]!.runs.total).toBe(1);
    expect((await out({ since: "1h" })).orgs[0]!.runs.total).toBe(0);
    expect((await out({ since: "48h" })).orgs[0]!.runs.total).toBe(2);
    expect((await out({ since: "7d" })).orgs[0]!.runs.total).toBe(3);
    const iso = new Date(NOW - 3 * H).toISOString();
    const o = await out({ since: iso });
    expect(o.orgs[0]!.runs.total).toBe(1);
    expect(o.since).toBe(iso);
    for (const since of ["8d", "169h", new Date(NOW - 8 * 86_400_000).toISOString(), "yesterday"]) {
      const r = await call({ since });
      expect(r.ok, since).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    }
  });

  test("the output has no sha, branch, ref, job or workflow name, or id", async () => {
    const q = await seed(a.web, {
      event: "push",
      status: "failure",
      tag: true,
      infraKind: "checkout_auth_failed",
    });
    const r = await call();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = JSON.stringify(r.output);
    for (const leak of [
      q.run.id,
      q.job.id,
      q.attempt.id,
      "very-private-branch",
      "v9.9.9",
      "refs/",
      "c0ffee",
      "Private Workflow Name",
      "Private Job Name",
      "secret-deploy",
      ".yml",
    ]) {
      expect(text).not.toContain(leak);
    }
    expect(r.untrusted).toBe(false);
  });

  test("is audited as a read in the system chain", async () => {
    await call();
    const rows = await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 50 });
    const mine = rows.filter((x) => x.op === "instance_run_summary");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((x) => x.effect === "read")).toBe(true);
  });

  test("org tokens of every role, members, agents and MCP are refused", async () => {
    for (const t of [a, b]) {
      const creds: Credential[] = [];
      for (const role of AGENT_ROLES) {
        creds.push({
          kind: "bearer",
          token: (await mintToken(db, { orgId: t.orgId }, role)).secret,
        });
      }
      const owner: Principal = {
        kind: "member",
        id: `o-${t.orgId}`,
        orgId: t.orgId,
        role: "owner",
      };
      creds.push({ kind: "principal", principal: owner });
      for (const cred of creds) {
        const r = await dispatch(env, cred, "instance_run_summary", {});
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("forbidden");
      }
    }
    const op = registry.ops.find((o) => o.name === "instance_run_summary")!;
    expect(op.mcp).toBe(false);
    expect(op.effect).toBe("read");
    expect(mcpTools(registry).map((t) => t.name)).not.toContain("instance_run_summary");
    const plain = await dispatch(
      { registry, db },
      { kind: "bearer", token: secret },
      "instance_run_summary",
      {},
    );
    expect(!plain.ok && plain.error.code).toBe("unauthenticated");
  });
});
