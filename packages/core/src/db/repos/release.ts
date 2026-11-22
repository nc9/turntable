// Release lane requests. Part of the only code allowed to name tenant tables. The claim and the
// outcome writes take no scope: they belong to the release lane, which works across orgs, the way
// the audit checkpointer does.
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { ulid } from "../ulid";
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
      .where(eq(s.releaseRequests.status, "pending"))
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
