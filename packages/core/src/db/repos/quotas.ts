// Per-org quotas (#52): the limits, the usage they are measured against, and the 80% and 100%
// notices. Instance-level reads (the claim loop asks about orgs before it has a scope), so these
// take an org id; the ops that expose them are org-scoped.
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { logStoreFor } from "../../logstore/registry";
import { appendEvent } from "./events";
import { sandboxSeconds } from "./usage";

export type OrgQuotas = {
  maxConcurrent: number | null;
  maxRunsPerHour: number | null;
  maxSandboxMinutesPerDay: number | null;
  maxLogBytes: number | null;
  maxStoredBytes: number | null;
};

export const NO_QUOTAS: OrgQuotas = {
  maxConcurrent: null,
  maxRunsPerHour: null,
  maxSandboxMinutesPerDay: null,
  maxLogBytes: null,
  maxStoredBytes: null,
};

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export async function getOrgQuotas(db: Db, orgId: string): Promise<OrgQuotas> {
  return db.run(async (h) => {
    const [r] = await h.orm.select().from(s.orgQuotas).where(eq(s.orgQuotas.orgId, orgId)).limit(1);
    if (!r) return NO_QUOTAS;
    return {
      maxConcurrent: r.maxConcurrent,
      maxRunsPerHour: r.maxRunsPerHour,
      maxSandboxMinutesPerDay: r.maxSandboxMinutesPerDay,
      maxLogBytes: r.maxLogBytes,
      maxStoredBytes: r.maxStoredBytes,
    };
  });
}

/** Orgs that have at least one limit set: the only ones the claim loop has to look at. */
export async function orgsWithQuotas(db: Db): Promise<Map<string, OrgQuotas>> {
  return db.run(async (h) => {
    const rows = await h.orm.select().from(s.orgQuotas);
    return new Map(
      rows.map((r) => [
        r.orgId,
        {
          maxConcurrent: r.maxConcurrent,
          maxRunsPerHour: r.maxRunsPerHour,
          maxSandboxMinutesPerDay: r.maxSandboxMinutesPerDay,
          maxLogBytes: r.maxLogBytes,
          maxStoredBytes: r.maxStoredBytes,
        },
      ]),
    );
  });
}

/** Sets the given limits (null clears one); the others are left as they are. */
export function setOrgQuotas(
  db: Db,
  orgId: string,
  patch: Partial<OrgQuotas>,
  by: string,
  now: number,
): Promise<OrgQuotas> {
  return db.transaction(async (tx) => {
    const cur = await getOrgQuotas(tx, orgId);
    const next: OrgQuotas = { ...cur, ...patch };
    const row = { orgId, ...next, updatedBy: by, updatedAt: now };
    await tx.orm
      .insert(s.orgQuotas)
      .values(row)
      .onConflictDoUpdate({ target: s.orgQuotas.orgId, set: row });
    return next;
  });
}

export type QuotaUsage = {
  /** Attempts running now. */
  concurrent: number;
  /** Distinct runs with an attempt started in the last hour. */
  runsLastHour: number;
  /** Sandbox time in the last 24 hours, in whole minutes: create to destroy, else to the attempt's finish, a running one to now (usage.ts). */
  sandboxMinutesLastDay: number;
  /** Running attempts in that figure, counted to now (an estimate). */
  sandboxEstimated: number;
  /** Null when the org has no `max_log_bytes` limit: not measured (summing log blobs is a full scan). */
  logBytes: number | null;
  storedBytes: number;
};

/** Stored artifact and cache bytes of an org: what the `stored_bytes` quota is measured against. */
export function orgStoredBytes(db: Db, orgId: string): Promise<number> {
  return db.run((h) => storedBytesIn(h, orgId));
}

async function storedBytesIn(
  h: Parameters<Parameters<Db["run"]>[0]>[0],
  orgId: string,
): Promise<number> {
  // A size below zero (a row that predates the check in recordArtifact) never lowers the sum.
  const [arts] = await h.orm
    .select({
      n: sql<number>`coalesce(sum(case when ${s.artifacts.size} > 0 then ${s.artifacts.size} else 0 end), 0)`.mapWith(
        Number,
      ),
    })
    .from(s.artifacts)
    .where(eq(s.artifacts.orgId, orgId));
  // The control-plane cache counts too: complete entries and live reservations (the cache has
  // its own per-class shares inside this org; this is the org-wide figure).
  const [cache] = await h.orm
    .select({
      n: sql<number>`coalesce(sum(case when ${s.cacheEntries.size} > 0 then ${s.cacheEntries.size} else 0 end), 0)`.mapWith(
        Number,
      ),
    })
    .from(s.cacheEntries)
    .where(eq(s.cacheEntries.orgId, orgId));
  return Number(arts?.n ?? 0) + Number(cache?.n ?? 0);
}

export async function quotaUsage(
  db: Db,
  orgId: string,
  now: number,
  limits: Pick<OrgQuotas, "maxLogBytes">,
): Promise<QuotaUsage> {
  // The same exact figure the Usage page shows: provider create to destroy, finish or now (see usage.ts).
  const sandbox = await sandboxSeconds(db, { orgId }, { from: now - DAY_MS, to: now, now });
  return db.run(async (h) => {
    const [conc] = await h.orm
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(s.jobAttempts)
      .where(and(eq(s.jobAttempts.orgId, orgId), eq(s.jobAttempts.state, "running")));
    const [runs] = await h.orm
      .select({ n: sql<number>`count(distinct ${s.jobs.runId})`.mapWith(Number) })
      .from(s.jobAttempts)
      .innerJoin(s.jobs, eq(s.jobs.id, s.jobAttempts.jobId))
      .where(
        and(
          eq(s.jobAttempts.orgId, orgId),
          isNotNull(s.jobAttempts.startedAt),
          gte(s.jobAttempts.startedAt, now - HOUR_MS),
        ),
      );
    // Summing log bytes scans the whole store for the org: only worth it when a limit needs it.
    const logBytes = limits.maxLogBytes !== null ? await logStoreFor(h).orgBytes(orgId) : null;
    const stored = await storedBytesIn(h, orgId);
    return {
      concurrent: Number(conc?.n ?? 0),
      runsLastHour: Number(runs?.n ?? 0),
      sandboxMinutesLastDay: Math.floor(sandbox.seconds / 60),
      sandboxEstimated: sandbox.estimated,
      logBytes,
      storedBytes: stored,
    };
  });
}

export type QuotaMetric = "runs_per_hour" | "sandbox_minutes" | "log_bytes" | "stored_bytes";

export type QuotaStatus = {
  metric: QuotaMetric | "concurrent";
  /** Null when not measured (log bytes without a limit). */
  used: number | null;
  limit: number | null;
  /** Percent of the limit, rounded down; null with no limit. */
  percent: number | null;
  /** Set when a new claim is held because of this limit. */
  held: string | null;
  /**
   * The figure includes an estimate (sandbox minutes only): an attempt still running counts to
   * now, never past its sandbox TTL.
   */
  estimated: boolean;
};

/** Each limit against its usage, with the reason new claims are held when one is reached. */
export function quotaStatuses(q: OrgQuotas, u: QuotaUsage): QuotaStatus[] {
  const mk = (
    metric: QuotaStatus["metric"],
    used: number | null,
    limit: number | null,
    what: string,
    estimated = false,
  ): QuotaStatus => ({
    metric,
    used,
    estimated,
    limit,
    percent:
      limit === null || limit === 0 || used === null ? null : Math.floor((used / limit) * 100),
    held:
      limit !== null && used !== null && used >= limit
        ? `new work is held: ${what} reached its limit (${used} of ${limit})`
        : null,
  });
  return [
    mk("concurrent", u.concurrent, q.maxConcurrent, "concurrent attempts"),
    mk("runs_per_hour", u.runsLastHour, q.maxRunsPerHour, "runs started in the last hour"),
    mk(
      "sandbox_minutes",
      u.sandboxMinutesLastDay,
      q.maxSandboxMinutesPerDay,
      "sandbox minutes in the last 24 hours",
      u.sandboxEstimated > 0,
    ),
    mk("log_bytes", u.logBytes, q.maxLogBytes, "stored log bytes"),
    mk("stored_bytes", u.storedBytes, q.maxStoredBytes, "stored artifact and cache bytes"),
  ];
}

/**
 * Emits one event when a limit first crosses 80% and one when it is reached, per window (hourly
 * and daily metrics re-arm each window; byte gauges re-arm when they fall back under 80%). The
 * event is `quota.warning` or `quota.reached`, scoped to the org (no project, no run).
 */
export async function emitQuotaNotices(
  db: Db,
  orgId: string,
  statuses: readonly QuotaStatus[],
  now: number,
): Promise<void> {
  for (const st of statuses) {
    if (st.metric === "concurrent" || st.limit === null) continue;
    const window =
      st.metric === "runs_per_hour"
        ? `h${Math.floor(now / HOUR_MS)}`
        : st.metric === "sandbox_minutes"
          ? `d${Math.floor(now / DAY_MS)}`
          : "total";
    const pct = st.percent ?? 0;
    if (window === "total" && pct < 80) {
      await db.run(async (h) => {
        await h.orm
          .delete(s.quotaNotices)
          .where(and(eq(s.quotaNotices.orgId, orgId), eq(s.quotaNotices.metric, st.metric)));
      });
      continue;
    }
    for (const [level, at] of [
      ["warning", 80],
      ["reached", 100],
    ] as const) {
      if (pct < at) continue;
      const fresh = await db.run(async (h) => {
        const r = await h.orm
          .insert(s.quotaNotices)
          .values({ orgId, metric: st.metric, level, window, createdAt: now })
          .onConflictDoNothing()
          .returning({ m: s.quotaNotices.metric });
        return r.length > 0;
      });
      if (fresh) {
        await appendEvent(
          db,
          { orgId },
          {
            type: level === "warning" ? "quota.warning" : "quota.reached",
            payload: {
              metric: st.metric,
              used: st.used,
              limit: st.limit,
              percent: pct,
            },
          },
        );
      }
    }
  }
}
