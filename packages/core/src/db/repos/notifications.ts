// Notifications (#611): the rows, a person's preferences, and the rule engine's cursor and reads.
// Part of the only code that names tenant tables. A notification belongs to one person AND one
// org: every read below joins the person's CURRENT memberships, so a removed member loses the
// rows at once, whatever was written while they belonged.
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import type { NotificationKind } from "../schema";
import { ulid } from "../ulid";
import type { EventRow } from "./events";

export type NotificationRow = typeof s.notifications.$inferSelect;
export type NotificationPref = typeof s.notificationPrefs.$inferSelect;

export const NOTIFICATION_ENGINE = "rules";

// ---- the engine's cursor and the feed it reads ----

export async function getNotificationCursor(db: Db): Promise<number | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.notificationCursors)
      .where(eq(s.notificationCursors.name, NOTIFICATION_ENGINE))
      .limit(1);
    return row?.lastEventId;
  });
}

export function setNotificationCursor(db: Db, lastEventId: number): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .insert(s.notificationCursors)
      .values({ name: NOTIFICATION_ENGINE, lastEventId })
      .onConflictDoUpdate({ target: s.notificationCursors.name, set: { lastEventId } });
  });
}

/** The newest event id (0 when none): where a fresh engine starts, so history is not replayed. */
export function newestEventId(db: Db): Promise<number> {
  return db.run(async (h) => {
    const [r] = await h.orm.select({ id: sql<number | null>`max(${s.events.id})` }).from(s.events);
    return Number(r?.id ?? 0);
  });
}

/** System work across orgs: events after the cursor, oldest first, none younger than `settleBefore`. */
export function listEventsAfter(
  db: Db,
  after: number,
  limit: number,
  settleBefore?: number,
): Promise<EventRow[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.events)
      .where(
        and(
          gt(s.events.id, after),
          settleBefore === undefined ? undefined : lt(s.events.createdAt, settleBefore),
        ),
      )
      .orderBy(asc(s.events.id))
      .limit(limit),
  );
}

// ---- who could be told ----

export type OrgPerson = { userId: string; role: string; login: string | null };

/** The people of one org, with the GitHub login they sign in as (null when they never have). */
export function listOrgPeople(db: Db, orgId: string): Promise<OrgPerson[]> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({
        userId: s.orgMembers.userId,
        role: s.orgMembers.role,
        login: s.githubIdentities.login,
      })
      .from(s.orgMembers)
      .leftJoin(s.githubIdentities, eq(s.githubIdentities.userId, s.orgMembers.userId))
      .where(eq(s.orgMembers.orgId, orgId));
    return rows;
  });
}

// ---- preferences ----

export function listNotificationPrefs(db: Db, userId: string): Promise<NotificationPref[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.notificationPrefs)
      .where(eq(s.notificationPrefs.userId, userId))
      .orderBy(
        asc(s.notificationPrefs.orgId),
        asc(s.notificationPrefs.projectId),
        asc(s.notificationPrefs.kind),
      ),
  );
}

/** Sets one preference (`orgId` and `projectId` empty for "all"). `enabled: null` removes it. */
export function putNotificationPref(
  db: Db,
  o: {
    userId: string;
    orgId: string;
    projectId: string;
    kind: NotificationKind;
    enabled: boolean | null;
    now: number;
  },
): Promise<void> {
  return db.run(async (h) => {
    const key = and(
      eq(s.notificationPrefs.userId, o.userId),
      eq(s.notificationPrefs.orgId, o.orgId),
      eq(s.notificationPrefs.projectId, o.projectId),
      eq(s.notificationPrefs.kind, o.kind),
    );
    if (o.enabled === null) {
      await h.orm.delete(s.notificationPrefs).where(key);
      return;
    }
    await h.orm
      .insert(s.notificationPrefs)
      .values({
        userId: o.userId,
        orgId: o.orgId,
        projectId: o.projectId,
        kind: o.kind,
        enabled: o.enabled,
        updatedAt: o.now,
      })
      .onConflictDoUpdate({
        target: [
          s.notificationPrefs.userId,
          s.notificationPrefs.orgId,
          s.notificationPrefs.projectId,
          s.notificationPrefs.kind,
        ],
        set: { enabled: o.enabled, updatedAt: o.now },
      });
  });
}

// ---- notifications ----

/**
 * Creates the notification, or (when `coalesce`) counts one more into the existing row with the
 * same dedupe key. Returns true when a new row was made. A coalesced row that was read becomes
 * unread again: something new happened.
 */
export function addNotification(
  db: Db,
  o: {
    userId: string;
    orgId: string;
    projectId: string | null;
    kind: NotificationKind;
    dedupeKey: string;
    runId: string | null;
    title: string;
    coalesce: boolean;
    now: number;
  },
): Promise<boolean> {
  return db.run(async (h) => {
    const [existing] = await h.orm
      .select({ id: s.notifications.id })
      .from(s.notifications)
      .where(
        and(
          eq(s.notifications.userId, o.userId),
          eq(s.notifications.kind, o.kind),
          eq(s.notifications.dedupeKey, o.dedupeKey),
        ),
      )
      .limit(1);
    if (existing) {
      if (o.coalesce) {
        await h.orm
          .update(s.notifications)
          .set({ count: sql`${s.notifications.count} + 1`, readAt: null })
          .where(eq(s.notifications.id, existing.id));
      }
      return false;
    }
    await h.orm.insert(s.notifications).values({
      id: ulid(),
      userId: o.userId,
      orgId: o.orgId,
      projectId: o.projectId,
      kind: o.kind,
      dedupeKey: o.dedupeKey,
      runId: o.runId,
      title: o.title,
      createdAt: o.now,
    });
    return true;
  });
}

export type NotificationView = NotificationRow & { orgSlug: string; projectSlug: string | null };

/**
 * A person's notifications, newest first, only for orgs they belong to NOW. `beforeId` is the
 * cursor (ids are ULIDs: time ordered).
 */
export function listNotifications(
  db: Db,
  o: {
    userId: string;
    kinds?: readonly NotificationKind[] | undefined;
    unreadOnly?: boolean | undefined;
    orgId?: string | undefined;
    beforeId?: string | undefined;
    limit: number;
  },
): Promise<NotificationView[]> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({
        n: s.notifications,
        orgSlug: s.orgs.slug,
        projectSlug: s.projects.slug,
      })
      .from(s.notifications)
      .innerJoin(
        s.orgMembers,
        and(
          eq(s.orgMembers.orgId, s.notifications.orgId),
          eq(s.orgMembers.userId, s.notifications.userId),
        ),
      )
      .innerJoin(s.orgs, eq(s.orgs.id, s.notifications.orgId))
      .leftJoin(
        s.projects,
        and(
          eq(s.projects.id, s.notifications.projectId),
          eq(s.projects.orgId, s.notifications.orgId),
        ),
      )
      .where(
        and(
          eq(s.notifications.userId, o.userId),
          o.kinds && o.kinds.length > 0 ? inArray(s.notifications.kind, [...o.kinds]) : undefined,
          o.unreadOnly ? isNull(s.notifications.readAt) : undefined,
          o.orgId === undefined ? undefined : eq(s.notifications.orgId, o.orgId),
          o.beforeId === undefined ? undefined : lt(s.notifications.id, o.beforeId),
        ),
      )
      .orderBy(desc(s.notifications.id))
      .limit(o.limit);
    return rows.map((r) => ({ ...r.n, orgSlug: r.orgSlug, projectSlug: r.projectSlug }));
  });
}

/** Unread count, over the same membership join as the list. */
export function countUnreadNotifications(db: Db, userId: string): Promise<number> {
  return db.run(async (h) => {
    const [r] = await h.orm
      .select({ n: sql<number>`count(*)` })
      .from(s.notifications)
      .innerJoin(
        s.orgMembers,
        and(
          eq(s.orgMembers.orgId, s.notifications.orgId),
          eq(s.orgMembers.userId, s.notifications.userId),
        ),
      )
      .where(and(eq(s.notifications.userId, userId), isNull(s.notifications.readAt)));
    return Number(r?.n ?? 0);
  });
}

/**
 * Marks read: the named ids, or every unread one when `ids` is undefined. Only the caller's own
 * rows, in orgs they still belong to. Returns how many changed.
 */
export function ackNotifications(
  db: Db,
  o: { userId: string; ids?: readonly string[] | undefined; now: number },
): Promise<number> {
  return db.run(async (h) => {
    const mine = h.orm
      .select({ id: s.notifications.id })
      .from(s.notifications)
      .innerJoin(
        s.orgMembers,
        and(
          eq(s.orgMembers.orgId, s.notifications.orgId),
          eq(s.orgMembers.userId, s.notifications.userId),
        ),
      )
      .where(
        and(
          eq(s.notifications.userId, o.userId),
          isNull(s.notifications.readAt),
          o.ids ? inArray(s.notifications.id, [...o.ids]) : undefined,
        ),
      );
    const rows = await h.orm
      .update(s.notifications)
      .set({ readAt: o.now })
      .where(and(eq(s.notifications.userId, o.userId), inArray(s.notifications.id, mine)))
      .returning({ id: s.notifications.id });
    return rows.length;
  });
}

/** The infra kind recorded on an attempt (for `checkout_auth_failed`). */
export function getAttemptInfraKind(
  db: Db,
  orgId: string,
  attemptId: string,
): Promise<string | null> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ k: s.jobAttempts.infraKind })
      .from(s.jobAttempts)
      .where(and(eq(s.jobAttempts.orgId, orgId), eq(s.jobAttempts.id, attemptId)))
      .limit(1);
    return row?.k ?? null;
  });
}
