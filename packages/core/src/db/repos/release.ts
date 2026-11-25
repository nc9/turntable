// Release lane requests. Part of the only code allowed to name tenant tables. The claim and the
// outcome writes take no scope: they belong to the release lane, which works across orgs, the way
// the audit checkpointer does.
import { and, asc, eq, gt, inArray, isNull, like } from "drizzle-orm";
import { plannedEnvironment } from "./approvals";
import type { Db } from "..";
import * as s from "../schema";
import { ulid } from "../ulid";
import { notFrozen } from "./incident";
import { requireProject, type Scope, scoped } from "./scope";

export type ReleaseRequest = typeof s.releaseRequests.$inferSelect;

const COLS = { orgId: s.releaseRequests.orgId, projectId: s.releaseRequests.projectId };

export function createReleaseRequest(
  db: Db,
  scope: Scope,
  input: {
    runId: string;
    tag: string;
    artifacts: readonly string[];
    /** Co-signatures the requester carries (#544): untrusted, verified only by the lane. */
    cosignatures?: readonly { name: string; signature_b64: string }[];
    requestedBy: string;
  },
): Promise<ReleaseRequest> {
  const { projectId } = requireProject(scope);
  return db.transaction(async (tx) => {
    const row = {
      id: ulid(),
      orgId: scope.orgId,
      projectId,
      runId: input.runId,
      tag: input.tag,
      artifacts: JSON.stringify(input.artifacts),
      cosignatures: input.cosignatures?.length ? JSON.stringify(input.cosignatures) : null,
      status: "pending",
      requestedBy: input.requestedBy,
    };
    await tx.orm.insert(s.releaseRequests).values(row);
    const [out] = await tx.orm
      .select()
      .from(s.releaseRequests)
      .where(eq(s.releaseRequests.id, row.id))
      .limit(1);
    return out!;
  });
}

export function getReleaseRequest(
  db: Db,
  scope: Scope,
  id: string,
): Promise<ReleaseRequest | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.releaseRequests)
      .where(scoped(scope, COLS, eq(s.releaseRequests.id, id)))
      .limit(1);
    return row;
  });
}

export function listReleaseRequests(db: Db, scope: Scope, limit = 50): Promise<ReleaseRequest[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.releaseRequests)
      .where(scoped(scope, COLS))
      .orderBy(asc(s.releaseRequests.id))
      .limit(limit),
  );
}

/** The release lane takes the oldest pending request. Atomic: two lanes never share one. */
export function claimNextReleaseRequest(
  db: Db,
  owner: string,
  now: number,
): Promise<ReleaseRequest | undefined> {
  return db.transaction(async (tx) => {
    const [next] = await tx.orm
      .select()
      .from(s.releaseRequests)
      // A frozen org or project's requests are not taken: they wait for the freeze to clear.
      .where(
        and(
          eq(s.releaseRequests.status, "pending"),
          notFrozen(s.releaseRequests.orgId, s.releaseRequests.projectId),
        ),
      )
      .orderBy(asc(s.releaseRequests.createdAt), asc(s.releaseRequests.id))
      .limit(1);
    if (!next) return undefined;
    const rows = await tx.orm
      .update(s.releaseRequests)
      .set({ status: "claimed", claimedBy: owner, claimedAt: now })
      .where(and(eq(s.releaseRequests.id, next.id), eq(s.releaseRequests.status, "pending")))
      .returning();
    return rows[0];
  });
}

/** The lane writes the outcome of a request it claimed. Only a claimed request can finish. */
export function finishReleaseRequest(
  db: Db,
  id: string,
  owner: string,
  outcome: {
    status: "signed" | "refused" | "error";
    reason?: string | undefined;
    detail?: string | undefined;
    result?: unknown;
    facts?: unknown;
  },
  now: number,
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.releaseRequests)
      .set({
        status: outcome.status,
        reason: outcome.reason ?? null,
        detail: outcome.detail ?? null,
        result: outcome.result === undefined ? null : JSON.stringify(outcome.result),
        facts: outcome.facts === undefined ? null : JSON.stringify(outcome.facts),
        finishedAt: now,
      })
      .where(
        and(
          eq(s.releaseRequests.id, id),
          eq(s.releaseRequests.status, "claimed"),
          eq(s.releaseRequests.claimedBy, owner),
        ),
      )
      .returning({ id: s.releaseRequests.id });
    return rows.length > 0;
  });
}

// ---- deploy gate: is any release work in flight on this instance? ----

/** Run states that are active or waiting. */
const ACTIVE_RUN = ["queued", "running", "awaiting_approval"] as const;

/**
 * True while any release work is in flight on the instance, across every org and project (the
 * deploy gate publishes only this one bit). It is in flight when:
 *  - a run of the release class is queued, running or awaiting approval;
 *  - an attempt running as the release class (after demotion) has not finished;
 *  - a job waits for approval in its project's signing environment;
 *  - a release request is `pending` (not yet taken by the lane) or `claimed` (the lane is
 *    verifying, signing or publishing: the request ends only after the publish step);
 *  - an environment approval for the signing environment is unspent and unexpired (a co-sign is
 *    gathered or complete and the signature is not yet taken).
 */
export function releaseInFlight(db: Db, now: number): Promise<boolean> {
  return db.run(async (h) => {
    const [req] = await h.orm
      .select({ id: s.releaseRequests.id })
      .from(s.releaseRequests)
      .where(inArray(s.releaseRequests.status, ["pending", "claimed"]))
      .limit(1);
    if (req) return true;

    const runs = await h.orm
      .select({ trust: s.runs.trust })
      .from(s.runs)
      .where(and(inArray(s.runs.status, [...ACTIVE_RUN]), like(s.runs.trust, "%release%")))
      .limit(5000);
    for (const r of runs) {
      try {
        if ((JSON.parse(r.trust ?? "null") as { class?: unknown } | null)?.class === "release") {
          return true;
        }
      } catch {
        // An unreadable decision is not a release decision; the other checks still apply.
      }
    }

    const [att] = await h.orm
      .select({ id: s.jobAttempts.id })
      .from(s.jobAttempts)
      .where(
        and(
          eq(s.jobAttempts.trustClass, "release"),
          inArray(s.jobAttempts.state, ["queued", "running"]),
        ),
      )
      .limit(1);
    if (att) return true;

    const projects = await h.orm
      .select({
        orgId: s.projects.orgId,
        id: s.projects.id,
        env: s.projects.signingEnvironment,
      })
      .from(s.projects)
      .limit(100_000);
    const signingEnv = new Map(projects.map((p) => [`${p.orgId}/${p.id}`, p.env ?? "release"]));

    const waiting = await h.orm
      .select({ orgId: s.jobs.orgId, projectId: s.jobs.projectId, planned: s.jobs.planned })
      .from(s.jobs)
      .where(and(eq(s.jobs.state, "awaiting_approval"), eq(s.jobs.approvalKind, "environment")))
      .limit(5000);
    for (const j of waiting) {
      const env = plannedEnvironment(j.planned);
      if (env !== undefined && env === signingEnv.get(`${j.orgId}/${j.projectId}`)) return true;
    }

    const records = await h.orm
      .select({
        orgId: s.approvalRecords.orgId,
        projectId: s.approvalRecords.projectId,
        environment: s.approvalRecords.environment,
      })
      .from(s.approvalRecords)
      .where(
        and(
          eq(s.approvalRecords.kind, "environment"),
          isNull(s.approvalRecords.spentAt),
          gt(s.approvalRecords.expiresAt, now),
        ),
      )
      .limit(5000);
    for (const a of records) {
      if (a.projectId === null || a.environment === null) continue;
      if (a.environment === signingEnv.get(`${a.orgId}/${a.projectId}`)) return true;
    }
    return false;
  });
}
