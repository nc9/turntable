// Repos for agent access (tokens, audit) and the read queries behind the operations registry.
// Like index.ts, this is part of the only code allowed to name tenant tables.
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "..";
import { DIALECT } from "../dialect";
import * as s from "../schema";
import type { AgentRole, JobState, TokenKind } from "../schema";
import { ulid } from "../ulid";
import { type Scope, scoped } from "./scope";

export type ApiToken = typeof s.apiTokens.$inferSelect;

// ---- tokens ----

const TOKEN_COLS = { orgId: s.apiTokens.orgId, projectId: s.apiTokens.projectId };

/**
 * Serialises token minting and revoking of one org for the rest of the transaction (#437), so a
 * count of active tokens cannot go stale between the check and the write. Take it first in the
 * transaction. On Postgres it is a transaction-scoped advisory lock (a waiter holds an older
 * snapshot, so SERIALIZABLE re-runs it against the winner). SQLite's write transactions are
 * already exclusive, so it is a no-op there, and outside a transaction there is nothing to hold.
 */
export function lockOrgTokens(db: Db, orgId: string): Promise<void> {
  if (DIALECT !== "pg") return Promise.resolve();
  return db.run(async (h) => {
    const orm = h.orm as unknown as { execute(q: unknown): Promise<unknown> };
    await orm.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`tokens:${orgId}`}, 0))`);
  });
}

/** Stores a token by hash. `scope.projectId` narrows it to one project; absent means the org. */
export function insertApiToken(
  db: Db,
  scope: Scope,
  input: {
    name: string;
    role: AgentRole;
    /** Absent means `agent`: a token is only a person's when it was minted as one. */
    kind?: TokenKind | undefined;
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
      kind: input.kind ?? "agent",
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

/** How many tokens of the org are usable at `now`: not revoked, not expired. Project-scoped ones count. */
export function countActiveApiTokens(db: Db, scope: Scope, now: number): Promise<number> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ n: sql<number>`count(*)` })
      .from(s.apiTokens)
      .where(
        scoped(
          scope,
          TOKEN_COLS,
          isNull(s.apiTokens.revokedAt),
          or(isNull(s.apiTokens.expiresAt), gt(s.apiTokens.expiresAt, now)),
        ),
      );
    return Number(row?.n ?? 0);
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

/**
 * Stamps a token's first use. A conditional update (`first_used_at IS NULL`), so of two concurrent
 * first calls exactly one gets `true` and may emit the event. Revoked tokens are never stamped.
 */
export function markApiTokenFirstUsed(
  db: Db,
  scope: Scope,
  id: string,
  at: number,
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.apiTokens)
      .set({ firstUsedAt: at })
      .where(scoped(scope, TOKEN_COLS, eq(s.apiTokens.id, id), isNull(s.apiTokens.firstUsedAt)))
      .returning({ id: s.apiTokens.id });
    return rows.length > 0;
  });
}

/** Active (not revoked, not expired) tokens of the org with this name and role. */
export function countActiveTokensNamed(
  db: Db,
  scope: Scope,
  q: { name: string; role: AgentRole },
  now: number,
): Promise<number> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ n: sql<number>`count(*)` })
      .from(s.apiTokens)
      .where(
        scoped(
          { orgId: scope.orgId },
          TOKEN_COLS,
          eq(s.apiTokens.name, q.name),
          eq(s.apiTokens.role, q.role),
          isNull(s.apiTokens.revokedAt),
          or(isNull(s.apiTokens.expiresAt), gt(s.apiTokens.expiresAt, now)),
        ),
      );
    return Number(row?.n ?? 0);
  });
}

/**
 * The org's token history, revoked and expired rows included (#367): whether it ever had a token,
 * and when the last of them stopped being usable (each token's earlier end, revoked or expired;
 * the latest over all). `lastEnd` is null while a token has no end yet, so only call it for an org
 * with no active token. Derived from existing rows: no extra column.
 */
export function orgTokenHistory(
  db: Db,
  scope: Scope,
): Promise<{ everHad: boolean; lastEnd: number | null }> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({ revokedAt: s.apiTokens.revokedAt, expiresAt: s.apiTokens.expiresAt })
      .from(s.apiTokens)
      .where(scoped(scope, TOKEN_COLS));
    let lastEnd: number | null = null;
    for (const r of rows) {
      const ends = [r.revokedAt, r.expiresAt].filter((x): x is number => x !== null);
      if (ends.length === 0) continue;
      const end = Math.min(...ends);
      if (lastEnd === null || end > lastEnd) lastEnd = end;
    }
    return { everHad: rows.length > 0, lastEnd };
  });
}

type RevokedListener = (tokenId: string) => void;
const revokedListeners = new Set<RevokedListener>();

/**
 * Subscribes to "a token was revoked by this process", fired after the revoking transaction
 * commits. The realtime server closes that token's open sockets on it. In-process only: another
 * process revoking in the same database is not seen, which the sockets' periodic re-check covers.
 */
export function onApiTokenRevoked(listener: RevokedListener): () => void {
  revokedListeners.add(listener);
  return () => revokedListeners.delete(listener);
}

// ---- token lineage (#437) ----
// A token minted by another token records `createdBy = "token:<parentId>"` (only create_api_token
// writes that prefix, from the authenticated principal; every other minting path writes `cli:`,
// `bootstrap:`, `instance:`, `member:` or a test label), so the parent link needs no column.

/** The parent token id a row was minted by, or null for a root token. */
export function parentTokenId(row: { createdBy: string }): string | null {
  return row.createdBy.startsWith("token:") ? row.createdBy.slice("token:".length) : null;
}

/** The hardest bound on a stored mint chain: a token deeper than this cannot be walked or minted from. */
export const MAX_STORED_CHAIN_DEPTH = 64;

/**
 * The lineage of a token (#437). `depth` counts LIVE token-minted ancestors only: the walk for it
 * stops at the first revoked or expired ancestor, so a rotation (mint the successor, self-revoke)
 * starts a fresh live chain and repeated rotation never runs out of depth. `originalRootId` is the
 * top of the STORED `createdBy` chain (the first ancestor not minted by a token), whatever was
 * revoked in between, so self-revoking never resets the lineage a cap is counted against.
 * `tooDeep` is set when the stored chain passes MAX_STORED_CHAIN_DEPTH (the caller refuses).
 * Call under `lockOrgTokens`.
 */
export async function tokenLineage(
  db: Db,
  row: ApiToken,
  now: number,
): Promise<{ depth: number; originalRootId: string; tooDeep: boolean }> {
  let cur = row;
  let depth = 0;
  let liveChain = true;
  for (let steps = 0; ; steps++) {
    const parentId = parentTokenId(cur);
    if (parentId === null) return { depth, originalRootId: cur.id, tooDeep: false };
    if (steps >= MAX_STORED_CHAIN_DEPTH) return { depth, originalRootId: cur.id, tooDeep: true };
    const parent = await findApiTokenById(db, parentId);
    if (!parent || parent.orgId !== row.orgId) {
      return { depth, originalRootId: cur.id, tooDeep: false };
    }
    if (parent.revokedAt !== null || (parent.expiresAt !== null && parent.expiresAt <= now)) {
      liveChain = false;
    }
    if (liveChain) depth += 1;
    cur = parent;
  }
}

/** Tokens minted by `parentId` that are neither revoked nor expired. */
export function countActiveChildTokens(
  db: Db,
  scope: Scope,
  parentId: string,
  now: number,
): Promise<number> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ n: sql<number>`count(*)` })
      .from(s.apiTokens)
      .where(
        scoped(
          scope,
          TOKEN_COLS,
          eq(s.apiTokens.createdBy, `token:${parentId}`),
          isNull(s.apiTokens.revokedAt),
          or(isNull(s.apiTokens.expiresAt), gt(s.apiTokens.expiresAt, now)),
        ),
      );
    return Number(row?.n ?? 0);
  });
}

/** A token and every token it minted, transitively (the root first), revoked or not. */
export function tokenSubtree(db: Db, orgId: string, rootId: string): Promise<ApiToken[]> {
  return db.run(async (h) => {
    const all = await h.orm.select().from(s.apiTokens).where(scoped({ orgId }, TOKEN_COLS));
    const byParent = new Map<string, ApiToken[]>();
    for (const t of all) {
      const p = parentTokenId(t);
      if (p !== null) byParent.set(p, [...(byParent.get(p) ?? []), t]);
    }
    const out: ApiToken[] = [];
    const seen = new Set<string>([rootId]);
    const root = all.find((t) => t.id === rootId);
    if (!root) return out;
    const queue = [root];
    while (queue.length > 0) {
      const t = queue.shift()!;
      out.push(t);
      for (const c of byParent.get(t.id) ?? []) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          queue.push(c);
        }
      }
    }
    return out;
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
    if (rows.length > 0) {
      h.afterCommit(() => {
        for (const l of revokedListeners) l(id);
      });
    }
    return rows.length > 0;
  });
}

/** One token by id, within a scope: the principal asking about itself. */
export function getApiToken(db: Db, scope: Scope, id: string): Promise<ApiToken | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.apiTokens)
      .where(scoped(scope, TOKEN_COLS, eq(s.apiTokens.id, id)))
      .limit(1);
    return row;
  });
}

export function getOrgById(db: Db, id: string) {
  return db.run(async (h) => {
    const [org] = await h.orm.select().from(s.orgs).where(eq(s.orgs.id, id)).limit(1);
    return org;
  });
}

// ---- audit ----

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

export type RunJobRow = {
  id: string;
  runId: string;
  projectId: string;
  name: string;
  matrix: string | null;
  state: JobState;
  /** Newest attempt number; 0 when the job never started an attempt. */
  attempt: number;
};

/** Jobs of the given runs (oldest first), each with its newest attempt number. */
export function jobsForRuns(db: Db, scope: Scope, runIds: readonly string[]): Promise<RunJobRow[]> {
  if (runIds.length === 0) return Promise.resolve([]);
  return db.run(async (h) => {
    const rows = await h.orm
      .select({
        id: s.jobs.id,
        runId: s.jobs.runId,
        projectId: s.jobs.projectId,
        name: s.jobs.name,
        matrix: s.jobs.matrix,
        state: s.jobs.state,
        attempt: sql<
          number | string | null
        >`(select max(${s.jobAttempts.attempt}) from ${s.jobAttempts} where ${s.jobAttempts.jobId} = ${s.jobs.id})`,
      })
      .from(s.jobs)
      .where(
        scoped(
          scope,
          { orgId: s.jobs.orgId, projectId: s.jobs.projectId },
          inArray(s.jobs.runId, [...runIds]),
        ),
      )
      .orderBy(asc(s.jobs.id));
    return rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      projectId: r.projectId,
      name: r.name,
      matrix: r.matrix,
      state: r.state as JobState,
      attempt: Number(r.attempt ?? 0),
    }));
  });
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

// ---- projects ----

export type ProjectWithRepos = {
  id: string;
  slug: string;
  name: string;
  repos: { forge: string; owner: string; repo: string }[];
  /** The OIDC audiences the project's jobs may mint for, or null when any audience is allowed. */
  oidcAudiences: string[] | null;
};

function parseAudiences(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/** Projects in scope (a project-narrowed scope lists only that project), by id, with bound repos. */
export function queryProjects(
  db: Db,
  scope: Scope,
  opts: { afterId?: string | undefined; limit: number },
): Promise<ProjectWithRepos[]> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select()
      .from(s.projects)
      .where(
        scoped(
          scope,
          { orgId: s.projects.orgId },
          scope.projectId === undefined ? undefined : eq(s.projects.id, scope.projectId),
          opts.afterId === undefined ? undefined : gt(s.projects.id, opts.afterId),
        ),
      )
      .orderBy(asc(s.projects.id))
      .limit(opts.limit);
    if (rows.length === 0) return [];
    const repos = await h.orm
      .select()
      .from(s.projectRepos)
      .where(
        scoped(
          scope,
          { orgId: s.projectRepos.orgId },
          inArray(
            s.projectRepos.projectId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .orderBy(asc(s.projectRepos.owner), asc(s.projectRepos.repo));
    return rows.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      oidcAudiences: parseAudiences(p.oidcAudiences),
      repos: repos
        .filter((r) => r.projectId === p.id)
        .map((r) => ({ forge: r.forge, owner: r.owner, repo: r.repo })),
    }));
  });
}
