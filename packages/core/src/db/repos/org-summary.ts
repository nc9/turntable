// Counts only, per org, of the identity state an operator checks before a deploy or a re-enrol:
// tokens, approvers, members by role and pending invites (#469). Instance-level, so it is
// unscoped like `instanceRunActivity`. No id, name, login or key leaves this file.
import { and, gt, isNull, type SQL, sql } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";

const WEEK_MS = 7 * 86_400_000;

export type OrgIdentitySummary = {
  orgId: string;
  tokensActive: number;
  tokensExpiringSoon: number;
  approversActive: number;
  approversRevoked: number;
  approversMissingGithubId: number;
  members: Record<string, number>;
  pendingInvites: number;
};

export function instanceOrgSummary(db: Db, now: number): Promise<OrgIdentitySummary[]> {
  return db.run(async (h) => {
    const num = (e: SQL) => e.mapWith(Number);
    const live = and(
      isNull(s.apiTokens.revokedAt),
      sql`(${s.apiTokens.expiresAt} IS NULL OR ${s.apiTokens.expiresAt} > ${now})`,
    );
    const tokens = await h.orm
      .select({
        orgId: s.apiTokens.orgId,
        active: num(sql`count(*)`),
        soon: num(
          sql`coalesce(sum(CASE WHEN ${s.apiTokens.expiresAt} IS NOT NULL AND ${s.apiTokens.expiresAt} <= ${now + WEEK_MS} THEN 1 ELSE 0 END), 0)`,
        ),
      })
      .from(s.apiTokens)
      .where(live)
      .groupBy(s.apiTokens.orgId);
    const approvers = await h.orm
      .select({
        orgId: s.approvers.orgId,
        active: num(
          sql`coalesce(sum(CASE WHEN ${s.approvers.revokedAt} IS NULL THEN 1 ELSE 0 END), 0)`,
        ),
        revoked: num(
          sql`coalesce(sum(CASE WHEN ${s.approvers.revokedAt} IS NOT NULL THEN 1 ELSE 0 END), 0)`,
        ),
        missing: num(
          sql`coalesce(sum(CASE WHEN ${s.approvers.revokedAt} IS NULL AND ${s.approvers.githubUserId} IS NULL THEN 1 ELSE 0 END), 0)`,
        ),
      })
      .from(s.approvers)
      .groupBy(s.approvers.orgId);
    const members = await h.orm
      .select({ orgId: s.orgMembers.orgId, role: s.orgMembers.role, n: num(sql`count(*)`) })
      .from(s.orgMembers)
      .groupBy(s.orgMembers.orgId, s.orgMembers.role);
    const invites = await h.orm
      .select({ orgId: s.memberInvites.orgId, n: num(sql`count(*)`) })
      .from(s.memberInvites)
      .where(
        and(
          isNull(s.memberInvites.usedAt),
          isNull(s.memberInvites.revokedAt),
          gt(s.memberInvites.expiresAt, now),
        ),
      )
      .groupBy(s.memberInvites.orgId);
    const out = new Map<string, OrgIdentitySummary>();
    const of = (orgId: string): OrgIdentitySummary => {
      let e = out.get(orgId);
      if (!e) {
        e = {
          orgId,
          tokensActive: 0,
          tokensExpiringSoon: 0,
          approversActive: 0,
          approversRevoked: 0,
          approversMissingGithubId: 0,
          members: {},
          pendingInvites: 0,
        };
        out.set(orgId, e);
      }
      return e;
    };
    for (const r of tokens) {
      const e = of(r.orgId);
      e.tokensActive = r.active;
      e.tokensExpiringSoon = r.soon;
    }
    for (const r of approvers) {
      const e = of(r.orgId);
      e.approversActive = r.active;
      e.approversRevoked = r.revoked;
      e.approversMissingGithubId = r.missing;
    }
    for (const r of members) of(r.orgId).members[r.role] = r.n;
    for (const r of invites) of(r.orgId).pendingInvites = r.n;
    return [...out.values()];
  });
}
