// The database layer of the settings registry (#321). Rows are addressed by the kind of scope and
// its id (the org or project id, empty for the instance), so these functions take a target, not
// a tenant Scope: the ops that call them have already resolved and authorised the target.
import { and, eq } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import type { SettingScope } from "../schema";

export type SettingTarget = { kind: SettingScope; id: string };

export type StoredSetting = { value: unknown; updatedBy: string; updatedAt: number };

const where = (t: SettingTarget, key: string) =>
  and(eq(s.settings.scopeKind, t.kind), eq(s.settings.scopeId, t.id), eq(s.settings.key, key));

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
    const rows = await h.orm
      .select()
      .from(s.settings)
      .where(and(eq(s.settings.scopeKind, t.kind), eq(s.settings.scopeId, t.id)));
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
  return db.transaction(async (tx) => {
    await tx.orm.delete(s.settings).where(where(t, key));
    if (value === undefined) return;
    await tx.orm.insert(s.settings).values({
      scopeKind: t.kind,
      scopeId: t.id,
      key,
      value: JSON.stringify(value),
      updatedBy: by,
      updatedAt: now,
    });
  });
}
