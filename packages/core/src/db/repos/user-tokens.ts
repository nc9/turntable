// Multi-org user tokens (#547). Not tenant data: a token belongs to a person (a numeric GitHub id)
// and reaches orgs only through that person's memberships, so these functions take no scope. They
// are reached from authentication and from the user's own profile ops. Only hashes are stored.
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { ulid } from "../ulid";

export type UserToken = typeof s.userTokens.$inferSelect;

/** A user holds at most this many live tokens, so a leaked session cannot mint without bound. */
export const MAX_LIVE_USER_TOKENS = 10;

export function insertUserToken(
  db: Db,
  input: { githubUserId: string; name: string; tokenHash: string; expiresAt: number },
): Promise<UserToken> {
  return db.run(async (h) => {
    const id = ulid();
    await h.orm.insert(s.userTokens).values({ id, ...input });
    const [row] = await h.orm.select().from(s.userTokens).where(eq(s.userTokens.id, id)).limit(1);
    return row!;
  });
}

export function findUserTokenByHash(db: Db, tokenHash: string): Promise<UserToken | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.userTokens)
      .where(eq(s.userTokens.tokenHash, tokenHash))
      .limit(1);
    return row;
  });
}

export function getUserToken(db: Db, id: string): Promise<UserToken | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm.select().from(s.userTokens).where(eq(s.userTokens.id, id)).limit(1);
    return row;
  });
}

export function touchUserToken(db: Db, id: string, now: number): Promise<void> {
  return db.run(async (h) => {
    await h.orm.update(s.userTokens).set({ lastUsedAt: now }).where(eq(s.userTokens.id, id));
  });
}

/** One person's tokens, newest first (revoked and expired included, so the profile shows them). */
export function listUserTokens(db: Db, githubUserId: string): Promise<UserToken[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.userTokens)
      .where(eq(s.userTokens.githubUserId, githubUserId))
      .orderBy(desc(s.userTokens.id)),
  );
}

export function countLiveUserTokens(db: Db, githubUserId: string, now: number): Promise<number> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ n: sql<number>`count(*)` })
      .from(s.userTokens)
      .where(
        and(
          eq(s.userTokens.githubUserId, githubUserId),
          sql`${s.userTokens.revokedAt} is null`,
          sql`${s.userTokens.expiresAt} > ${now}`,
        ),
      );
    return Number(row?.n ?? 0);
  });
}

/**
 * Revokes one of THIS person's tokens. False when it is not theirs, does not exist or was
 * already revoked (the three look alike to the caller).
 */
export function revokeUserToken(
  db: Db,
  githubUserId: string,
  id: string,
  now: number,
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.userTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(s.userTokens.id, id),
          eq(s.userTokens.githubUserId, githubUserId),
          sql`${s.userTokens.revokedAt} is null`,
        ),
      )
      .returning({ id: s.userTokens.id });
    return rows.length > 0;
  });
}

/** Records the first use of a token in an org. True only for the call that recorded it. */
export function recordUserTokenOrg(
  db: Db,
  tokenId: string,
  orgId: string,
  now: number,
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .insert(s.userTokenOrgs)
      .values({ tokenId, orgId, firstUsedAt: now })
      .onConflictDoNothing()
      .returning({ tokenId: s.userTokenOrgs.tokenId });
    return rows.length > 0;
  });
}

/** The orgs a token has been used in, for the revoke entry in each org's chain. */
export function listUserTokenOrgs(db: Db, tokenId: string): Promise<string[]> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({ orgId: s.userTokenOrgs.orgId })
      .from(s.userTokenOrgs)
      .where(eq(s.userTokenOrgs.tokenId, tokenId));
    return rows.map((r) => r.orgId);
  });
}
