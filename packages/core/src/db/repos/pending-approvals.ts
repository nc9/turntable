// Reads behind `my_pending_approvals` (#545): what waits on a human, across one org, with no
// forge text selected (no titles, branch names, workflow or job names). Part of the only code
// allowed to name tenant tables.
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import type { ApprovalRecord } from "./approvals";

export type AwaitingJob = {
  runId: string;
  projectId: string;
  approvalKind: string | null;
  planned: string | null;
  createdAt: number;
};

/** Jobs of one org that wait on a human, oldest first. Capped: a flood cannot make this slow. */
export function listAwaitingJobs(db: Db, orgId: string, limit = 500): Promise<AwaitingJob[]> {
  return db.run((h) =>
    h.orm
      .select({
        runId: s.jobs.runId,
        projectId: s.jobs.projectId,
        approvalKind: s.jobs.approvalKind,
        planned: s.jobs.planned,
        createdAt: s.jobs.createdAt,
      })
      .from(s.jobs)
      .where(and(eq(s.jobs.orgId, orgId), eq(s.jobs.state, "awaiting_approval")))
      .orderBy(asc(s.jobs.createdAt))
      .limit(limit),
  );
}

/** The unexpired signed records of key policy proposals (they share a digest in `enrolment_id`). */
export function listLivePolicyRecords(
  db: Db,
  orgId: string,
  now: number,
): Promise<ApprovalRecord[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.approvalRecords)
      .where(
        and(
          eq(s.approvalRecords.orgId, orgId),
          eq(s.approvalRecords.kind, "policy"),
          gt(s.approvalRecords.expiresAt, now),
        ),
      )
      .orderBy(asc(s.approvalRecords.createdAt))
      .limit(500),
  );
}

/** Slugs of projects by id, for building links. */
export function projectSlugs(
  db: Db,
  orgId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return Promise.resolve(new Map());
  return db.run(async (h) => {
    const rows = await h.orm
      .select({ id: s.projects.id, slug: s.projects.slug })
      .from(s.projects)
      .where(and(eq(s.projects.orgId, orgId), inArray(s.projects.id, [...ids])));
    return new Map(rows.map((r) => [r.id, r.slug]));
  });
}
