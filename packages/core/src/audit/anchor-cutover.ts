// The per-org v2 cutover of the anchor export (#398). The first v2 body an org exports fixes its
// sequence and time; a keyless v1 body is accepted only at or before that sequence, because every
// anchor after it was exported with a key id and must be checked under that key alone.
//
// It is kept as an org-scope row in `settings` (no schema change), written once with a
// compare-and-set so the first export wins and a later one never moves it forward. The row is
// plain data: an attacker who can rewrite the database can delete it, which only re-admits keyless
// bodies, and a keyless body still needs a valid signature under a trusted key.
import type { Db } from "../db";
import { getStoredSetting, putStoredSetting } from "../db/repos";

export const ANCHOR_CUTOVER_KEY = "audit_anchor_v2_cutover";

export interface AnchorCutover {
  seq: number;
  time: number;
}

const target = (orgId: string) => ({ kind: "org" as const, id: orgId, orgId });

/** The org's recorded cutover, or undefined when it never exported a v2 body. */
export async function getAnchorCutover(db: Db, orgId: string): Promise<AnchorCutover | undefined> {
  const v = (await getStoredSetting(db, target(orgId), ANCHOR_CUTOVER_KEY))?.value as
    Partial<AnchorCutover> | undefined;
  return v && Number.isSafeInteger(v.seq) && Number.isSafeInteger(v.time)
    ? { seq: v.seq as number, time: v.time as number }
    : undefined;
}

/** Records the cutover if there is none. The first export wins; returns whether this one did. */
export function recordAnchorCutover(
  db: Db,
  orgId: string,
  c: AnchorCutover,
  now: number,
): Promise<boolean> {
  return putStoredSetting(db, target(orgId), ANCHOR_CUTOVER_KEY, c, "anchor-export", now, {
    raw: undefined,
  });
}
