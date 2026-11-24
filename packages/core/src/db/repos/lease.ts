// Scheduler persistence: claiming queued attempts under a lease, heartbeats, fenced finishing,
// and finding abandoned work. Claim and reconcile are instance-level (a worker has no tenant
// until it has claimed something), so they are intentionally unscoped; everything they return
// carries the tenant scope the caller then uses.
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  sql,
} from "drizzle-orm";
import type { Db } from "..";
import { announceCancelled } from "../abort-bus";
import { aggregateRunStatus } from "../job-state";
import * as s from "../schema";
import {
  appendLog,
  createAttempt,
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
import { appendAudit } from "./audit";
import { notFrozen } from "./incident";
import {
  emitQuotaNotices,
  HOUR_MS,
  orgsWithQuotas,
  quotaStatuses,
  quotaUsage,
  type QuotaStatus,
  type QuotaUsage,
} from "./quotas";
import { groupBlocked } from "./poll";
import { projectsWithCaps, yieldProjects } from "./project-settings";
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
  /**
   * How long a per-org quota reading may be reused (the byte gauges are sums over big tables).
   * Default 0: every claim reads fresh. The scheduler passes a few seconds.
   */
  quotaCacheMs?: number;
  /** Decides whether a queued job may run. Default: plain `needs` (see defaultReadiness). */
  readiness?: Readiness;
  /** Queued rows examined per org per round. Default 25. */
  pageSize?: number;
  /** Most queued rows examined in one claim, across all orgs. Default 1000. */
  scanLimit?: number;
  /**
   * Claim only this run's attempts (a `turntable run` process running its own run), and count
   * only its attempts against the caps. Without it, runs started by `turntable run` (`local`)
   * are never claimed.
   */
  onlyRun?: string;
  /**
   * Anti-thrash (#355): a job preempted `max` times within `windowMs` is no longer preempted until
   * it finishes. `max` 0 means no limit, which is the default; the scheduler passes the
   * `preempt_max_per_job` and `preempt_window_minutes` settings.
   */
  preemptLimit?: { max: number; windowMs: number };
};

/** The defaults of `preemptLimit`, mirrored by the settings of the same names. */
export const DEFAULT_PREEMPT_LIMIT = { max: 0, windowMs: 60 * 60_000 } as const;

const usageCache = new WeakMap<Db, Map<string, { at: number; usage: QuotaUsage }>>();
async function cachedUsage(db: Db, orgId: string, now: number, ttl: number): Promise<QuotaUsage> {
  let m = usageCache.get(db);
  if (!m) usageCache.set(db, (m = new Map()));
  const hit = m.get(orgId);
  if (ttl > 0 && hit && Math.abs(now - hit.at) < ttl) return hit.usage;
  const usage = await quotaUsage(db, orgId, now);
  m.set(orgId, { at: now, usage });
  return usage;
}

const noticeAt = new WeakMap<Db, Map<string, number>>();
async function noticesOnce(
  db: Db,
  orgId: string,
  statuses: readonly QuotaStatus[],
  now: number,
  ttl: number,
): Promise<void> {
  let m = noticeAt.get(db);
  if (!m) noticeAt.set(db, (m = new Map()));
  const last = m.get(orgId);
  if (ttl > 0 && last !== undefined && Math.abs(now - last) < ttl) return;
  m.set(orgId, now);
  await emitQuotaNotices(db, orgId, statuses, now);
}

/** Runs that have an attempt started at or after `since`. */
async function runsStartedSince(db: Db, orgId: string, since: number): Promise<Set<string>> {
  const rows = await db.orm
    .selectDistinct({ runId: s.jobs.runId })
    .from(s.jobAttempts)
    .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
    .where(
      and(
        eq(s.jobAttempts.orgId, orgId),
        isNotNull(s.jobAttempts.startedAt),
        gte(s.jobAttempts.startedAt, since),
      ),
    );
  return new Set(rows.map((r) => r.runId));
}

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
/** Run events that are claimed ahead of PR runs within a project: trust class protected. */
const PROTECTED_EVENTS: string[] = ["push", "merge_group"];

export function claimNextAttempt(db: Db, o: ClaimOptions): Promise<Claim | undefined> {
  const readiness = o.readiness ?? defaultReadiness;
  const pageSize = o.pageSize ?? 25;
  const scanLimit = o.scanLimit ?? 1000;
  return db.transaction(async (tx) => {
    const running = await tx.orm
      .select({
        orgId: s.jobAttempts.orgId,
        projectId: s.jobAttempts.projectId,
        n: sql<number>`count(*)`.mapWith(Number),
      })
      .from(s.jobAttempts)
      .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
      .innerJoin(s.runs, eq(s.runs.id, s.jobs.runId))
      .where(
        and(
          eq(s.jobAttempts.state, "running"),
          // A local run's attempts use only their own process's slots.
          o.onlyRun ? eq(s.jobs.runId, o.onlyRun) : eq(s.runs.local, false),
        ),
      )
      .groupBy(s.jobAttempts.orgId, s.jobAttempts.projectId);
    const perOrg = new Map<string, number>();
    for (const r of running) perOrg.set(r.orgId, (perOrg.get(r.orgId) ?? 0) + Number(r.n));
    let total = 0;
    for (const n of perOrg.values()) total += n;
    // Per-project caps: a project with `max_concurrent` set holds new work once that many of its
    // attempts run. Like the org quota it can only lower the instance's per-org cap. Projects at
    // their cap are left out of both queries below, so their queued attempts neither use up the
    // scan nor hide another project's ready one.
    const caps = await projectsWithCaps(tx);
    const projectFull: string[] = [];
    for (const [projectId, cap] of caps) {
      const used = running
        .filter((r) => r.projectId === projectId)
        .reduce((n, r) => n + Number(r.n), 0);
      if (used >= Math.min(cap, o.perOrgCap)) projectFull.push(projectId);
    }
    const notProjectFull =
      projectFull.length > 0 ? [notInArray(s.jobAttempts.projectId, projectFull)] : [];

    // Per-org quotas (#52). Only orgs with a limit set are looked at. A stored concurrency limit
    // lowers the instance's per-org cap for the org; the other limits hold new work when reached, and say
    // why in `get_quotas` and in an event at 80% and 100%.
    const quotas = await orgsWithQuotas(tx);
    // Quotas limit tenants: a stored limit can lower an org's cap, never lift it above the
    // instance's per-org cap (whatever a row says).
    const capOf = (orgId: string) =>
      Math.min(quotas.get(orgId)?.maxConcurrent ?? Infinity, o.perOrgCap);
    // Scheduling classes: a `yield` project's work is claimed only when no `normal` work can be.
    const yieldIds = await yieldProjects(tx);
    const pass = async (
      klass: "all" | "normal" | "yield",
      probe: boolean,
    ): Promise<Claim | { blockedOrg: string } | undefined> => {
      const classFilter =
        klass === "all" || yieldIds.size === 0
          ? []
          : klass === "normal"
            ? [notInArray(s.jobAttempts.projectId, [...yieldIds])]
            : [inArray(s.jobAttempts.projectId, [...yieldIds])];
      if (!probe && total >= o.globalCap) return undefined;
      const waiting = await tx.orm
        .select({ orgId: s.jobAttempts.orgId, oldest: sql<string>`min(${s.jobAttempts.id})` })
        .from(s.jobAttempts)
        .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
        .innerJoin(s.runs, eq(s.runs.id, s.jobs.runId))
        .where(
          and(
            eq(s.jobAttempts.state, "queued"),
            eq(s.jobs.state, "queued"),
            isNull(s.jobAttempts.leaseOwner),
            o.onlyRun ? eq(s.jobs.runId, o.onlyRun) : eq(s.runs.local, false),
            notFrozen(s.runs.orgId, s.runs.projectId),
            ...notProjectFull,
            ...classFilter,
          ),
        )
        .groupBy(s.jobAttempts.orgId);
      const heldOrgs = new Set<string>();
      const runsFull = new Map<string, Set<string>>();
      for (const w of waiting) {
        const q = quotas.get(w.orgId);
        if (!q) continue;
        const usage = await cachedUsage(tx, w.orgId, o.now, o.quotaCacheMs ?? 0);
        const statuses = quotaStatuses(q, { ...usage, concurrent: perOrg.get(w.orgId) ?? 0 });
        await noticesOnce(tx, w.orgId, statuses, o.now, o.quotaCacheMs ?? 0);
        if (
          statuses.some(
            (st) => st.metric !== "runs_per_hour" && st.metric !== "concurrent" && st.held,
          )
        )
          heldOrgs.add(w.orgId);
        if (statuses.find((st) => st.metric === "runs_per_hour")?.held) {
          // New runs wait; runs that already started this hour finish their jobs.
          runsFull.set(w.orgId, await runsStartedSince(tx, w.orgId, o.now - HOUR_MS));
        }
      }
      const orgs = waiting
        .filter((w) => !heldOrgs.has(w.orgId))
        // A probe looks past the caps: it asks what would run if there were room.
        .filter((w) => probe || (perOrg.get(w.orgId) ?? 0) < capOf(w.orgId))
        .toSorted(
          (x, y) =>
            (perOrg.get(x.orgId) ?? 0) - (perOrg.get(y.orgId) ?? 0) ||
            x.oldest.localeCompare(y.oldest),
        )
        .map((w) => w.orgId);
      // Org order and round-robin are tier-agnostic. Inside one org's turn, protected runs
      // (push, merge_group) are paged before that org's other runs; FIFO within each tier.
      const TIERS = ["protected", "other"] as const;
      const cursor = new Map<string, string>(
        orgs.flatMap((id) => TIERS.map((t) => [`${id}|${t}`, ""] as const)),
      );
      const open = new Set(orgs);
      let scanned = 0;

      while (open.size > 0 && scanned < scanLimit) {
        for (const orgId of orgs) {
          if (!open.has(orgId) || scanned >= scanLimit) continue;
          let page: {
            attempt: typeof s.jobAttempts.$inferSelect;
            job: typeof s.jobs.$inferSelect;
          }[] = [];
          let tier: (typeof TIERS)[number] = "protected";
          for (tier of TIERS) {
            const cur = cursor.get(`${orgId}|${tier}`);
            if (cur === undefined) continue;
            page = await tx.orm
              .select({ attempt: s.jobAttempts, job: s.jobs })
              .from(s.jobAttempts)
              .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
              .innerJoin(s.runs, eq(s.runs.id, s.jobs.runId))
              .where(
                and(
                  eq(s.jobAttempts.orgId, orgId),
                  eq(s.jobAttempts.state, "queued"),
                  eq(s.jobs.state, "queued"),
                  isNull(s.jobAttempts.leaseOwner),
                  o.onlyRun ? eq(s.jobs.runId, o.onlyRun) : eq(s.runs.local, false),
                  notFrozen(s.runs.orgId, s.runs.projectId),
                  ...notProjectFull,
                  ...classFilter,
                  tier === "protected"
                    ? inArray(s.runs.event, PROTECTED_EVENTS)
                    : notInArray(s.runs.event, PROTECTED_EVENTS),
                  gt(s.jobAttempts.id, cur),
                ),
              )
              .orderBy(asc(s.jobAttempts.id))
              .limit(Math.min(pageSize, scanLimit - scanned));
            if (page.length > 0) break;
            cursor.delete(`${orgId}|${tier}`); // tier exhausted: next tier, same turn
          }
          if (page.length === 0) {
            open.delete(orgId);
            continue;
          }
          cursor.set(`${orgId}|${tier}`, page.at(-1)!.attempt.id);
          for (const c of page) {
            scanned++;
            const scope = { orgId: c.attempt.orgId, projectId: c.attempt.projectId };
            // A run waiting for its concurrency group (an older run of it is still going) starts
            // nothing yet.
            const candRun = await getRun(tx, scope, c.job.runId);
            if (candRun && (await groupBlocked(tx, candRun))) continue;
            const started = runsFull.get(orgId);
            if (started && !started.has(c.job.runId)) continue;
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
            if (probe) return { blockedOrg: orgId };
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
    };

    if (yieldIds.size === 0) return (await pass("all", false)) as Claim | undefined;
    const normal = await pass("normal", false);
    if (normal) return normal as Claim;
    // Nothing normal could be claimed. If a normal attempt waits only for room, free a slot by
    // preempting the newest yield attempt holding one, then claim for the waiting attempt. One
    // victim per call, so a fan-out of waiting normal attempts preempts one yield attempt each.
    const blocked = await pass("normal", true);
    const orgFull =
      blocked !== undefined &&
      "blockedOrg" in blocked &&
      (perOrg.get(blocked.blockedOrg) ?? 0) >= capOf(blocked.blockedOrg);
    // Preempt only when a cap is actually full. Normal work that is claimable with room under
    // both caps (or that lost a claim race) must take no yield attempt's slot.
    if (blocked && "blockedOrg" in blocked && (orgFull || total >= o.globalCap)) {
      const victim = await newestYieldAttempt(tx, yieldIds, {
        ...(orgFull ? { orgId: blocked.blockedOrg } : {}),
        ...(o.onlyRun ? { onlyRun: o.onlyRun } : {}),
        limit: o.preemptLimit ?? DEFAULT_PREEMPT_LIMIT,
        now: o.now,
      });
      if (victim) {
        await preemptAttempt(tx, victim, blocked.blockedOrg, o.now);
        // The slot is free for the claim below: update the counts read at the start.
        total--;
        perOrg.set(victim.orgId, (perOrg.get(victim.orgId) ?? 1) - 1);
        return (await pass("normal", false)) as Claim | undefined;
      }
    }
    return (await pass("yield", false)) as Claim | undefined;
  });
}

/** The attempt error class of a preempted attempt: requeued, never a failure. */
export const PREEMPTED = "preempted";

/**
 * The newest running attempt of a `yield` project (highest id), optionally only in one org. Local
 * runs count only inside their own process's claim, as in `claimNextAttempt`. A job already
 * preempted `limit.max` times inside the window is skipped (anti-thrash): it runs to its end. A
 * `max` of 0 turns that off.
 */
async function newestYieldAttempt(
  tx: Db,
  yieldIds: ReadonlySet<string>,
  within: {
    orgId?: string;
    onlyRun?: string;
    limit: { max: number; windowMs: number };
    now: number;
  },
): Promise<JobAttempt | undefined> {
  const spent =
    within.limit.max < 1
      ? []
      : await tx.orm
          .select({ jobId: s.jobAttempts.jobId })
          .from(s.jobAttempts)
          .where(
            and(
              eq(s.jobAttempts.errorClass, PREEMPTED),
              inArray(s.jobAttempts.projectId, [...yieldIds]),
              gte(s.jobAttempts.finishedAt, within.now - within.limit.windowMs),
            ),
          )
          .groupBy(s.jobAttempts.jobId)
          .having(sql`count(*) >= ${within.limit.max}`);
  const [row] = await tx.orm
    .select({ attempt: s.jobAttempts })
    .from(s.jobAttempts)
    .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
    .innerJoin(s.runs, eq(s.runs.id, s.jobs.runId))
    .where(
      and(
        eq(s.jobAttempts.state, "running"),
        inArray(s.jobAttempts.projectId, [...yieldIds]),
        within.orgId ? eq(s.jobAttempts.orgId, within.orgId) : undefined,
        within.onlyRun ? eq(s.jobs.runId, within.onlyRun) : eq(s.runs.local, false),
        spent.length > 0
          ? notInArray(
              s.jobAttempts.jobId,
              spent.map((r) => r.jobId),
            )
          : undefined,
      ),
    )
    .orderBy(desc(s.jobAttempts.id))
    .limit(1);
  return row?.attempt;
}

/**
 * Stops a running yield attempt so a waiting normal one can have its slot, and requeues its job.
 * Inside the claim's transaction. The attempt ends `cancelled` with the error class `preempted`
 * and keeps its log, steps and sandbox record; the job goes back to `queued` (through
 * `infra_error`, the one existing way back) with a NEW attempt, so no attempt row is reused and the
 * partial log stays readable under the old id. No `rerun_reason` is set, so it uses none of the
 * commit's reruns. The worker is told after commit (the cancel path), and one in another process
 * finds its lease gone at its next heartbeat.
 */
async function preemptAttempt(
  tx: Db,
  victim: JobAttempt,
  forOrgId: string,
  now: number,
): Promise<void> {
  const scope = { orgId: victim.orgId, projectId: victim.projectId };
  await updateAttempt(tx, scope, victim.id, { state: "cancelled", errorClass: PREEMPTED });
  await tx.orm
    .update(s.jobAttempts)
    .set({ leaseOwner: null, leaseExpiresAt: null })
    .where(eq(s.jobAttempts.id, victim.id));
  await transitionJob(tx, scope, victim.jobId, "infra_error", { reason: PREEMPTED });
  const job = await transitionJob(tx, scope, victim.jobId, "queued", { reason: PREEMPTED });
  await createAttempt(tx, scope, { jobId: victim.jobId, provider: victim.provider });
  if (job) {
    const states = effectiveStates(await listJobs(tx, scope, job.runId));
    await setRunStatus(tx, scope, job.runId, aggregateRunStatus(states));
  }
  await appendAudit(tx, scope, {
    principalKind: "system",
    principalId: "scheduler",
    op: "scheduler.preempt",
    effect: "write",
    outcome: "ok",
    input: {
      attempt_id: victim.id,
      job_id: victim.jobId,
      scheduling_class: "yield",
      for_org_id: forOrgId,
      at: now,
    },
  });
  announceCancelled(tx, [
    { attemptId: victim.id, sandboxId: victim.sandboxId, provider: victim.provider },
  ]);
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
  where: {
    sandboxId?: string | undefined;
    execId?: string | undefined;
    /** Epoch ms the provider's create returned. */
    sandboxCreatedAt?: number | undefined;
    /** The provider's effective TTL for the sandbox, in seconds. */
    sandboxTtlSeconds?: number | undefined;
    /** Epoch ms the provider confirmed the destroy. */
    sandboxDestroyedAt?: number | undefined;
  },
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.jobAttempts)
      .set({
        ...(where.sandboxId === undefined ? {} : { sandboxId: where.sandboxId }),
        ...(where.execId === undefined ? {} : { execId: where.execId }),
        ...(where.sandboxCreatedAt === undefined
          ? {}
          : { sandboxCreatedAt: where.sandboxCreatedAt }),
        ...(where.sandboxTtlSeconds === undefined
          ? {}
          : { sandboxTtlSeconds: where.sandboxTtlSeconds }),
        ...(where.sandboxDestroyedAt === undefined
          ? {}
          : { sandboxDestroyedAt: where.sandboxDestroyedAt }),
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
 * Records the class the attempt runs as (after the demotion rule). Write-once and fenced by the
 * lease owner: the class can be recorded, never changed or raised afterwards.
 */
export function recordTrustClass(
  db: Db,
  scope: Scope,
  attemptId: string,
  owner: string,
  klass: string,
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.jobAttempts)
      .set({ trustClass: klass })
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          eq(s.jobAttempts.id, attemptId),
          eq(s.jobAttempts.state, "running"),
          eq(s.jobAttempts.leaseOwner, owner),
          isNull(s.jobAttempts.trustClass),
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

/**
 * Attempts that recorded a sandbox and no confirmed destroy, across every org (system work, for
 * the provider's own-fleet count and the sweep). Newest first, bounded.
 */
export function listUndestroyedSandboxes(db: Db, limit = 2000): Promise<JobAttempt[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.jobAttempts)
      .where(and(isNotNull(s.jobAttempts.sandboxId), isNull(s.jobAttempts.sandboxDestroyedAt)))
      .orderBy(desc(s.jobAttempts.id))
      .limit(limit),
  );
}

/** Number of attempts currently running, overall or for one org. */
export function countRunning(db: Db, orgId?: string): Promise<number> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
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
