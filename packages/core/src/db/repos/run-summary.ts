// Counts only, per org and project, of how finished runs turned out in a window (#574): runs by
// trigger and conclusion, jobs by state, infra kinds of failed attempts, sandbox time and the
// newest run. Instance-level, so it is unscoped like `instanceRunActivity`. One grouped query per
// table, bounded by `since`. No id, ref, sha, branch or name leaves this file but the org and
// project ids the caller maps to slugs.
import { type AnyColumn, and, desc, eq, gte, inArray, type SQL, sql } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { sandboxSpans, spanMs } from "./usage";

export const RUN_TRIGGERS = [
  "push",
  "pull_request",
  "merge_group",
  "workflow_dispatch",
  "tag",
  "other",
] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export type RunSummaryCell = {
  orgId: string;
  projectId: string;
  runsByTrigger: Record<string, number>;
  runsByConclusion: Record<string, number>;
  jobsByState: Record<string, number>;
  infraKinds: Record<string, number>;
  sandboxMs: number;
  newestRunAt: number | null;
  newestRunConclusion: string | null;
};

export type RunSummaryFilter = { orgId?: string | undefined; projectId?: string | undefined };

export async function instanceRunSummary(
  db: Db,
  since: number,
  now: number,
  filter: RunSummaryFilter = {},
): Promise<RunSummaryCell[]> {
  // Sandbox time is the quotas' own figure (usage.ts), over [since, now].
  const spans = await sandboxSpans(
    db,
    {
      ...(filter.orgId === undefined ? {} : { orgId: filter.orgId }),
      ...(filter.projectId === undefined ? {} : { projectId: filter.projectId }),
    },
    { from: since, to: now, now },
  );
  return db.run(async (h) => {
    const n = sql<number>`count(*)`.mapWith(Number);
    const where = (t: { orgId: AnyColumn; projectId: AnyColumn; createdAt: AnyColumn }) =>
      and(
        gte(t.createdAt, since),
        filter.orgId === undefined ? undefined : eq(t.orgId, filter.orgId),
        filter.projectId === undefined ? undefined : eq(t.projectId, filter.projectId),
      );
    // A tag push is recorded as a push of a tag ref.
    const trigger: SQL<string> = sql<string>`CASE
      WHEN ${s.runs.event} = 'push' AND ${s.runs.ref} LIKE 'refs/tags/%' THEN 'tag'
      WHEN ${s.runs.event} IN ('push', 'pull_request', 'merge_group', 'workflow_dispatch')
        THEN ${s.runs.event}
      ELSE 'other' END`;
    const runRows = await h.orm
      .select({
        orgId: s.runs.orgId,
        projectId: s.runs.projectId,
        trigger,
        status: s.runs.status,
        n,
        newest: sql<number>`max(${s.runs.createdAt})`.mapWith(Number),
      })
      .from(s.runs)
      .where(where(s.runs))
      .groupBy(s.runs.orgId, s.runs.projectId, trigger, s.runs.status);
    const jobRows = await h.orm
      .select({ orgId: s.jobs.orgId, projectId: s.jobs.projectId, state: s.jobs.state, n })
      .from(s.jobs)
      .where(where(s.jobs))
      .groupBy(s.jobs.orgId, s.jobs.projectId, s.jobs.state);
    const kind = sql<string>`coalesce(${s.jobAttempts.infraKind}, 'unknown')`;
    const attemptRows = await h.orm
      .select({
        orgId: s.jobAttempts.orgId,
        projectId: s.jobAttempts.projectId,
        kind,
        infra:
          sql<number>`coalesce(sum(CASE WHEN ${s.jobAttempts.state} = 'infra_error' THEN 1 ELSE 0 END), 0)`.mapWith(
            Number,
          ),
      })
      .from(s.jobAttempts)
      .where(where(s.jobAttempts))
      .groupBy(s.jobAttempts.orgId, s.jobAttempts.projectId, kind);
    const out = new Map<string, RunSummaryCell>();
    const cell = (orgId: string, projectId: string): RunSummaryCell => {
      const key = `${orgId}/${projectId}`;
      let c = out.get(key);
      if (!c) {
        c = {
          orgId,
          projectId,
          runsByTrigger: {},
          runsByConclusion: {},
          jobsByState: {},
          infraKinds: {},
          sandboxMs: 0,
          newestRunAt: null,
          newestRunConclusion: null,
        };
        out.set(key, c);
      }
      return c;
    };
    const add = (m: Record<string, number>, k: string, v: number) => {
      m[k] = (m[k] ?? 0) + v;
    };
    for (const r of runRows) {
      const c = cell(r.orgId, r.projectId);
      add(c.runsByTrigger, r.trigger, r.n);
      add(c.runsByConclusion, r.status, r.n);
      if (c.newestRunAt === null || r.newest > c.newestRunAt) {
        c.newestRunAt = r.newest;
        c.newestRunConclusion = r.status;
      }
    }
    for (const r of jobRows) add(cell(r.orgId, r.projectId).jobsByState, r.state, r.n);
    for (const r of attemptRows) {
      const c = cell(r.orgId, r.projectId);
      if (r.infra > 0) add(c.infraKinds, r.kind, r.infra);
    }
    for (const sp of spans) {
      const c = cell(sp.orgId, sp.projectId);
      c.sandboxMs += spanMs([sp], since, now);
    }
    return [...out.values()];
  });
}

export type InfraErrorRow = {
  orgId: string;
  projectId: string;
  runId: string;
  jobKey: string;
  attempt: number;
  infraKind: string | null;
  errorClass: string | null;
  /** The underlying error's name and code, from the attempt's `infra.error` event. Not sanitized. */
  errorName: string | null;
  errorCode: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

/**
 * Recent `infra_error` attempts across orgs (#670), newest first, for the instance administrator.
 * `errorClass` is the stored text, NOT sanitized: the op sanitizes it before it leaves.
 */
export function instanceInfraErrors(
  db: Db,
  since: number,
  filter: {
    orgId?: string | undefined;
    projectId?: string | undefined;
    runId?: string | undefined;
  },
  limit: number,
): Promise<InfraErrorRow[]> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({
        orgId: s.jobAttempts.orgId,
        projectId: s.jobAttempts.projectId,
        attemptId: s.jobAttempts.id,
        runId: s.jobs.runId,
        jobKey: s.jobs.jobKey,
        attempt: s.jobAttempts.attempt,
        infraKind: s.jobAttempts.infraKind,
        errorClass: s.jobAttempts.errorClass,
        createdAt: s.jobAttempts.createdAt,
        startedAt: s.jobAttempts.startedAt,
        finishedAt: s.jobAttempts.finishedAt,
      })
      .from(s.jobAttempts)
      .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
      .where(
        and(
          eq(s.jobAttempts.state, "infra_error"),
          gte(s.jobAttempts.createdAt, since),
          filter.orgId === undefined ? undefined : eq(s.jobAttempts.orgId, filter.orgId),
          filter.projectId === undefined
            ? undefined
            : eq(s.jobAttempts.projectId, filter.projectId),
          filter.runId === undefined ? undefined : eq(s.jobs.runId, filter.runId),
        ),
      )
      .orderBy(desc(s.jobAttempts.createdAt), desc(s.jobAttempts.id))
      .limit(limit);
    const detail = new Map<string, { name: string | null; code: string | null }>();
    if (rows.length > 0) {
      const evs = await h.orm
        .select({ attemptId: s.events.attemptId, payload: s.events.payload })
        .from(s.events)
        .where(
          and(
            eq(s.events.type, "infra.error"),
            inArray(
              s.events.attemptId,
              rows.map((r) => r.attemptId),
            ),
          ),
        )
        .orderBy(s.events.id);
      for (const e of evs) {
        if (e.attemptId === null) continue;
        try {
          const p = JSON.parse(e.payload) as { error_name?: unknown; error_code?: unknown };
          detail.set(e.attemptId, {
            name: typeof p.error_name === "string" ? p.error_name : null,
            code: typeof p.error_code === "string" ? p.error_code : null,
          });
        } catch {
          // A malformed payload carries no detail.
        }
      }
    }
    return rows.map(({ attemptId, ...r }) => ({
      ...r,
      errorName: detail.get(attemptId)?.name ?? null,
      errorCode: detail.get(attemptId)?.code ?? null,
    }));
  });
}
