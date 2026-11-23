import type { SQL } from "drizzle-orm";
import {
  appendLog,
  createAttempt,
  createJob,
  createOrg,
  createProject,
  createRun,
  type Db,
  insertApiToken,
  openDatabase,
  type Scope,
  transitionJob,
} from "../src/db";
import type { AgentRole, TokenKind } from "../src/db/schema";
import { generateToken, hashToken, type Principal } from "../src/ops";

export type Tenant = {
  orgId: string;
  slug: string;
  projectId: string;
  projectSlug: string;
  runId: string;
  jobId: string;
  attemptId: string;
  scope: Required<Scope>;
  admin: Principal;
};

/** Mints a token the way create_api_token does and returns the secret (never a literal). */
export async function mintToken(
  db: Db,
  scope: Scope,
  role: AgentRole,
  opts: { expiresAt?: number; name?: string; kind?: TokenKind } = {},
): Promise<{ secret: string; id: string }> {
  const secret = generateToken();
  const row = await insertApiToken(db, scope, {
    name: opts.name ?? `test-${role}`,
    role,
    ...(opts.kind ? { kind: opts.kind } : {}),
    tokenHash: hashToken(secret),
    createdBy: "test:setup",
    expiresAt: opts.expiresAt,
  });
  return { secret, id: row.id };
}

export async function seedTenant(db: Db, slug: string): Promise<Tenant> {
  const org = await createOrg(db, { slug, name: slug });
  const project = await createProject(db, { orgId: org.id }, { slug: "app", name: "App" });
  const scope = { orgId: org.id, projectId: project.id };
  const run = await createRun(db, scope, {
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
    ref: "refs/heads/main",
    sha: "a".repeat(40),
  });
  const job = (await createJob(db, scope, { runId: run.id, jobKey: "build", name: "build" }))!;
  const attempt = (await createAttempt(db, scope, { jobId: job.id, provider: "test" }))!;
  return {
    orgId: org.id,
    slug,
    projectId: project.id,
    projectSlug: "app",
    runId: run.id,
    jobId: job.id,
    attemptId: attempt.id,
    scope,
    admin: { kind: "member", id: `admin-${slug}`, orgId: org.id, role: "admin" },
  };
}

export async function seedWorld(): Promise<{ db: Db; a: Tenant; b: Tenant }> {
  const db = openDatabase(":memory:");
  return { db, a: await seedTenant(db, "org-a"), b: await seedTenant(db, "org-b") };
}

export async function addLog(db: Db, t: Tenant, text: string, at = 0): Promise<number> {
  const bytes = new TextEncoder().encode(text);
  await appendLog(db, t.scope, t.attemptId, at, bytes);
  return at + bytes.length;
}

export { transitionJob };

/** Runs a raw SQL statement on whichever dialect the suite runs on (tests only). */
export async function rawExec(orm: unknown, query: SQL): Promise<void> {
  const o = orm as { execute?: (q: SQL) => Promise<unknown>; run?: (q: SQL) => unknown };
  if (typeof o.execute === "function") await o.execute(query);
  else await o.run!(query);
}

/** Runs a raw SQL query and returns its rows on whichever dialect the suite runs on (tests only). */
export async function rawRows<T>(orm: unknown, query: SQL): Promise<T[]> {
  const o = orm as {
    execute?: (q: SQL) => Promise<unknown>;
    all?: (q: SQL) => Promise<unknown[]> | unknown[];
  };
  if (typeof o.execute === "function") {
    const r = (await o.execute(query)) as T[] | { rows: T[] };
    return Array.isArray(r) ? r : r.rows;
  }
  return (await o.all!(query)) as T[];
}
