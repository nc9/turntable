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

export type StoredSetting = { value: unknown; updatedBy: string; updatedAt: number };

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
      ? { value: parse(r.value), updatedBy: r.updatedBy, updatedAt: r.updatedAt }
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
        { value: parse(r.value), updatedBy: r.updatedBy, updatedAt: r.updatedAt },
      ]),
    );
  });
}

/** Stores a value (replacing any), or removes the stored one when `value` is undefined. */
export function putStoredSetting(
  db: Db,
  t: SettingTarget,
  key: string,
  value: unknown,
  by: string,
  now: number,
): Promise<void> {
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
    await tx.orm.delete(s.settings).where(where(t, key));
    if (value === undefined) return;
    await tx.orm.insert(s.settings).values({
      scopeKind: t.kind,
      scopeId: t.id,
      orgId: t.orgId,
      key,
      value: JSON.stringify(value),
      updatedBy: by,
      updatedAt: now,
    });
  });
}
