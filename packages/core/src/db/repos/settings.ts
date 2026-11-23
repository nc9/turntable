// The database layer of the settings registry (#321). Rows are addressed by the kind of scope and
// its id (the org or project id, empty for the instance) and carry the owning org, which every
// org and project query filters on. The ops that call these have already resolved the target from
// the caller's own org.
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import type { SettingScope } from "../schema";

/** `orgId` is null for instance scope and the owning org otherwise. */
export type SettingTarget = { kind: SettingScope; id: string; orgId: string | null };

export type StoredSetting = {
  value: unknown;
  /** The stored JSON text, the token a compare-and-set write compares against. */
  raw: string;
  updatedBy: string;
  updatedAt: number;
};

const inTarget = (t: SettingTarget) =>
  and(
    eq(s.settings.scopeKind, t.kind),
    eq(s.settings.scopeId, t.id),
    t.orgId === null ? isNull(s.settings.orgId) : eq(s.settings.orgId, t.orgId),
  );

const where = (t: SettingTarget, key: string) => and(inTarget(t), eq(s.settings.key, key));

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The stored value of one setting, or undefined when none is set. */
export function getStoredSetting(
  db: Db,
  t: SettingTarget,
  key: string,
): Promise<StoredSetting | undefined> {
  return db.run(async (h) => {
    const [r] = await h.orm.select().from(s.settings).where(where(t, key)).limit(1);
    return r
      ? { value: parse(r.value), raw: r.value, updatedBy: r.updatedBy, updatedAt: r.updatedAt }
      : undefined;
  });
}

/** Every stored setting of one target, by key. */
export function listStoredSettings(db: Db, t: SettingTarget): Promise<Map<string, StoredSetting>> {
  return db.run(async (h) => {
    const rows = await h.orm.select().from(s.settings).where(inTarget(t));
    return new Map(
      rows.map((r) => [
        r.key,
        { value: parse(r.value), raw: r.value, updatedBy: r.updatedBy, updatedAt: r.updatedAt },
      ]),
    );
  });
}

/**
 * Stores a value (replacing any), or removes the stored one when `value` is undefined. With
 * `expect` it is a compare-and-set: it writes only if the stored text is still `expect.raw` (or
 * there is still no row, for an undefined `raw`) and returns false, writing nothing, when another
 * writer got there first. Without it the write is unconditional and always returns true.
 */
export function putStoredSetting(
  db: Db,
  t: SettingTarget,
  key: string,
  value: unknown,
  by: string,
  now: number,
  expect?: { raw: string | undefined },
): Promise<boolean> {
  // The shape the CHECK enforces, and the one it cannot: a project's row belongs to its org.
  if (t.kind === "instance" ? t.orgId !== null : t.orgId === null) {
    throw new Error(
      `setting ${key}: a ${t.kind} setting ${t.kind === "instance" ? "has no" : "needs an"} org`,
    );
  }
  if (t.kind === "org" && t.id !== t.orgId)
    throw new Error(`setting ${key}: org scope id is not the org`);
  return db.transaction(async (tx) => {
    if (t.kind === "project" && value !== undefined) {
      const [p] = await tx.orm
        .select({ id: s.projects.id })
        .from(s.projects)
        .where(and(eq(s.projects.id, t.id), eq(s.projects.orgId, t.orgId!)))
        .limit(1);
      if (!p) throw new Error(`setting ${key}: project ${t.id} is not in org ${t.orgId}`);
    }
    const row = {
      scopeKind: t.kind,
      scopeId: t.id,
      orgId: t.orgId,
      key,
      value: value === undefined ? "" : JSON.stringify(value),
      updatedBy: by,
      updatedAt: now,
    };
    if (!expect) {
      await tx.orm.delete(s.settings).where(where(t, key));
      if (value !== undefined) await tx.orm.insert(s.settings).values(row);
      return true;
    }
    // Each branch is one conditional statement, so it holds on both dialects without relying on
    // the isolation level: the row is matched on the text that was read, or not touched.
    const same = and(where(t, key), eq(s.settings.value, expect.raw ?? ""));
    if (expect.raw === undefined) {
      if (value === undefined) {
        const [r] = await tx.orm
          .select({ k: s.settings.key })
          .from(s.settings)
          .where(where(t, key))
          .limit(1);
        return r === undefined;
      }
      const ins = await tx.orm
        .insert(s.settings)
        .values(row)
        .onConflictDoNothing()
        .returning({ k: s.settings.key });
      return ins.length > 0;
    }
    const hit =
      value === undefined
        ? await tx.orm.delete(s.settings).where(same).returning({ k: s.settings.key })
        : await tx.orm
            .update(s.settings)
            .set({ value: row.value, updatedBy: by, updatedAt: now })
            .where(same)
            .returning({ k: s.settings.key });
    return hit.length > 0;
  });
}
