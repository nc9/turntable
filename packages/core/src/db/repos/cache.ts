// The control-plane cache index (#38). Part of the only code allowed to name tenant tables. Every
// function is bound to a namespace (org, project, class, ref scope); none takes a client-supplied
// one. Eviction is by class: it never removes an entry of another class.
import { and, asc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";

export type CacheNamespace = {
  orgId: string;
  projectId: string;
  klass: string;
  refScope: string;
};

export type CacheEntry = typeof s.cacheEntries.$inferSelect;

const inNs = (ns: CacheNamespace) =>
  and(
    eq(s.cacheEntries.orgId, ns.orgId),
    eq(s.cacheEntries.projectId, ns.projectId),
    eq(s.cacheEntries.klass, ns.klass),
    eq(s.cacheEntries.refScope, ns.refScope),
  );

/** An upload that was never committed is dropped after this long. */
export const PENDING_TTL_MS = 10 * 60_000;

export type Reserved = { id: number } | { conflict: true } | { pendingFull: true };

/** Reserves an entry in the namespace. A live entry (or a fresh pending one) of the same key and version is a conflict. */
export function reserveCacheEntry(
  db: Db,
  ns: CacheNamespace,
  o: {
    key: string;
    version: string;
    size: number;
    now: number;
    /** Most uncommitted bytes and entries one project may hold in one class, across all jobs. */
    maxPendingBytes?: number;
    maxPendingCount?: number;
  },
): Promise<Reserved> {
  return db.transaction(async (tx) => {
    const same = await tx.run(async (h) =>
      h.orm
        .select()
        .from(s.cacheEntries)
        .where(and(inNs(ns), eq(s.cacheEntries.key, o.key), eq(s.cacheEntries.version, o.version))),
    );
    for (const e of same) {
      if (e.complete === 1 || o.now - e.createdAt < PENDING_TTL_MS)
        return { conflict: true as const };
    }
    // A cap on what is reserved but not committed, per class and project, whoever reserved it.
    // Reservations past the upload window do not count: they are reclaimed.
    if (o.maxPendingBytes !== undefined || o.maxPendingCount !== undefined) {
      const [p] = await tx.run((h) =>
        h.orm
          .select({
            n: sql<number>`count(*)`,
            bytes: sql<number>`coalesce(sum(${s.cacheEntries.size}), 0)`,
          })
          .from(s.cacheEntries)
          .where(
            and(
              eq(s.cacheEntries.orgId, ns.orgId),
              eq(s.cacheEntries.projectId, ns.projectId),
              eq(s.cacheEntries.klass, ns.klass),
              eq(s.cacheEntries.complete, 0),
              gte(s.cacheEntries.createdAt, o.now - PENDING_TTL_MS),
            ),
          ),
      );
      if (
        Number(p?.n ?? 0) >= (o.maxPendingCount ?? Infinity) ||
        Number(p?.bytes ?? 0) + o.size > (o.maxPendingBytes ?? Infinity)
      )
        return { pendingFull: true as const };
    }
    // Stale pending rows of the same key are replaced.
    const stale = same.filter((e) => e.complete === 0).map((e) => e.id);
    return tx.run(async (h) => {
      if (stale.length > 0)
        await h.orm.delete(s.cacheEntries).where(inArray(s.cacheEntries.id, stale));
      const [row] = await h.orm
        .insert(s.cacheEntries)
        .values({
          orgId: ns.orgId,
          projectId: ns.projectId,
          klass: ns.klass,
          refScope: ns.refScope,
          key: o.key,
          version: o.version,
          size: o.size,
          complete: 0,
          createdAt: o.now,
          usedAt: o.now,
        })
        .returning({ id: s.cacheEntries.id });
      return { id: row!.id };
    });
  });
}

/** The entry, only if it lives in exactly this namespace. */
export function getCacheEntryIn(
  db: Db,
  ns: CacheNamespace,
  id: number,
): Promise<CacheEntry | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.cacheEntries)
      .where(and(inNs(ns), eq(s.cacheEntries.id, id)))
      .limit(1);
    return row;
  });
}

export function completeCacheEntry(
  db: Db,
  ns: CacheNamespace,
  id: number,
  size: number,
  now: number,
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.cacheEntries)
      .set({ complete: 1, size, usedAt: now })
      .where(and(inNs(ns), eq(s.cacheEntries.id, id), eq(s.cacheEntries.complete, 0)))
      .returning({ id: s.cacheEntries.id });
    return rows.length > 0;
  });
}

export function deleteCacheEntry(db: Db, ns: CacheNamespace, id: number): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .delete(s.cacheEntries)
      .where(and(inNs(ns), eq(s.cacheEntries.id, id)))
      .returning({ id: s.cacheEntries.id });
    return rows.length > 0;
  });
}

export function touchCacheEntry(
  db: Db,
  ns: CacheNamespace,
  id: number,
  now: number,
): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .update(s.cacheEntries)
      .set({ usedAt: now })
      .where(and(inNs(ns), eq(s.cacheEntries.id, id)));
  });
}

/**
 * Looks for a complete entry in this namespace: for each key in order, an exact match first, then
 * the newest entry whose key starts with it (the actions/cache restore-keys rule).
 */
export function findCacheEntry(
  db: Db,
  ns: CacheNamespace,
  keys: readonly string[],
  version: string,
): Promise<CacheEntry | undefined> {
  return db.run(async (h) => {
    for (const key of keys) {
      const rows = await h.orm
        .select()
        .from(s.cacheEntries)
        .where(
          and(
            inNs(ns),
            eq(s.cacheEntries.version, version),
            eq(s.cacheEntries.complete, 1),
            // Exact first, then prefix: the prefix scan also matches the exact key, so order it.
            sql`(${s.cacheEntries.key} = ${key} or substr(${s.cacheEntries.key}, 1, ${key.length}) = ${key})`,
          ),
        );
      const exact = rows.find((r) => r.key === key);
      if (exact) return exact;
      const best = rows.toSorted((a, b) => b.createdAt - a.createdAt)[0];
      if (best) return best;
    }
    return undefined;
  });
}

/** Bytes used by one class in an org. */
export function cacheClassUsage(db: Db, orgId: string, klass: string): Promise<number> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ n: sql<number>`coalesce(sum(${s.cacheEntries.size}), 0)` })
      .from(s.cacheEntries)
      .where(and(eq(s.cacheEntries.orgId, orgId), eq(s.cacheEntries.klass, klass)));
    return Number(row?.n ?? 0);
  });
}

/**
 * Removes the least recently used entries of ONE class until `needed` bytes fit under `limit`.
 * It filters on the class and never reaches another one. Entries of `keep` are not touched.
 * Returns the ids removed (their blobs go too) and whether it now fits.
 */
export function evictCacheClass(
  db: Db,
  o: {
    orgId: string;
    klass: string;
    limit: number;
    needed: number;
    keep?: number;
    /** Pending reservations created before this are abandoned and may be evicted. */
    staleBefore?: number;
  },
): Promise<{ removed: number[]; fits: boolean }> {
  return db.transaction(async (tx) => {
    let used = await cacheClassUsage(tx, o.orgId, o.klass);
    const removed: number[] = [];
    if (used + o.needed <= o.limit) return { removed, fits: true };
    const rows = await tx.run((h) =>
      h.orm
        .select()
        .from(s.cacheEntries)
        .where(
          and(
            eq(s.cacheEntries.orgId, o.orgId),
            eq(s.cacheEntries.klass, o.klass),
            // A live pending reservation is charged but never evicted: that would break an
            // upload. One past the upload window is abandoned and goes first.
            o.staleBefore === undefined
              ? eq(s.cacheEntries.complete, 1)
              : or(eq(s.cacheEntries.complete, 1), lt(s.cacheEntries.createdAt, o.staleBefore)),
          ),
        )
        .orderBy(asc(s.cacheEntries.usedAt), asc(s.cacheEntries.id)),
    );
    // If evicting everything evictable still would not fit, evict nothing: a request that can
    // never fit must not empty the class on its way to being refused.
    const evictable = rows.filter((e) => e.id !== o.keep).reduce((n, e) => n + e.size, 0);
    if (used - evictable + o.needed > o.limit) return { removed, fits: false };
    for (const e of rows) {
      if (used + o.needed <= o.limit) break;
      if (e.id === o.keep) continue;
      await tx.run(async (h) => {
        await h.orm.delete(s.cacheEntries).where(eq(s.cacheEntries.id, e.id));
      });
      used -= e.size;
      removed.push(e.id);
    }
    return { removed, fits: used + o.needed <= o.limit };
  });
}

/** Drops pending uploads that never committed. Returns their ids. */
export function expirePendingCache(db: Db, now: number): Promise<number[]> {
  return db.run(async (h) => {
    const rows = await h.orm
      .delete(s.cacheEntries)
      .where(
        and(eq(s.cacheEntries.complete, 0), lt(s.cacheEntries.createdAt, now - PENDING_TTL_MS)),
      )
      .returning({ id: s.cacheEntries.id });
    return rows.map((r) => r.id);
  });
}

export function setProjectCacheReleaseRestore(
  db: Db,
  scope: { orgId: string; projectId: string },
  on: boolean,
): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .update(s.projects)
      .set({ cacheReleaseRestore: on ? 1 : 0 })
      .where(and(eq(s.projects.orgId, scope.orgId), eq(s.projects.id, scope.projectId)));
  });
}

export function getProjectCacheReleaseRestore(
  db: Db,
  scope: { orgId: string; projectId: string },
): Promise<boolean> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ on: s.projects.cacheReleaseRestore })
      .from(s.projects)
      .where(and(eq(s.projects.orgId, scope.orgId), eq(s.projects.id, scope.projectId)))
      .limit(1);
    return row?.on === 1;
  });
}

/** Which of these ids still have a row, complete or pending. */
export function existingCacheIds(db: Db, ids: readonly number[]): Promise<Set<number>> {
  return db.run(async (h) => {
    const out = new Set<number>();
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await h.orm
        .select({ id: s.cacheEntries.id })
        .from(s.cacheEntries)
        .where(inArray(s.cacheEntries.id, ids.slice(i, i + 500)));
      for (const r of rows) out.add(r.id);
    }
    return out;
  });
}
