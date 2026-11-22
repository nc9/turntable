// Repos for agent access (tokens, audit) and the read queries behind the operations registry.
// Like index.ts, this is part of the only code allowed to name tenant tables.
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import type { AgentRole, JobState } from "../schema";
import { ulid } from "../ulid";
import { type Scope, scoped } from "./scope";

export type ApiToken = typeof s.apiTokens.$inferSelect;

// ---- tokens ----

const TOKEN_COLS = { orgId: s.apiTokens.orgId, projectId: s.apiTokens.projectId };

/** Stores a token by hash. `scope.projectId` narrows it to one project; absent means the org. */
export function insertApiToken(
  db: Db,
  scope: Scope,
  input: {
    name: string;
    role: AgentRole;
    tokenHash: string;
    createdBy: string;
    expiresAt?: number | undefined;
  },
): Promise<ApiToken> {
  return db.run(async (h) => {
    const id = ulid();
    await h.orm.insert(s.apiTokens).values({
      id,
      orgId: scope.orgId,
      projectId: scope.projectId ?? null,
      name: input.name,
      role: input.role,
      tokenHash: input.tokenHash,
      createdBy: input.createdBy,
      expiresAt: input.expiresAt ?? null,
    });
    const [row] = await h.orm
      .select()
      .from(s.apiTokens)
      .where(scoped(scope, TOKEN_COLS, eq(s.apiTokens.id, id)))
      .limit(1);
    return row!;
  });
}

/**
 * Authentication lookup: resolves a token hash to its row. Intentionally unscoped (the caller
 * has no tenant yet; the token IS the proof of one). Revoked and expired tokens are the
 * caller's check, so it can report them distinctly in the audit trail.
 */
export function findApiTokenByHash(db: Db, tokenHash: string): Promise<ApiToken | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.apiTokens)
      .where(eq(s.apiTokens.tokenHash, tokenHash))
      .limit(1);
    return row;
  });
}

/** Tokens of an org (or one project), newest first. Never includes the secret; the hash is not selected out. */
export function listApiTokens(db: Db, scope: Scope): Promise<ApiToken[]> {
  return db.run((h) =>
    h.orm.select().from(s.apiTokens).where(scoped(scope, TOKEN_COLS)).orderBy(desc(s.apiTokens.id)),
  );
}

/**
 * CLI only: finds a token by id across orgs. The caller is the local operator holding the data
 * directory, the trust root; no network path may use this.
 */
export function findApiTokenById(db: Db, id: string): Promise<ApiToken | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm.select().from(s.apiTokens).where(eq(s.apiTokens.id, id)).limit(1);
    return row;
  });
}

export function touchApiToken(db: Db, scope: Scope, id: string, at: number): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .update(s.apiTokens)
      .set({ lastUsedAt: at })
      .where(scoped(scope, TOKEN_COLS, eq(s.apiTokens.id, id)));
  });
}

/** Revokes a token. Returns false when it is not in scope or was already revoked. */
export function revokeApiToken(db: Db, scope: Scope, id: string, at: number): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.apiTokens)
      .set({ revokedAt: at })
      .where(scoped(scope, TOKEN_COLS, eq(s.apiTokens.id, id), isNull(s.apiTokens.revokedAt)))
      .returning({ id: s.apiTokens.id });
    return rows.length > 0;
  });
}

export function getOrgById(db: Db, id: string) {
  return db.run(async (h) => {
    const [org] = await h.orm.select().from(s.orgs).where(eq(s.orgs.id, id)).limit(1);
    return org;
  });
}

// ---- audit ----

const AUDIT_INPUT_MAX = 2048;

export function appendAudit(
  db: Db,
  scope: Scope,
  entry: {
    principalKind: string;
    principalId: string;
    op: string;
    effect: string;
    outcome: string;
    input: unknown;
  },
): Promise<void> {
  return db.run(async (h) => {
    let input = JSON.stringify(entry.input ?? null);
    if (input.length > AUDIT_INPUT_MAX) input = `${input.slice(0, AUDIT_INPUT_MAX)}...(truncated)`;
    await h.orm.insert(s.auditLog).values({
      id: ulid(),
      orgId: scope.orgId,
      projectId: scope.projectId ?? null,
      principalKind: entry.principalKind,
      principalId: entry.principalId,
      op: entry.op,
      effect: entry.effect,
      outcome: entry.outcome,
      input,
    });
  });
}

export function listAudit(db: Db, scope: Scope, opts: { limit?: number } = {}) {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.auditLog)
      .where(scoped(scope, { orgId: s.auditLog.orgId, projectId: s.auditLog.projectId }))
      .orderBy(desc(s.auditLog.id))
      .limit(opts.limit ?? 50),
  );
}

// ---- read queries for operations ----

const RUN_COLS = { orgId: s.runs.orgId, projectId: s.runs.projectId };

export type RunRow = typeof s.runs.$inferSelect & { projectSlug: string };

export type RunFilter = {
  /** Branch name; matches `ref` as given or as `refs/heads/<branch>`. */
  branch?: string | undefined;
  sha?: string | undefined;
  event?: string | undefined;
  state?: JobState | undefined;
  /** Epoch ms; runs created at or after. */
  since?: number | undefined;
  /** Return runs with an id below this (ids sort by creation). */
  beforeId?: string | undefined;
  limit: number;
};

/** Newest first. Fetches `limit` rows; the caller asks for one extra to detect a next page. */
export function queryRuns(db: Db, scope: Scope, f: RunFilter): Promise<RunRow[]> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({ run: s.runs, projectSlug: s.projects.slug })
      .from(s.runs)
      .innerJoin(
        s.projects,
        and(eq(s.projects.id, s.runs.projectId), eq(s.projects.orgId, s.runs.orgId)),
      )
      .where(
        scoped(
          scope,
          RUN_COLS,
          f.branch === undefined
            ? undefined
            : inArray(s.runs.ref, [f.branch, `refs/heads/${f.branch}`]),
          f.sha === undefined ? undefined : eq(s.runs.sha, f.sha),
          f.event === undefined ? undefined : eq(s.runs.event, f.event),
          f.state === undefined ? undefined : eq(s.runs.status, f.state),
          f.since === undefined ? undefined : gte(s.runs.createdAt, f.since),
          f.beforeId === undefined ? undefined : lt(s.runs.id, f.beforeId),
        ),
      )
      .orderBy(desc(s.runs.id))
      .limit(f.limit);
    return rows.map((r) => ({ ...r.run, projectSlug: r.projectSlug }));
  });
}

export async function getRunRow(db: Db, scope: Scope, id: string): Promise<RunRow | undefined> {
  return db.run(async (h) => {
    const [r] = await h.orm
      .select({ run: s.runs, projectSlug: s.projects.slug })
      .from(s.runs)
      .innerJoin(
        s.projects,
        and(eq(s.projects.id, s.runs.projectId), eq(s.projects.orgId, s.runs.orgId)),
      )
      .where(scoped(scope, RUN_COLS, eq(s.runs.id, id)))
      .limit(1);
    return r ? { ...r.run, projectSlug: r.projectSlug } : undefined;
  });
}

/** All attempts of all jobs of a run, in job then attempt order. */
export function listRunAttempts(db: Db, scope: Scope, runId: string) {
  return db.run((h) =>
    h.orm
      .select({ attempt: s.jobAttempts })
      .from(s.jobAttempts)
      .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobs.runId, runId),
          eq(s.jobs.orgId, s.jobAttempts.orgId),
        ),
      )
      .orderBy(asc(s.jobs.id), asc(s.jobAttempts.attempt))
      .then((rows) => rows.map((r) => r.attempt)),
  );
}

/** Runs for a commit, newest first, capped. Optionally one project. */
export function runsForSha(db: Db, scope: Scope, sha: string, cap = 200): Promise<RunRow[]> {
  return queryRuns(db, scope, { sha, limit: cap });
}

/** Total bytes of an attempt's log (0 when none or out of scope). */
export function logSize(db: Db, scope: Scope, attemptId: string): Promise<number> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({
        size: sql<number | null>`max(${s.logChunks.offset} + length(${s.logChunks.bytes}))`,
      })
      .from(s.logChunks)
      .where(
        scoped(
          scope,
          { orgId: s.logChunks.orgId, projectId: s.logChunks.projectId },
          eq(s.logChunks.attemptId, attemptId),
        ),
      );
    return Number(row?.size ?? 0);
  });
}

/**
 * Bytes `[from, to)` of an attempt's log, assembled from the chunks that overlap the range.
 * Gaps (chunks not yet arrived) are skipped, so the result may be shorter than asked.
 */
export function readLogRange(
  db: Db,
  scope: Scope,
  attemptId: string,
  from: number,
  to: number,
): Promise<Buffer> {
  return db.run(async (h) => {
    if (to <= from) return Buffer.alloc(0);
    const chunks = await h.orm
      .select({ offset: s.logChunks.offset, bytes: s.logChunks.bytes })
      .from(s.logChunks)
      .where(
        scoped(
          scope,
          { orgId: s.logChunks.orgId, projectId: s.logChunks.projectId },
          eq(s.logChunks.attemptId, attemptId),
          lt(s.logChunks.offset, to),
          sql`${s.logChunks.offset} + length(${s.logChunks.bytes}) > ${from}`,
        ),
      )
      .orderBy(asc(s.logChunks.offset));
    const parts: Buffer[] = [];
    for (const c of chunks) {
      const start = Math.max(from, c.offset) - c.offset;
      const end = Math.min(to, c.offset + c.bytes.length) - c.offset;
      if (end > start) parts.push(c.bytes.subarray(start, end));
    }
    return Buffer.concat(parts);
  });
}
