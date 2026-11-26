// The solo-to-strict ratchet of the built-in approval default (#663).
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "..";
import type { DefaultMode } from "../../approvals/policy-setting";
import * as s from "../schema";
import { appendAudit } from "./audit";
import { getStoredSetting, putStoredSetting } from "./settings";

/** Internal org marker, not a registry setting: set once the org has had two eligible people. */
const STRICT_MARKER_KEY = "approval_default_strict";

/** People who could enrol and approve: distinct owners and admins of the org (#663). */
export function countEligiblePeople(db: Db, orgId: string): Promise<number> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({ userId: s.orgMembers.userId })
      .from(s.orgMembers)
      .where(and(eq(s.orgMembers.orgId, orgId), inArray(s.orgMembers.role, ["owner", "admin"])));
    return new Set(rows.map((r) => r.userId)).size;
  });
}

/**
 * Which built-in default the org is under. Pure read: it never writes, so it is safe from inside
 * a transaction. Solo while exactly one owner or admin exists and the strict marker is unset;
 * strict once the marker is set or two people are eligible now (no one: strict, nobody to relax
 * for). The marker is written by `ratchetApprovalDefault`, in the transaction of the membership
 * write that brings the count to two, so removing the second person never relaxes the org.
 */
export async function approvalDefaultMode(db: Db, orgId: string): Promise<DefaultMode> {
  const target = { kind: "org", id: orgId, orgId } as const;
  if (await getStoredSetting(db, target, STRICT_MARKER_KEY)) return "strict";
  return (await countEligiblePeople(db, orgId)) === 1 ? "solo" : "strict";
}

/**
 * Call inside the transaction of every write that adds or raises an owner or admin. If the org
 * now has two or more, writes the strict marker (compare-and-set) and audits the switch once.
 */
export async function ratchetApprovalDefault(db: Db, orgId: string): Promise<void> {
  const target = { kind: "org", id: orgId, orgId } as const;
  if (await getStoredSetting(db, target, STRICT_MARKER_KEY)) return;
  const eligible = await countEligiblePeople(db, orgId);
  if (eligible < 2) return;
  const won = await putStoredSetting(db, target, STRICT_MARKER_KEY, true, "system", Date.now(), {
    raw: undefined,
  });
  if (won)
    await appendAudit(
      db,
      { orgId },
      {
        principalKind: "system",
        principalId: "approvals",
        op: "approval_default.strict",
        effect: "write",
        outcome: "ok",
        input: { eligible, from: "solo", to: "strict" },
      },
    );
}

/**
 * Boot step (#663): writes the strict marker for every org that already has two or more owners
 * or admins, so an org that had two people before the ratchet shipped never relaxes to solo when
 * one leaves. Idempotent (the ratchet is a compare-and-set that skips marked orgs) and cheap, so
 * it runs on every boot, before the server serves. A boot step, not a migration: it needs the
 * settings write path and the audit chain, which raw SQL in an embedded migration would bypass,
 * and it must behave the same on both dialects. Returns the number of orgs it newly marked.
 */
export async function backfillApprovalDefaultStrict(db: Db): Promise<number> {
  const rows = await db.run((h) =>
    h.orm
      .selectDistinct({ orgId: s.orgMembers.orgId })
      .from(s.orgMembers)
      .where(inArray(s.orgMembers.role, ["owner", "admin"])),
  );
  let marked = 0;
  for (const { orgId } of rows) {
    const target = { kind: "org", id: orgId, orgId } as const;
    if (await getStoredSetting(db, target, STRICT_MARKER_KEY)) continue;
    await db.transaction((tx) => ratchetApprovalDefault(tx, orgId));
    if (await getStoredSetting(db, target, STRICT_MARKER_KEY)) marked++;
  }
  return marked;
}
