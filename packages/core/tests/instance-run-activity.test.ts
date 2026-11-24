// instance_run_activity (#447): per-org counts of runs, jobs and running attempts for the
// instance administrator, counts only, audited as a read in the system chain.
import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { systemOrgId } from "../src/audit/failures";
import {
  claimNextAttempt,
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  type Db,
  listAudit,
  openDatabase,
  type Scope,
  transitionJob,
} from "../src/db";
import { AGENT_ROLES } from "../src/db/schema";
import { dispatch, type DispatchEnv, registry, type Credential, type Principal } from "../src/ops";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { mcpTools } from "../src/ops/mcp";
import { mintToken, rawExec } from "./ops-helpers";

type Out = {
  orgs: {
    org: string;
    runs: { queued: number; running: number; awaiting_approval: number };
    jobs: { queued: number; running: number; awaiting_approval: number };
    running_attempts: number;
    oldest_running_started_at: string | null;
  }[];
  total_running_attempts: number;
  orgs_with_running_attempts: number;
};

let db: Db;
let env: DispatchEnv;
let secret: string;
let a: { orgId: string; scope: Required<Scope> };
let b: { orgId: string; scope: Required<Scope> };

const tenant = async (slug: string) => {
  const org = await createOrg(db, { slug, name: slug });
  const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "app" });
  return { orgId: org.id, scope: { orgId: org.id, projectId: project.id } };
};

// A real-looking run whose ref, sha and workflow name must never be echoed back.
async function queue(scope: Required<Scope>, key: string) {
  const run = await createRun(db, scope, {
    workflowPath: ".github/workflows/secret-deploy.yml",
    event: "push",
    ref: "refs/heads/very-private-branch",
    sha: "c0ffee".repeat(6) + "abcd",
    workflowName: "Private Workflow Name",
    commitMessage: "private commit message",
  });
  const job = (await createJob(db, scope, { runId: run.id, jobKey: key, name: key }))!;
  const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "fake" }))!;
  return { run, job, attempt };
}

const setRunStatus = (id: string, status: string) =>
  db.run((h) => rawExec(h.orm, sql`UPDATE runs SET status = ${status} WHERE id = ${id}`));

beforeEach(async () => {
  db = openDatabase(":memory:");
  env = { registry, db, allowInstance: true, instanceOrgCap: 4 };
  secret = (await createInstanceTokenFromCli(db, { name: "ops laptop" })).secret;
  a = await tenant("org-a");
  b = await tenant("org-b");
});

const call = (e: DispatchEnv = env) =>
  dispatch(e, { kind: "bearer", token: secret }, "instance_run_activity", {});

describe("instance_run_activity", () => {
  test("counts are correct across two orgs", async () => {
    // org-a: two running (claimed first, while they are the only queued work), then one more
    // queued and one held; org-b: one queued run.
    const a1 = await queue(a.scope, "j1");
    const a2 = await queue(a.scope, "j2");
    const before = Date.now();
    const claim = (now: number) =>
      claimNextAttempt(db, { owner: "w", leaseMs: 60_000, now, globalCap: 9, perOrgCap: 9 });
    await claim(before);
    await claim(before + 1000);
    const after = Date.now();
    await queue(a.scope, "j3");
    const a4 = await queue(a.scope, "j4");
    await transitionJob(db, a.scope, a4.job.id, "awaiting_approval");
    await setRunStatus(a1.run.id, "running");
    await setRunStatus(a2.run.id, "running");
    await setRunStatus(a4.run.id, "awaiting_approval");
    await queue(b.scope, "j1");

    const r = await call();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.output as Out;
    const byOrg = new Map(out.orgs.map((o) => [o.org, o]));
    expect([...byOrg.keys()].toSorted()).toEqual(["org-a", "org-b"]);
    const oa = byOrg.get("org-a")!;
    expect(oa.jobs).toEqual({ queued: 1, running: 2, awaiting_approval: 1 });
    expect(oa.runs).toEqual({ queued: 1, running: 2, awaiting_approval: 1 });
    expect(oa.running_attempts).toBe(2);
    // The attempts start at the wall clock, so the oldest is between the two readings.
    const oldest = Date.parse(oa.oldest_running_started_at!);
    expect(oldest).toBeGreaterThanOrEqual(before);
    expect(oldest).toBeLessThanOrEqual(after);
    const ob = byOrg.get("org-b")!;
    expect(ob.jobs).toEqual({ queued: 1, running: 0, awaiting_approval: 0 });
    expect(ob.runs).toEqual({ queued: 1, running: 0, awaiting_approval: 0 });
    expect(ob.running_attempts).toBe(0);
    expect(ob.oldest_running_started_at).toBeNull();
    expect(out.total_running_attempts).toBe(2);
    expect(out.orgs_with_running_attempts).toBe(1);
  });

  test("the output has no run ids, refs, shas or content", async () => {
    const q = await queue(a.scope, "j1");
    await claimNextAttempt(db, {
      owner: "w",
      leaseMs: 60_000,
      now: Date.now(),
      globalCap: 9,
      perOrgCap: 9,
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
      "c0ffee",
      "Private Workflow Name",
      "private commit message",
      "secret-deploy",
      ".yml",
    ]) {
      expect(text).not.toContain(leak);
    }
    expect(Object.keys(r.output as object).toSorted()).toEqual([
      "orgs",
      "orgs_with_running_attempts",
      "total_running_attempts",
    ]);
    expect(r.untrusted).toBe(false);
  });

  test("is audited as a read in the system chain", async () => {
    await call();
    const rows = await listAudit(db, { orgId: await systemOrgId(db) }, { limit: 50 });
    const mine = rows.filter((x) => x.op === "instance_run_activity");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((x) => x.effect === "read")).toBe(true);
  });

  test("org tokens of every role, members and MCP are refused", async () => {
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
        const r = await dispatch(env, cred, "instance_run_activity", {});
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("forbidden");
      }
    }
    const op = registry.ops.find((o) => o.name === "instance_run_activity")!;
    expect(op.mcp).toBe(false);
    expect(op.effect).toBe("read");
    expect(mcpTools(registry).map((t) => t.name)).not.toContain("instance_run_activity");
    const plain = await dispatch(
      { registry, db },
      { kind: "bearer", token: secret },
      "instance_run_activity",
      {},
    );
    expect(!plain.ok && plain.error.code).toBe("unauthenticated");
  });
});
