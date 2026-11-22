// Scheduler persistence: claiming queued attempts under a lease, heartbeats, fenced finishing,
// and finding abandoned work. Claim and reconcile are instance-level (a worker has no tenant
// until it has claimed something), so they are intentionally unscoped; everything they return
// carries the tenant scope the caller then uses.
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "..";
import { aggregateRunStatus } from "../job-state";
import * as s from "../schema";
import type { JobState } from "../schema";
import {
  getRun,
  type Job,
  type JobAttempt,
  listJobs,
  type Run,
  setRunStatus,
  transitionJob,
  updateAttempt,
} from "./index";
import { type Scope, scoped } from "./scope";

export type Claim = {
  attempt: JobAttempt;
  job: Job;
  run: Run;
  scope: Required<Scope>;
};

export type ClaimOptions = {
  owner: string;
  leaseMs: number;
  now: number;
  /** Most attempts running at once across the instance. */
  globalCap: number;
  /** Most attempts running at once per org, so one tenant cannot take every slot. */
  perOrgCap: number;
  /** How many of the oldest queued attempts to consider. */
  candidates?: number;
};

const FINISHED_OK: readonly JobState[] = ["success", "skipped"];

/**
 * Claims the oldest runnable queued attempt, or returns undefined. Runnable means: its job is
 * queued, every job it `needs` has succeeded or been skipped, and neither the global nor its
 * org's cap is reached. Claiming moves the attempt, its job and its run to running and takes the
 * lease, in one transaction: two workers can never claim the same attempt.
 *
 * Capacity counts every attempt in state running, lease expired or not, so a crashed worker
 * keeps its slot until the reconciler resolves it.
 */
export function claimNextAttempt(db: Db, o: ClaimOptions): Promise<Claim | undefined> {
  return db.transaction(async (tx) => {
    const running = await tx.orm
      .select({ orgId: s.jobAttempts.orgId, n: sql<number>`count(*)` })
      .from(s.jobAttempts)
      .where(eq(s.jobAttempts.state, "running"))
      .groupBy(s.jobAttempts.orgId);
    const perOrg = new Map(running.map((r) => [r.orgId, Number(r.n)]));
    let total = 0;
    for (const n of perOrg.values()) total += n;
    if (total >= o.globalCap) return undefined;

    const queued = await tx.orm
      .select({ attempt: s.jobAttempts, job: s.jobs })
      .from(s.jobAttempts)
      .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
      .where(
        and(
          eq(s.jobAttempts.state, "queued"),
          eq(s.jobs.state, "queued"),
          isNull(s.jobAttempts.leaseOwner),
        ),
      )
      .orderBy(asc(s.jobAttempts.id))
      .limit(o.candidates ?? 50);

    for (const c of queued) {
      if ((perOrg.get(c.attempt.orgId) ?? 0) >= o.perOrgCap) continue;
      const scope = { orgId: c.attempt.orgId, projectId: c.attempt.projectId };
      const needs = JSON.parse(c.job.needs) as string[];
      if (needs.length > 0) {
        const siblings = await listJobs(tx, scope, c.job.runId);
        const ready = needs.every((key) => {
          const dep = siblings.find((j) => j.jobKey === key);
          return dep !== undefined && FINISHED_OK.includes(dep.state as JobState);
        });
        if (!ready) continue;
      }
      const claimed = await tx.orm
        .update(s.jobAttempts)
        .set({ leaseOwner: o.owner, leaseExpiresAt: o.now + o.leaseMs, heartbeatAt: o.now })
        .where(
          and(
            eq(s.jobAttempts.id, c.attempt.id),
            eq(s.jobAttempts.state, "queued"),
            isNull(s.jobAttempts.leaseOwner),
          ),
        )
        .returning({ id: s.jobAttempts.id });
      if (claimed.length === 0) continue;
      await transitionJob(tx, scope, c.job.id, "running");
      const attempt = (await updateAttempt(tx, scope, c.attempt.id, { state: "running" }))!;
      const run = (await getRun(tx, scope, c.job.runId))!;
      if (run.status !== "running") await setRunStatus(tx, scope, run.id, "running");
      return {
        attempt,
        job: (await listJobs(tx, scope, run.id)).find((j) => j.id === c.job.id)!,
        run: (await getRun(tx, scope, run.id))!,
        scope,
      };
    }
    return undefined;
  });
}

/**
 * Extends the lease. False means the lease is gone: the attempt was cancelled, finished or taken
 * by the reconciler, and the caller must stop work.
 */
export function heartbeatAttempt(
  db: Db,
  scope: Scope,
  attemptId: string,
  owner: string,
  now: number,
  leaseMs: number,
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.jobAttempts)
      .set({ heartbeatAt: now, leaseExpiresAt: now + leaseMs })
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, attemptId),
          eq(s.jobAttempts.state, "running"),
          eq(s.jobAttempts.leaseOwner, owner),
        ),
      )
      .returning({ id: s.jobAttempts.id });
    return rows.length > 0;
  });
}

/** Records where the attempt runs, so a restarted controller can probe it. Fenced by owner. */
export function recordExec(
  db: Db,
  scope: Scope,
  attemptId: string,
  owner: string,
  where: { sandboxId?: string | undefined; execId?: string | undefined },
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.jobAttempts)
      .set({
        ...(where.sandboxId === undefined ? {} : { sandboxId: where.sandboxId }),
        ...(where.execId === undefined ? {} : { execId: where.execId }),
      })
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, attemptId),
          eq(s.jobAttempts.state, "running"),
          eq(s.jobAttempts.leaseOwner, owner),
        ),
      )
      .returning({ id: s.jobAttempts.id });
    return rows.length > 0;
  });
}

export type FinishInput = {
  attemptId: string;
  /** The lease holder finishing its own work, or the reconciler finishing an expired one. */
  owner: string;
  state: "success" | "failure" | "skipped" | "infra_error" | "cancelled";
  exitCode?: number | null;
  errorClass?: string | null;
  /** Reconciler only: finish only if the lease has expired by this time. */
  expiredBefore?: number;
};

/**
 * Ends a running attempt: attempt, job and run move together, the lease is cleared, events are
 * written, all in one transaction. Fenced: returns false (and changes nothing) unless the
 * attempt is still running under `owner`'s lease, so a slow worker cannot overwrite what the
 * reconciler or a cancel decided.
 */
export function finishAttempt(db: Db, scope: Scope, input: FinishInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.orm
      .select()
      .from(s.jobAttempts)
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, input.attemptId),
        ),
      )
      .limit(1);
    if (!cur || cur.state !== "running" || cur.leaseOwner !== input.owner) return false;
    if (
      input.expiredBefore !== undefined &&
      (cur.leaseExpiresAt === null || cur.leaseExpiresAt >= input.expiredBefore)
    ) {
      return false;
    }
    await updateAttempt(tx, scope, cur.id, {
      state: input.state,
      exitCode: input.exitCode ?? null,
      errorClass: input.errorClass ?? null,
    });
    await tx.orm
      .update(s.jobAttempts)
      .set({ leaseOwner: null, leaseExpiresAt: null })
      .where(eq(s.jobAttempts.id, cur.id));
    const job = await transitionJob(tx, scope, cur.jobId, input.state, {
      exitCode: input.exitCode ?? null,
    });
    if (job) {
      const states = (await listJobs(tx, scope, job.runId)).map((j) => j.state as JobState);
      await setRunStatus(tx, scope, job.runId, aggregateRunStatus(states));
    }
    return true;
  });
}

/** Running attempts whose lease has expired: their worker is gone. Oldest first. */
export function listExpiredLeases(db: Db, now: number): Promise<JobAttempt[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.jobAttempts)
      .where(and(eq(s.jobAttempts.state, "running"), lt(s.jobAttempts.leaseExpiresAt, now)))
      .orderBy(asc(s.jobAttempts.id)),
  );
}

/** Number of attempts currently running, overall or for one org. */
export function countRunning(db: Db, orgId?: string): Promise<number> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ n: sql<number>`count(*)` })
      .from(s.jobAttempts)
      .where(
        and(
          eq(s.jobAttempts.state, "running"),
          orgId === undefined ? undefined : eq(s.jobAttempts.orgId, orgId),
        ),
      );
    return Number(row?.n ?? 0);
  });
}
