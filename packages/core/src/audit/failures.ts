// Audit entries for failures that happen before there is a principal or a scope: a bad token, a
// forged webhook signature. They go in the owning org's chain when it is known, and in the
// `_system` org's chain when it is not (an unknown token names no org). A flood of failures must
// not become a flood of rows, so each chain takes a bounded number per minute and says how many
// it dropped in the next entry it does take.
import type { Db } from "../db";
import { appendAudit, createOrg, getOrgBySlug } from "../db/repos";

export const SYSTEM_ORG_SLUG = "_system";

/** Failure entries one chain accepts per window. */
export const FAILURE_LIMIT = 30;
export const FAILURE_WINDOW_MS = 60_000;

interface Bucket {
  windowStart: number;
  count: number;
  dropped: number;
}
const buckets = new Map<string, Bucket>();

/** Test hook: forget throttle state. */
export function resetFailureThrottle(): void {
  buckets.clear();
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
}

/** Records a failure, throttled per chain. Never throws: auditing must not break the request. */
export async function auditFailure(
  db: Db,
  e: FailureEntry,
  now: () => number = Date.now,
): Promise<void> {
  try {
    const orgId = e.orgId ?? (await systemOrgId(db));
    const t = now();
    let b = buckets.get(orgId);
    if (!b || t - b.windowStart >= FAILURE_WINDOW_MS) {
      b = { windowStart: t, count: 0, dropped: b?.dropped ?? 0 };
      buckets.set(orgId, b);
    }
    if (b.count >= FAILURE_LIMIT) {
      b.dropped += 1;
      return;
    }
    b.count += 1;
    const dropped = b.dropped;
    b.dropped = 0;
    await appendAudit(
      db,
      { orgId },
      {
        principalKind: e.principalKind,
        principalId: e.principalId,
        op: e.op,
        effect: "auth",
        outcome: e.outcome,
        input: { ...e.detail, ...(dropped > 0 ? { dropped_since_last: dropped } : {}) },
      },
    );
  } catch {
    // best effort
  }
}
