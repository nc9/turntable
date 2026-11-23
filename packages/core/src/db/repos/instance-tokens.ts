// Instance-administrator tokens. Not tenant data: there is no org here, so these functions take no
// scope. They are reached only from the host CLI and from authentication.
import { desc, eq } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { ulid } from "../ulid";

export type InstanceToken = typeof s.instanceTokens.$inferSelect;

export function insertInstanceToken(
  db: Db,
  input: { name: string; tokenHash: string; createdBy: string; expiresAt: number },
): Promise<InstanceToken> {
  return db.run(async (h) => {
    const id = ulid();
    await h.orm.insert(s.instanceTokens).values({ id, ...input });
    const [row] = await h.orm
      .select()
      .from(s.instanceTokens)
      .where(eq(s.instanceTokens.id, id))
      .limit(1);
    return row!;
  });
}

export function findInstanceTokenByHash(
  db: Db,
  tokenHash: string,
): Promise<InstanceToken | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.instanceTokens)
      .where(eq(s.instanceTokens.tokenHash, tokenHash))
      .limit(1);
    return row;
  });
}

export function getInstanceToken(db: Db, id: string): Promise<InstanceToken | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.instanceTokens)
      .where(eq(s.instanceTokens.id, id))
      .limit(1);
    return row;
  });
}

export function touchInstanceToken(db: Db, id: string, now: number): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .update(s.instanceTokens)
      .set({ lastUsedAt: now })
      .where(eq(s.instanceTokens.id, id));
  });
}

export function listInstanceTokens(db: Db): Promise<InstanceToken[]> {
  return db.run((h) => h.orm.select().from(s.instanceTokens).orderBy(desc(s.instanceTokens.id)));
}

export function revokeInstanceToken(db: Db, id: string, now: number): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.instanceTokens)
      .set({ revokedAt: now })
      .where(eq(s.instanceTokens.id, id))
      .returning({ id: s.instanceTokens.id });
    return rows.length > 0;
  });
}

/** Every org of the instance, oldest first, for the instance administrator. */
export function listAllOrgs(db: Db): Promise<{ id: string; slug: string; name: string }[]> {
  return db.run((h) =>
    h.orm
      .select({ id: s.orgs.id, slug: s.orgs.slug, name: s.orgs.name })
      .from(s.orgs)
      .orderBy(s.orgs.id),
  );
}
