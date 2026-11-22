// Scheduler persistence: claiming queued attempts under a lease, heartbeats, fenced finishing,
// and finding abandoned work. Claim and reconcile are instance-level (a worker has no tenant
// until it has claimed something), so they are intentionally unscoped; everything they return
// carries the tenant scope the caller then uses.
import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "..";
import { aggregateRunStatus } from "../job-state";
import * as s from "../schema";
import type { JobState } from "../schema";
import {
  appendLog,
  getRun,
  listAttempts,
  type Job,
  type JobAttempt,
  listJobs,
  type Run,
  setRunStatus,
  transitionJob,
  updateAttempt,
} from "./index";
import {
  defaultReadiness,
  depStates,
  effectiveStates,
  latestReasons,
  needsDecision,
  type Readiness,
  resolveDependents,
} from "./readiness";
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
  /** Decides whether a queued job may run. Default: plain `needs` (see defaultReadiness). */
  readiness?: Readiness;
  /** Queued rows examined per org per round. Default 25. */
  pageSize?: number;
  /** Most queued rows examined in one claim, across all orgs. Default 1000. */
  scanLimit?: number;
};

/**
 * Claims the next runnable queued attempt, or returns undefined. Runnable means: its job is
 * queued (not awaiting approval), the readiness function says `ready`, and neither the global
 * nor its org's cap is reached. Claiming moves the attempt, its job and its run to running and
 * takes the lease, in one transaction: two workers can never claim the same attempt.
 *
 * Fairness: orgs with queued work are visited round-robin, the org with the fewest running
 * attempts first, and oldest first within an org, one page per org per round. An org with a
 * hundred attempts that cannot run yet therefore cannot hide another org's ready attempt. The
 * scan is bounded by `scanLimit` rows in total, so a claim is never unbounded work. Jobs the
 * readiness function says can never run (`skip`, `cancel`) are resolved on the way.
 *
 * Capacity counts every attempt in state running, lease expired or not, so a crashed worker
 * keeps its slot until the reconciler resolves it.
 */
export function claimNextAttempt(db: Db, o: ClaimOptions): Promise<Claim | undefined> {
  const readiness = o.readiness ?? defaultReadiness;
  const pageSize = o.pageSize ?? 25;
  const scanLimit = o.scanLimit ?? 1000;
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

    const waiting = await tx.orm
      .select({ orgId: s.jobAttempts.orgId, oldest: sql<string>`min(${s.jobAttempts.id})` })
      .from(s.jobAttempts)
      .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
      .where(
        and(
          eq(s.jobAttempts.state, "queued"),
          eq(s.jobs.state, "queued"),
          isNull(s.jobAttempts.leaseOwner),
        ),
      )
      .groupBy(s.jobAttempts.orgId);
    const orgs = waiting
      .filter((w) => (perOrg.get(w.orgId) ?? 0) < o.perOrgCap)
      .toSorted(
        (x, y) =>
          (perOrg.get(x.orgId) ?? 0) - (perOrg.get(y.orgId) ?? 0) ||
          x.oldest.localeCompare(y.oldest),
      )
      .map((w) => w.orgId);
    const cursor = new Map<string, string>(orgs.map((id) => [id, ""]));
    const open = new Set(orgs);
    let scanned = 0;

    while (open.size > 0 && scanned < scanLimit) {
      for (const orgId of orgs) {
        if (!open.has(orgId) || scanned >= scanLimit) continue;
        const page = await tx.orm
          .select({ attempt: s.jobAttempts, job: s.jobs })
          .from(s.jobAttempts)
          .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
          .where(
            and(
              eq(s.jobAttempts.orgId, orgId),
              eq(s.jobAttempts.state, "queued"),
              eq(s.jobs.state, "queued"),
              isNull(s.jobAttempts.leaseOwner),
              gt(s.jobAttempts.id, cursor.get(orgId)!),
            ),
          )
          .orderBy(asc(s.jobAttempts.id))
          .limit(Math.min(pageSize, scanLimit - scanned));
        if (page.length === 0) {
          open.delete(orgId);
          continue;
        }
        cursor.set(orgId, page.at(-1)!.attempt.id);
        for (const c of page) {
          scanned++;
          const scope = { orgId: c.attempt.orgId, projectId: c.attempt.projectId };
          if (needsDecision(c.job)) {
            const siblings = await listJobs(tx, scope, c.job.runId);
            // Resolved earlier in this scan: no longer queued.
            const self = siblings.find((j) => j.id === c.job.id);
            if (!self || self.state !== "queued") continue;
            const decision = readiness(
              c.job,
              depStates(c.job, siblings, await latestReasons(tx, scope, c.job.runId)),
              await getRun(tx, scope, c.job.runId),
            ).decision;
            if (decision === "wait") continue;
            if (decision === "skip" || decision === "cancel") {
              await resolveDependents(tx, scope, c.job.runId, readiness);
              continue;
            }
            // strategy.max-parallel: legs of one matrix job running at once.
            const planned = c.job.planned
              ? (JSON.parse(c.job.planned) as { id?: string; maxParallel?: number })
              : undefined;
            if (planned?.maxParallel !== undefined && planned.id !== undefined) {
              const legsRunning = siblings.filter(
                (j) =>
                  j.state === "running" &&
                  j.planned !== null &&
                  (JSON.parse(j.planned) as { id?: string }).id === planned.id,
              ).length;
              if (legsRunning >= planned.maxParallel) continue;
            }
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
      }
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

/**
 * Stores the attempt's resolved job plan (JSON) when it starts, so a restarted controller can
 * re-attach without fetching the repo. Fenced by the lease owner.
 */
export function recordPlan(
  db: Db,
  scope: Scope,
  attemptId: string,
  owner: string,
  planJson: string,
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.jobAttempts)
      .set({ plan: planJson })
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
  /** How dependents of this job are resolved. Default: plain `needs`. */
  readiness?: Readiness;
  /** The job's outputs, kept for its dependents (`needs.<id>.outputs.*`). */
  outputs?: Record<string, string> | undefined;
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
    if (input.outputs && Object.keys(input.outputs).length > 0) {
      await tx.orm
        .update(s.jobs)
        .set({ outputs: JSON.stringify(input.outputs) })
        .where(eq(s.jobs.id, cur.jobId));
    }
    if (job) {
      // strategy.fail-fast: a failed matrix leg cancels the legs of its job that have not started.
      const planned = job.planned
        ? (JSON.parse(job.planned) as {
            id?: string;
            failFast?: boolean;
            continueOnError?: boolean;
          })
        : undefined;
      if (
        planned?.failFast &&
        planned.id !== undefined &&
        job.matrix !== null &&
        (input.state === "failure" || input.state === "infra_error") &&
        !planned.continueOnError
      ) {
        for (const sib of await listJobs(tx, scope, job.runId)) {
          if (sib.state !== "queued" || sib.id === job.id || sib.planned === null) continue;
          if ((JSON.parse(sib.planned) as { id?: string }).id !== planned.id) continue;
          await transitionJob(tx, scope, sib.id, "cancelled");
          const live = (await listAttempts(tx, scope, sib.id)).findLast(
            (a) => a.state === "queued",
          );
          if (live) {
            await updateAttempt(tx, scope, live.id, {
              state: "cancelled",
              errorClass: "matrix fail-fast",
            });
          }
        }
      }
      // Dependents that can never run leave the queue now, in this same transaction.
      await resolveDependents(tx, scope, job.runId, input.readiness);
      const states = effectiveStates(await listJobs(tx, scope, job.runId));
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

/** True when `owner` holds the live lease on a running attempt. */
async function holdsLease(h: Db, scope: Scope, attemptId: string, owner: string): Promise<boolean> {
  const [row] = await h.orm
    .select({ id: s.jobAttempts.id })
    .from(s.jobAttempts)
    .where(
      scoped(
        scope,
        { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
        eq(s.jobAttempts.id, attemptId),
        eq(s.jobAttempts.state, "running"),
        eq(s.jobAttempts.leaseOwner, owner),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Appends a log chunk only while `owner` still holds the lease, so a worker that lost its lease
 * (reconciled, cancelled) cannot write into a log someone else now owns. False means dropped.
 */
export function appendLogFenced(
  db: Db,
  scope: Required<Scope>,
  attemptId: string,
  owner: string,
  offset: number,
  bytes: Uint8Array,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await holdsLease(tx, scope, attemptId, owner))) return false;
    return appendLog(tx, scope, attemptId, offset, bytes);
  });
}

/** Runs `fn` only while `owner` holds the lease (steps and cuts of a worker that lost it are dropped). */
export function ifLeaseHeld<T>(
  db: Db,
  scope: Scope,
  attemptId: string,
  owner: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  return db.transaction(async (tx) =>
    (await holdsLease(tx, scope, attemptId, owner)) ? fn() : undefined,
  );
}

/**
 * Wipes an attempt's stored log, steps and cuts so a re-attached worker can replay the whole exec
 * log and write it afresh (chunk boundaries differ between runs, so appending would garble it).
 * Fenced by the lease. Returns false when `owner` does not hold it.
 */
export function resetAttemptOutput(
  db: Db,
  scope: Scope,
  attemptId: string,
  owner: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await holdsLease(tx, scope, attemptId, owner))) return false;
    await tx.orm
      .delete(s.logChunks)
      .where(
        scoped(
          scope,
          { orgId: s.logChunks.orgId, projectId: s.logChunks.projectId },
          eq(s.logChunks.attemptId, attemptId),
        ),
      );
    await tx.orm
      .delete(s.attemptSteps)
      .where(
        scoped(
          scope,
          { orgId: s.attemptSteps.orgId, projectId: s.attemptSteps.projectId },
          eq(s.attemptSteps.attemptId, attemptId),
        ),
      );
    await tx.orm
      .delete(s.logCuts)
      .where(
        scoped(
          scope,
          { orgId: s.logCuts.orgId, projectId: s.logCuts.projectId },
          eq(s.logCuts.attemptId, attemptId),
        ),
      );
    return true;
  });
}

/**
 * Takes over a running attempt whose lease has expired: the new owner gets a fresh lease and the
 * old owner is fenced out from then on (its heartbeat and finish no longer match). Returns the
 * claim, or undefined when the lease is not expired or the attempt is no longer running.
 */
export function takeExpiredLease(
  db: Db,
  attemptId: string,
  o: { owner: string; leaseMs: number; now: number },
): Promise<Claim | undefined> {
  return db.transaction(async (tx) => {
    const rows = await tx.orm
      .update(s.jobAttempts)
      .set({ leaseOwner: o.owner, leaseExpiresAt: o.now + o.leaseMs, heartbeatAt: o.now })
      .where(
        and(
          eq(s.jobAttempts.id, attemptId),
          eq(s.jobAttempts.state, "running"),
          lt(s.jobAttempts.leaseExpiresAt, o.now),
        ),
      )
      .returning({
        orgId: s.jobAttempts.orgId,
        projectId: s.jobAttempts.projectId,
        jobId: s.jobAttempts.jobId,
      });
    const row = rows[0];
    if (!row) return undefined;
    const scope = { orgId: row.orgId, projectId: row.projectId };
    const [attempt] = await tx.orm
      .select()
      .from(s.jobAttempts)
      .where(eq(s.jobAttempts.id, attemptId))
      .limit(1);
    const [job] = await tx.orm.select().from(s.jobs).where(eq(s.jobs.id, row.jobId)).limit(1);
    const run = await getRun(tx, scope, job!.runId);
    return { attempt: attempt!, job: job!, run: run!, scope };
  });
}
