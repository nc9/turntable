// Audit entries for failures that happen before there is a principal or a scope: a bad token, a
// forged webhook signature. They go in the owning org's chain when it is known, and in the
// `_system` org's chain when it is not (an unknown token names no org). A flood of failures must
// not become a flood of rows, so each chain takes a bounded number per minute and says how many
// it dropped in the next entry it does take.
import type { Db } from "../db";
import { appendAudit, createOrg, getOrgBySlug } from "../db/repos";

export const SYSTEM_ORG_SLUG = "_system";

/**
 * Throttling is per (org, kind, source), so one noisy source cannot use up the budget that
 * records everyone else's failures. A source is a token id, a hashed unknown token or a client
 * address. On top of that, one ceiling per chain bounds the worst case when there are many
 * sources.
 */
export const FAILURE_PER_SOURCE_LIMIT = 5;
export const FAILURE_CHAIN_LIMIT = 300;
export const FAILURE_WINDOW_MS = 60_000;
const MAX_TRACKED = 10_000;

interface Bucket {
  windowStart: number;
  count: number;
  dropped: number;
}
const sourceBuckets = new Map<string, Bucket>();
const chainBuckets = new Map<string, Bucket>();
/** Sources already recorded once. Their first failure is never throttled. */
const seenSources = new Set<string>();
const aggregates = new Map<string, { windowStart: number; count: number; kind: string }>();

/** Test hook: forget throttle state. */
export function resetFailureThrottle(): void {
  sourceBuckets.clear();
  chainBuckets.clear();
  seenSources.clear();
  aggregates.clear();
}

function take(
  map: Map<string, Bucket>,
  key: string,
  limit: number,
  t: number,
): { ok: boolean; dropped: number } {
  let b = map.get(key);
  if (!b || t - b.windowStart >= FAILURE_WINDOW_MS) {
    if (map.size >= MAX_TRACKED) {
      for (const [k, v] of map) if (t - v.windowStart >= FAILURE_WINDOW_MS) map.delete(k);
      if (map.size >= MAX_TRACKED) map.clear();
    }
    b = { windowStart: t, count: 0, dropped: b?.dropped ?? 0 };
    map.set(key, b);
  }
  if (b.count >= limit) {
    b.dropped += 1;
    return { ok: false, dropped: 0 };
  }
  b.count += 1;
  const dropped = b.dropped;
  b.dropped = 0;
  return { ok: true, dropped };
}

/** The org that owns audit entries no real org can claim. Created on first use. */
export async function systemOrgId(db: Db): Promise<string> {
  const existing = await getOrgBySlug(db, SYSTEM_ORG_SLUG);
  if (existing) return existing.id;
  try {
    return (await createOrg(db, { slug: SYSTEM_ORG_SLUG, name: "System" })).id;
  } catch {
    // Lost a race with another writer: it exists now.
    const again = await getOrgBySlug(db, SYSTEM_ORG_SLUG);
    if (again) return again.id;
    throw new Error("could not create the system org");
  }
}

export interface FailureEntry {
  /** The owning org, when the credential identified one. */
  orgId?: string | undefined;
  principalKind: string;
  principalId: string;
  op: string;
  outcome: string;
  detail?: Record<string, unknown>;
  /** Who is failing: a token id, a hashed token, a client address. Default: the principal id. */
  source?: string;
  /** Failure kind for throttling. Default: the outcome. */
  kind?: string;
  /** The source is a known, bounded identity (a real token id): its first failure is always kept. */
  trackFirst?: boolean;
}

/** Records a failure, throttled per source and per chain. Never throws: auditing must not break the request. */
export async function auditFailure(
  db: Db,
  e: FailureEntry,
  now: () => number = Date.now,
): Promise<void> {
  try {
    const orgId = e.orgId ?? (await systemOrgId(db));
    const t = now();
    const source = e.source ?? e.principalId;
    const kind = e.kind ?? e.outcome;
    const seenKey = `${orgId}|${kind}|${source}`;
    let dropped = 0;
    const first = e.trackFirst === true && !seenSources.has(seenKey);
    if (first) {
      if (seenSources.size >= MAX_TRACKED) seenSources.clear();
      seenSources.add(seenKey);
      // Counts toward the budgets but is not refused by them.
      take(sourceBuckets, seenKey, Number.POSITIVE_INFINITY, t);
      take(chainBuckets, orgId, Number.POSITIVE_INFINITY, t);
    } else {
      const perSource = take(sourceBuckets, seenKey, FAILURE_PER_SOURCE_LIMIT, t);
      if (!perSource.ok) return;
      const perChain = take(chainBuckets, orgId, FAILURE_CHAIN_LIMIT, t);
      if (!perChain.ok) return;
      dropped = perSource.dropped;
    }
    await appendAudit(
      db,
      { orgId },
      {
        principalKind: e.principalKind,
        principalId: e.principalId,
        op: e.op,
        effect: "auth",
        outcome: e.outcome,
        input: {
          ...e.detail,
          ...(first ? { first_for_source: true } : {}),
          ...(dropped > 0 ? { dropped_since_last: dropped } : {}),
        },
      },
    );
  } catch {
    // best effort
  }
}

/**
 * Counts an event that is recorded only in aggregate (requests the webhook limiter refused):
 * one entry per window with the count, never one per request. The entry is written when the
 * window has ended, by the next call or by flushAggregates.
 */
export async function auditAggregate(
  db: Db,
  orgId: string,
  kind: string,
  now: () => number = Date.now,
): Promise<void> {
  const t = now();
  const a = aggregates.get(orgId);
  if (a && t - a.windowStart >= FAILURE_WINDOW_MS) await writeAggregate(db, orgId, a);
  const cur = aggregates.get(orgId);
  if (!cur || t - cur.windowStart >= FAILURE_WINDOW_MS) {
    aggregates.set(orgId, { windowStart: t, count: 1, kind });
  } else {
    cur.count += 1;
  }
}

async function writeAggregate(
  db: Db,
  orgId: string,
  a: { windowStart: number; count: number; kind: string },
): Promise<void> {
  aggregates.delete(orgId);
  try {
    await appendAudit(
      db,
      { orgId },
      {
        principalKind: "system",
        principalId: "audit",
        op: a.kind,
        effect: "auth",
        outcome: "error:throttled",
        input: { count: a.count, window_start: a.windowStart, window_ms: FAILURE_WINDOW_MS },
      },
    );
  } catch {
    // best effort
  }
}

/** Writes the aggregates whose window has ended. Called on a timer. */
export async function flushAggregates(db: Db, now: () => number = Date.now): Promise<void> {
  const t = now();
  for (const [orgId, a] of aggregates) {
    if (t - a.windowStart >= FAILURE_WINDOW_MS) await writeAggregate(db, orgId, a);
  }
}
