// The ONLY place tenant-owned tables are queried. Every function takes a Scope and filters on
// org_id (and project_id when the scope has one). tests/tenancy-guard.test.ts enforces this.
import { and, asc, desc, eq, gte } from "drizzle-orm";
import type { Db } from "..";
import { canTransition, exitCodeValid } from "../job-state";
import * as s from "../schema";
import type { JobState } from "../schema";
import { ulid } from "../ulid";
import { requireProject, type Scope, scoped } from "./scope";

export type { Scope } from "./scope";

export type Project = typeof s.projects.$inferSelect;
export type ProjectRepo = typeof s.projectRepos.$inferSelect;
export type Run = typeof s.runs.$inferSelect;
export type Job = typeof s.jobs.$inferSelect;
export type JobAttempt = typeof s.jobAttempts.$inferSelect;

const now = () => Date.now();

// ---- tenancy ----

export function createOrg(db: Db, input: { slug: string; name: string }) {
  const row = { id: ulid(), ...input };
  db.orm.insert(s.orgs).values(row).run();
  return db.orm.select().from(s.orgs).where(eq(s.orgs.id, row.id)).get()!;
}

export function getOrgBySlug(db: Db, slug: string) {
  return db.orm.select().from(s.orgs).where(eq(s.orgs.slug, slug)).get();
}

export function createProject(
  db: Db,
  scope: Scope,
  input: { slug: string; name: string },
): Project {
  const id = ulid();
  db.orm
    .insert(s.projects)
    .values({ id, orgId: scope.orgId, ...input })
    .run();
  return getProject(db, { orgId: scope.orgId }, id)!;
}

export function getProject(db: Db, scope: Scope, id: string): Project | undefined {
  return db.orm
    .select()
    .from(s.projects)
    .where(scoped(scope, { orgId: s.projects.orgId }, eq(s.projects.id, id)))
    .get();
}

export function getProjectBySlug(db: Db, scope: Scope, slug: string): Project | undefined {
  return db.orm
    .select()
    .from(s.projects)
    .where(scoped(scope, { orgId: s.projects.orgId }, eq(s.projects.slug, slug)))
    .get();
}

export function listProjects(db: Db, scope: Scope): Project[] {
  // A project-narrowed scope lists only that project.
  const where =
    scope.projectId === undefined
      ? scoped(scope, { orgId: s.projects.orgId })
      : scoped(scope, { orgId: s.projects.orgId }, eq(s.projects.id, scope.projectId));
  return db.orm.select().from(s.projects).where(where).orderBy(asc(s.projects.slug)).all();
}

export function renameProject(db: Db, scope: Scope, id: string, name: string): Project | undefined {
  const rows = db.orm
    .update(s.projects)
    .set({ name })
    .where(scoped(scope, { orgId: s.projects.orgId }, eq(s.projects.id, id)))
    .returning({ id: s.projects.id })
    .all();
  return rows.length ? getProject(db, scope, id) : undefined;
}

// TODO(#19): prove the caller controls this repo/installation at bind time (GitHub App work).
export function bindRepo(
  db: Db,
  scope: Scope,
  input: {
    forge: s.Forge;
    owner: string;
    repo: string;
    installationId?: string;
    forgeRepoId?: string;
  },
): ProjectRepo {
  const { projectId } = requireProject(scope);
  const id = ulid();
  db.orm
    .insert(s.projectRepos)
    .values({
      id,
      orgId: scope.orgId,
      projectId,
      forge: input.forge,
      owner: input.owner.toLowerCase(),
      repo: input.repo.toLowerCase(),
      installationId: input.installationId ?? null,
      forgeRepoId: input.forgeRepoId ?? null,
    })
    .run();
  return db.orm.select().from(s.projectRepos).where(eq(s.projectRepos.id, id)).get()!;
}

export function listRepos(db: Db, scope: Scope): ProjectRepo[] {
  return db.orm
    .select()
    .from(s.projectRepos)
    .where(scoped(scope, { orgId: s.projectRepos.orgId, projectId: s.projectRepos.projectId }))
    .all();
}

/**
 * Webhook routing: resolves a forge repo to its owning scope. Intentionally unscoped (the
 * caller has no tenant yet); the unique(forge, owner, repo) constraint makes it unambiguous.
 */
export function resolveRepoScope(
  db: Db,
  input: {
    forge: s.Forge;
    owner: string;
    repo: string;
    forgeRepoId?: string;
    /** Installation the event came from. Required to match when the binding has one. */
    installationId?: string;
  },
): Required<Scope> | undefined {
  // Prefer the stable forge id (survives renames); fall back to case-insensitive owner/repo.
  const byId = input.forgeRepoId
    ? db.orm
        .select()
        .from(s.projectRepos)
        .where(
          and(
            eq(s.projectRepos.forge, input.forge),
            eq(s.projectRepos.forgeRepoId, input.forgeRepoId),
          ),
        )
        .get()
    : undefined;
  const row =
    byId ??
    db.orm
      .select()
      .from(s.projectRepos)
      .where(
        and(
          eq(s.projectRepos.forge, input.forge),
          eq(s.projectRepos.owner, input.owner.toLowerCase()),
          eq(s.projectRepos.repo, input.repo.toLowerCase()),
        ),
      )
      .get();
  if (!row) return undefined;
  // Name fallback only for rows with no stable id. A row bound to a different forge repo id
  // means the repo was deleted and recreated, or the name was taken over: do not route.
  if (row.forgeRepoId !== null && row.forgeRepoId !== input.forgeRepoId) return undefined;
  // A bound installation must match: a same-named repo under another installation must not
  // route into this org. A missing incoming installation counts as a mismatch.
  if (row.installationId !== null && row.installationId !== input.installationId) return undefined;
  return { orgId: row.orgId, projectId: row.projectId };
}

export function addMember(db: Db, scope: Scope, input: { userId: string; role: s.MemberRole }) {
  db.orm
    .insert(s.orgMembers)
    .values({ orgId: scope.orgId, ...input })
    .run();
}

export function listMembers(db: Db, scope: Scope) {
  return db.orm
    .select()
    .from(s.orgMembers)
    .where(scoped(scope, { orgId: s.orgMembers.orgId }))
    .all();
}

export function createUser(db: Db, input: { email?: string; displayName: string }) {
  const id = ulid();
  db.orm
    .insert(s.users)
    .values({ id, email: input.email ?? null, displayName: input.displayName })
    .run();
  return db.orm.select().from(s.users).where(eq(s.users.id, id)).get()!;
}

/** Idempotently creates the built-in `local` org and project used by local runs. */
export function ensureLocalTenant(db: Db): Required<Scope> {
  try {
    return ensureLocalTenantOnce(db);
  } catch {
    // A concurrent boot created the rows between our read and insert: reread.
    return ensureLocalTenantOnce(db);
  }
}

function ensureLocalTenantOnce(db: Db): Required<Scope> {
  return db.orm.transaction((tx) => {
    const inner = { orm: tx, close: () => {} } as unknown as Db;
    let org = getOrgBySlug(inner, "local");
    if (!org) org = createOrg(inner, { slug: "local", name: "Local" });
    const scope = { orgId: org.id };
    let project = getProjectBySlug(inner, scope, "local");
    if (!project) project = createProject(inner, scope, { slug: "local", name: "Local" });
    return { orgId: org.id, projectId: project.id };
  });
}

// ---- runs ----

export function createRun(
  db: Db,
  scope: Scope,
  input: { workflowPath: string; event: string; ref: string; sha?: string },
): Run {
  const { projectId } = requireProject(scope);
  const id = ulid();
  db.orm
    .insert(s.runs)
    .values({
      id,
      orgId: scope.orgId,
      projectId,
      workflowPath: input.workflowPath,
      event: input.event,
      ref: input.ref,
      sha: input.sha ?? null,
    })
    .run();
  return getRun(db, scope, id)!;
}

export function getRun(db: Db, scope: Scope, id: string): Run | undefined {
  return db.orm
    .select()
    .from(s.runs)
    .where(scoped(scope, { orgId: s.runs.orgId, projectId: s.runs.projectId }, eq(s.runs.id, id)))
    .get();
}

export function listRuns(db: Db, scope: Scope, opts: { limit?: number } = {}): Run[] {
  return db.orm
    .select()
    .from(s.runs)
    .where(scoped(scope, { orgId: s.runs.orgId, projectId: s.runs.projectId }))
    .orderBy(desc(s.runs.id))
    .limit(opts.limit ?? 50)
    .all();
}

export function setRunStatus(db: Db, scope: Scope, id: string, status: JobState): Run | undefined {
  const t = now();
  const rows = db.orm
    .update(s.runs)
    .set({
      status,
      startedAt: status === "running" ? t : undefined,
      finishedAt: ["success", "failure", "infra_error", "cancelled"].includes(status)
        ? t
        : undefined,
    })
    .where(scoped(scope, { orgId: s.runs.orgId, projectId: s.runs.projectId }, eq(s.runs.id, id)))
    .returning({ id: s.runs.id })
    .all();
  return rows.length ? getRun(db, scope, id) : undefined;
}

// ---- jobs ----

export class InvalidTransitionError extends Error {
  from: JobState;
  to: JobState;
  constructor(from: JobState, to: JobState, detail?: string) {
    super(`invalid job transition ${from} -> ${to}${detail ? `: ${detail}` : ""}`);
    this.from = from;
    this.to = to;
  }
}

export function createJob(
  db: Db,
  scope: Scope,
  input: { runId: string; jobKey: string; name: string },
): Job | undefined {
  const { projectId } = requireProject(scope);
  // Parent must be in scope; the composite FK is the backstop, this gives a clean undefined.
  if (!getRun(db, scope, input.runId)) return undefined;
  const id = ulid();
  db.orm
    .insert(s.jobs)
    .values({ id, orgId: scope.orgId, projectId, ...input })
    .run();
  return getJob(db, scope, id);
}

export function getJob(db: Db, scope: Scope, id: string): Job | undefined {
  return db.orm
    .select()
    .from(s.jobs)
    .where(scoped(scope, { orgId: s.jobs.orgId, projectId: s.jobs.projectId }, eq(s.jobs.id, id)))
    .get();
}

export function listJobs(db: Db, scope: Scope, runId: string): Job[] {
  return db.orm
    .select()
    .from(s.jobs)
    .where(
      scoped(scope, { orgId: s.jobs.orgId, projectId: s.jobs.projectId }, eq(s.jobs.runId, runId)),
    )
    .orderBy(asc(s.jobs.id))
    .all();
}

/**
 * Moves a job to a new state, enforcing the transition table and exit-code invariants.
 * Returns undefined when the job is not in scope. Compare-and-set on the current state, so a
 * concurrent writer cannot be silently overwritten.
 */
export function transitionJob(
  db: Db,
  scope: Scope,
  id: string,
  to: JobState,
  opts: { exitCode?: number | null } = {},
): Job | undefined {
  const job = getJob(db, scope, id);
  if (!job) return undefined;
  const from = job.state as JobState;
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  if (!exitCodeValid(to, opts.exitCode)) {
    throw new InvalidTransitionError(from, to, `exit code ${String(opts.exitCode)} invalid`);
  }
  const t = now();
  const rows = db.orm
    .update(s.jobs)
    .set({
      state: to,
      exitCode: opts.exitCode ?? null,
      startedAt: to === "running" ? t : undefined,
      finishedAt: ["success", "failure", "infra_error", "cancelled"].includes(to) ? t : null,
    })
    .where(
      scoped(
        scope,
        { orgId: s.jobs.orgId, projectId: s.jobs.projectId },
        eq(s.jobs.id, id),
        eq(s.jobs.state, from),
      ),
    )
    .returning({ id: s.jobs.id })
    .all();
  if (!rows.length) throw new InvalidTransitionError(from, to, "state changed concurrently");
  return getJob(db, scope, id);
}

// ---- attempts ----

const ATTEMPT_COLS = { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId };
const LOG_COLS = { orgId: s.logChunks.orgId, projectId: s.logChunks.projectId };

export function createAttempt(
  db: Db,
  scope: Scope,
  input: { jobId: string; provider: string },
): JobAttempt | undefined {
  const { projectId } = requireProject(scope);
  if (!getJob(db, scope, input.jobId)) return undefined;
  const last = db.orm
    .select({ attempt: s.jobAttempts.attempt })
    .from(s.jobAttempts)
    .where(scoped(scope, ATTEMPT_COLS, eq(s.jobAttempts.jobId, input.jobId)))
    .orderBy(desc(s.jobAttempts.attempt))
    .limit(1)
    .get();
  const id = ulid();
  db.orm
    .insert(s.jobAttempts)
    .values({
      id,
      orgId: scope.orgId,
      projectId,
      jobId: input.jobId,
      attempt: (last?.attempt ?? 0) + 1,
      provider: input.provider,
    })
    .run();
  return getAttempt(db, scope, id);
}

export function getAttempt(db: Db, scope: Scope, id: string): JobAttempt | undefined {
  return db.orm
    .select()
    .from(s.jobAttempts)
    .where(scoped(scope, ATTEMPT_COLS, eq(s.jobAttempts.id, id)))
    .get();
}

export function listAttempts(db: Db, scope: Scope, jobId: string): JobAttempt[] {
  return db.orm
    .select()
    .from(s.jobAttempts)
    .where(scoped(scope, ATTEMPT_COLS, eq(s.jobAttempts.jobId, jobId)))
    .orderBy(asc(s.jobAttempts.attempt))
    .all();
}

export function updateAttempt(
  db: Db,
  scope: Scope,
  id: string,
  patch: {
    state?: JobState;
    sandboxId?: string | null;
    exitCode?: number | null;
    errorClass?: string | null;
  },
): JobAttempt | undefined {
  const cur = getAttempt(db, scope, id);
  if (!cur) return undefined;
  if (patch.state) {
    const from = cur.state as JobState;
    if (!canTransition(from, patch.state)) throw new InvalidTransitionError(from, patch.state);
    if (!exitCodeValid(patch.state, patch.exitCode)) {
      throw new InvalidTransitionError(from, patch.state, "exit code invalid");
    }
  }
  const t = now();
  const from = cur.state as JobState;
  const rows = db.orm
    .update(s.jobAttempts)
    .set({
      ...patch,
      startedAt: patch.state === "running" ? t : undefined,
      finishedAt:
        patch.state && ["success", "failure", "infra_error", "cancelled"].includes(patch.state)
          ? t
          : undefined,
    })
    .where(
      scoped(
        scope,
        ATTEMPT_COLS,
        eq(s.jobAttempts.id, id),
        // Compare-and-set on state so heartbeat and reconcile cannot overwrite each other.
        patch.state ? eq(s.jobAttempts.state, from) : undefined,
      ),
    )
    .returning({ id: s.jobAttempts.id })
    .all();
  if (!rows.length) {
    throw new InvalidTransitionError(from, patch.state ?? from, "state changed concurrently");
  }
  return getAttempt(db, scope, id);
}

// ---- logs ----

/** Appends a chunk at a byte offset. Returns false when the attempt is not in scope. */
export function appendLog(
  db: Db,
  scope: Scope,
  attemptId: string,
  offset: number,
  bytes: Uint8Array,
): boolean {
  if (!getAttempt(db, scope, attemptId)) return false;
  db.orm
    .insert(s.logChunks)
    .values({
      orgId: scope.orgId,
      projectId: requireProject(scope).projectId,
      attemptId,
      offset,
      bytes: Buffer.from(bytes),
    })
    .onConflictDoNothing()
    .run();
  return true;
}

/** Chunks with offset >= `fromOffset`, in order. Empty when the attempt is not in scope. */
export function readLog(
  db: Db,
  scope: Scope,
  attemptId: string,
  fromOffset = 0,
): { offset: number; bytes: Buffer }[] {
  return db.orm
    .select({ offset: s.logChunks.offset, bytes: s.logChunks.bytes })
    .from(s.logChunks)
    .where(
      scoped(
        scope,
        LOG_COLS,
        eq(s.logChunks.attemptId, attemptId),
        gte(s.logChunks.offset, fromOffset),
      ),
    )
    .orderBy(asc(s.logChunks.offset))
    .all();
}
