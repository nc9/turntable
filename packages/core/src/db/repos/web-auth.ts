// Web sign-in (#430): login states, GitHub identities, sessions and member invites. Like the other
// repo modules this is part of the only code that names tenant tables (`member_invites` and
// `org_members` carry an org). Identity is the numeric GitHub user id; a login only matches invites.
import { and, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import type { MemberRole } from "../schema";
import { ulid } from "../ulid";
import { appendAudit } from "./audit";
import { appendEvent } from "./events";
import { type Scope, scoped } from "./scope";

export type WebSession = typeof s.webSessions.$inferSelect;
export type MemberInvite = typeof s.memberInvites.$inferSelect;
export type GithubIdentity = typeof s.githubIdentities.$inferSelect;

/** One org a user belongs to, with the role the database gives them there. */
export type Membership = { orgId: string; slug: string; name: string; role: MemberRole };

// ---- login states ----

/** Records the single-use nonce of a sign-in attempt, and drops the expired ones. */
export function createLoginState(db: Db, nonce: string, expiresAt: number, now: number) {
  return db.run(async (h) => {
    await h.orm.delete(s.loginStates).where(lt(s.loginStates.expiresAt, now));
    await h.orm.insert(s.loginStates).values({ nonce, expiresAt, createdAt: now });
  });
}

/** Atomically spends a nonce: true once, false for an unknown, expired or already used one. */
export function consumeLoginState(db: Db, nonce: string, now: number): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.loginStates)
      .set({ usedAt: now })
      .where(
        and(
          eq(s.loginStates.nonce, nonce),
          isNull(s.loginStates.usedAt),
          gt(s.loginStates.expiresAt, now),
        ),
      )
      .returning({ nonce: s.loginStates.nonce });
    return rows.length === 1;
  });
}

// ---- memberships ----

export function listMembershipsOfUser(db: Db, userId: string): Promise<Membership[]> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({
        orgId: s.orgMembers.orgId,
        slug: s.orgs.slug,
        name: s.orgs.name,
        role: s.orgMembers.role,
      })
      .from(s.orgMembers)
      .innerJoin(s.orgs, eq(s.orgs.id, s.orgMembers.orgId))
      .where(eq(s.orgMembers.userId, userId));
    return rows.map((r) => ({ ...r, role: r.role as MemberRole }));
  });
}

export function getIdentityByUserId(db: Db, userId: string): Promise<GithubIdentity | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.githubIdentities)
      .where(eq(s.githubIdentities.userId, userId))
      .limit(1);
    return row;
  });
}

/** The user a GitHub numeric id signed in as, or undefined when it never has. */
export function getUserIdByGithubUserId(db: Db, githubUserId: string): Promise<string | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ userId: s.githubIdentities.userId })
      .from(s.githubIdentities)
      .where(eq(s.githubIdentities.githubUserId, githubUserId))
      .limit(1);
    return row?.userId;
  });
}

/** The member of `scope`'s org whose GitHub account has this numeric id. */
export function findMemberByGithubUserId(
  db: Db,
  scope: Scope,
  githubUserId: string,
): Promise<{ userId: string; role: MemberRole } | undefined> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({ userId: s.orgMembers.userId, role: s.orgMembers.role })
      .from(s.orgMembers)
      .innerJoin(s.githubIdentities, eq(s.githubIdentities.userId, s.orgMembers.userId))
      .where(
        scoped(
          scope,
          { orgId: s.orgMembers.orgId },
          eq(s.githubIdentities.githubUserId, githubUserId),
        ),
      )
      .limit(1);
    const hit = rows[0];
    return hit ? { userId: hit.userId, role: hit.role as MemberRole } : undefined;
  });
}

// ---- invites ----

/**
 * Creates a pending invite for an account, replacing earlier pending ones for it so only one is
 * ever live. A caller may replace only what `canReplace` allows (nothing more privileged than it
 * could grant, nothing the instance administrator made): if any earlier pending invite is out of
 * reach, nothing changes and `undefined` is returned.
 */
export function createMemberInvite(
  db: Db,
  scope: Scope,
  input: {
    githubLogin: string;
    githubUserId: string;
    role: MemberRole;
    createdBy: string;
    reason?: string | undefined;
    now: number;
    expiresAt: number;
    canReplace: (earlier: { role: string; createdBy: string }) => boolean;
  },
): Promise<MemberInvite | undefined> {
  return db.transaction(async (tx) => {
    const login = input.githubLogin.toLowerCase();
    const live = await tx.orm
      .select()
      .from(s.memberInvites)
      .where(
        scoped(
          scope,
          { orgId: s.memberInvites.orgId },
          eq(s.memberInvites.githubUserId, input.githubUserId),
          isNull(s.memberInvites.usedAt),
          isNull(s.memberInvites.revokedAt),
          gt(s.memberInvites.expiresAt, input.now),
        ),
      );
    if (live.some((e) => !input.canReplace(e))) return undefined;
    // Exactly the rows that were checked, by id, and no others. The match is on the numeric
    // account only: the login is display text, so an invite for the same login but another
    // account (made before a rename or recycle) is neither checked nor touched.
    if (live.length > 0) {
      await tx.orm
        .update(s.memberInvites)
        .set({ revokedAt: input.now })
        .where(
          scoped(
            scope,
            { orgId: s.memberInvites.orgId },
            inArray(
              s.memberInvites.id,
              live.map((e) => e.id),
            ),
          ),
        );
    }
    const id = ulid();
    await tx.orm.insert(s.memberInvites).values({
      id,
      orgId: scope.orgId,
      githubLogin: login,
      githubUserId: input.githubUserId,
      role: input.role,
      createdBy: input.createdBy,
      reason: input.reason ?? null,
      createdAt: input.now,
      expiresAt: input.expiresAt,
    });
    const [row] = await tx.orm
      .select()
      .from(s.memberInvites)
      .where(scoped(scope, { orgId: s.memberInvites.orgId }, eq(s.memberInvites.id, id)))
      .limit(1);
    return row!;
  });
}

export function listPendingInvites(db: Db, scope: Scope, now: number): Promise<MemberInvite[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.memberInvites)
      .where(
        scoped(
          scope,
          { orgId: s.memberInvites.orgId },
          isNull(s.memberInvites.usedAt),
          isNull(s.memberInvites.revokedAt),
          gt(s.memberInvites.expiresAt, now),
        ),
      ),
  );
}

// ---- sign-in ----

export type SignInResult =
  | {
      ok: true;
      userId: string;
      /** Orgs this sign-in joined, by consuming an invite. */
      joined: { orgId: string; slug: string; role: MemberRole; inviteId: string }[];
    }
  | { ok: false; reason: "no_access" };

/**
 * Completes a sign-in for a GitHub account the server has just verified. In one transaction:
 * links (or creates) the user for the numeric id, consumes the live invites for the login (each
 * atomically, so two tabs cannot both spend one), adds the memberships and opens the session.
 * A person with no membership and no live invite gets nothing written: there is no auto-join, and
 * no user row is made for a stranger, unless `allowNoMembership` says the instance lets this
 * login create an org for itself.
 */
export function completeSignIn(
  db: Db,
  input: {
    githubUserId: string;
    login: string;
    now: number;
    sessionHash: string;
    absoluteMs: number;
    /** Open a session for an account that holds no org and no invite (self-serve orgs). */
    allowNoMembership?: boolean;
  },
): Promise<SignInResult> {
  return db.transaction(async (tx) => {
    const [identity] = await tx.orm
      .select()
      .from(s.githubIdentities)
      .where(eq(s.githubIdentities.githubUserId, input.githubUserId))
      .limit(1);
    const invites = await tx.orm
      .select({ invite: s.memberInvites, slug: s.orgs.slug })
      .from(s.memberInvites)
      .innerJoin(s.orgs, eq(s.orgs.id, s.memberInvites.orgId))
      .where(
        and(
          eq(s.memberInvites.githubUserId, input.githubUserId),
          isNull(s.memberInvites.usedAt),
          isNull(s.memberInvites.revokedAt),
          gt(s.memberInvites.expiresAt, input.now),
        ),
      );
    const held = identity
      ? await tx.orm
          .select({ orgId: s.orgMembers.orgId })
          .from(s.orgMembers)
          .where(eq(s.orgMembers.userId, identity.userId))
      : [];
    if (held.length === 0 && invites.length === 0 && input.allowNoMembership !== true) {
      return { ok: false, reason: "no_access" };
    }

    let userId = identity?.userId;
    if (identity) {
      await tx.orm
        .update(s.githubIdentities)
        .set({ login: input.login, lastSignInAt: input.now })
        .where(eq(s.githubIdentities.githubUserId, input.githubUserId));
    } else {
      userId = ulid();
      await tx.orm.insert(s.users).values({ id: userId, email: null, displayName: input.login });
      await tx.orm.insert(s.githubIdentities).values({
        githubUserId: input.githubUserId,
        userId,
        login: input.login,
        createdAt: input.now,
        lastSignInAt: input.now,
      });
    }
    const uid = userId!;
    const joined: { orgId: string; slug: string; role: MemberRole; inviteId: string }[] = [];
    for (const { invite, slug } of invites) {
      const spent = await tx.orm
        .update(s.memberInvites)
        .set({ usedAt: input.now, usedByUserId: uid })
        .where(
          and(
            eq(s.memberInvites.id, invite.id),
            isNull(s.memberInvites.usedAt),
            isNull(s.memberInvites.revokedAt),
            gt(s.memberInvites.expiresAt, input.now),
          ),
        )
        .returning({ id: s.memberInvites.id });
      if (spent.length !== 1) continue;
      const [already] = await tx.orm
        .select({ role: s.orgMembers.role })
        .from(s.orgMembers)
        .where(and(eq(s.orgMembers.orgId, invite.orgId), eq(s.orgMembers.userId, uid)))
        .limit(1);
      // An existing member keeps the role they have: an invite never changes one.
      if (already) continue;
      await tx.orm
        .insert(s.orgMembers)
        .values({ orgId: invite.orgId, userId: uid, role: invite.role });
      joined.push({
        orgId: invite.orgId,
        slug,
        role: invite.role as MemberRole,
        inviteId: invite.id,
      });
      // The feed and the org's audit chain say who joined, in the same transaction as the grant.
      await appendEvent(
        tx,
        { orgId: invite.orgId },
        {
          type: "org.member_joined",
          payload: {
            user_id: uid,
            github_user_id: input.githubUserId,
            github_login: input.login,
            role: invite.role,
            invite_id: invite.id,
            invited_by: invite.createdBy,
          },
        },
      );
      await appendAudit(
        tx,
        { orgId: invite.orgId },
        {
          principalKind: "system",
          principalId: "github-sign-in",
          op: "member_joined",
          effect: "write",
          outcome: "ok",
          input: {
            user_id: uid,
            github_user_id: input.githubUserId,
            github_login: input.login,
            role: invite.role,
            invite_id: invite.id,
            invited_by: invite.createdBy,
          },
        },
      );
    }
    await tx.orm.insert(s.webSessions).values({
      id: input.sessionHash,
      userId: uid,
      createdAt: input.now,
      lastSeenAt: input.now,
      expiresAt: input.now + input.absoluteMs,
    });
    return { ok: true, userId: uid, joined };
  });
}

// ---- sessions ----

/** The live session for a cookie's hash: not revoked, inside its absolute life and its idle window. */
export function findLiveSession(
  db: Db,
  hash: string,
  now: number,
  idleMs: number,
): Promise<WebSession | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.webSessions)
      .where(
        and(
          eq(s.webSessions.id, hash),
          isNull(s.webSessions.revokedAt),
          gt(s.webSessions.expiresAt, now),
          gt(s.webSessions.lastSeenAt, now - idleMs),
        ),
      )
      .limit(1);
    return row;
  });
}

export function touchSession(db: Db, hash: string, now: number): Promise<void> {
  return db.run(async (h) => {
    await h.orm.update(s.webSessions).set({ lastSeenAt: now }).where(eq(s.webSessions.id, hash));
  });
}

export function revokeSession(db: Db, hash: string, now: number): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .update(s.webSessions)
      .set({ revokedAt: now })
      .where(and(eq(s.webSessions.id, hash), isNull(s.webSessions.revokedAt)));
  });
}

export function getUserDisplay(
  db: Db,
  userId: string,
): Promise<{ displayName: string } | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ displayName: s.users.displayName })
      .from(s.users)
      .where(eq(s.users.id, userId))
      .limit(1);
    return row;
  });
}
