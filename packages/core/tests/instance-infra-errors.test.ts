// instance_infra_errors (#670): the instance administrator reads recent infra_error attempts with
// a sanitized message; org-scoped reads are untouched.
import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
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
import { systemOrgId } from "../src/audit/failures";
import { dispatch, type DispatchEnv, registry } from "../src/ops";
import { sanitizeInfraError } from "../src/ops/definitions/instance";
import { createInstanceTokenFromCli } from "../src/ops/instance-token-cli";
import { mintToken, rawExec } from "./ops-helpers";

const NOW = Date.parse("2026-06-10T12:00:00Z");
const GHP = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
let db: Db;
let env: DispatchEnv;
let secret: string;

async function seed(slug: string, errorClass: string, kind: string | null) {
  const org = await createOrg(db, { slug, name: slug });
  const p = await createProject(db, { orgId: org.id }, { slug: "web", name: "web" });
  const scope: Required<Scope> = { orgId: org.id, projectId: p.id };
  const run = await createRun(db, scope, {
    workflowPath: "w.yml",
    event: "push",
    ref: "main",
    sha: "a".repeat(40),
  });
  const job = (await createJob(db, scope, { runId: run.id, jobKey: "build", name: "build" }))!;
  const at = (await createAttempt(db, scope, { jobId: job.id, provider: "fake" }))!;
  await db.run((h) =>
    rawExec(
      h.orm,
      sql`UPDATE job_attempts SET state = 'infra_error', error_class = ${errorClass},
        infra_kind = ${kind}, created_at = ${NOW - 1000} WHERE id = ${at.id}`,
    ),
  );
  return { org, scope, run };
}

beforeEach(async () => {
  db = openDatabase(":memory:");
  env = { registry, db, allowInstance: true, instanceOrgCap: 4, now: () => NOW };
  secret = (await createInstanceTokenFromCli(db, { name: "ops laptop" })).secret;
});

const call = (input: Record<string, unknown> = {}) =>
  dispatch(env, { kind: "bearer", token: secret }, "instance_infra_errors", input);

describe("instance_infra_errors", () => {
  test("shows an unknown infra error with a sanitized message, never the secret", async () => {
    const t = await seed(
      "org-a",
      `boom token ${GHP} at https://user:pw@example.com/path/x?access_token=abc123#frag done`,
      null,
    );
    const r = await call();
    expect(r.ok).toBe(true);
    const out = (r.ok ? r.output : undefined) as { errors: Record<string, unknown>[] };
    expect(out.errors).toHaveLength(1);
    const e = out.errors[0]!;
    expect(e).toMatchObject({
      org: "org-a",
      project: "web",
      run_id: t.run.id,
      job_key: "build",
      attempt: 1,
      infra_kind: "unknown",
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain(GHP);
    expect(text).not.toContain("pw@");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("frag");
    expect(e.error_class).toContain("https://example.com/path/x");
    const audit = await listAudit(db, { orgId: await systemOrgId(db) });
    expect(audit.some((a) => a.op === "instance_infra_errors")).toBe(true);
  });

  test("filters by org, project and run; caps the length", async () => {
    const a = await seed("org-a", "x".repeat(2000), "sandbox_lost");
    await seed("org-b", "other", null);
    const all = (await call()) as { ok: true; output: { errors: { error_class: string }[] } };
    expect(all.output.errors).toHaveLength(2);
    const one = (await call({ target_org: "org-a", target_project: "web", run_id: a.run.id })) as {
      ok: true;
      output: { errors: { error_class: string; infra_kind: string }[] };
    };
    expect(one.output.errors).toHaveLength(1);
    expect(one.output.errors[0]!.error_class.length).toBeLessThanOrEqual(503);
    expect(one.output.errors[0]!.infra_kind).toBe("sandbox_lost");
    expect((await call({ target_org: "nope" })).ok).toBe(false);
    expect((await call({ target_project: "web" })).ok).toBe(false);
  });

  test("an org token cannot call it", async () => {
    const t = await seed("org-c", "e", null);
    const tok = await mintToken(db, t.scope, "operator");
    const r = await dispatch(
      env,
      { kind: "bearer", token: tok.secret },
      "instance_infra_errors",
      {},
    );
    expect(r.ok).toBe(false);
  });

  test("sanitizer folds control characters and strips URL queries", () => {
    expect(sanitizeInfraError("a\nb\u0000c http://h/p?q=1")).toBe("a b c http://h/p");
    expect(sanitizeInfraError(null)).toBe("");
  });
});
