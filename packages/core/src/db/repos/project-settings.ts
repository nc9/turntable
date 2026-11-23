// Per-project sandbox settings (the instance operator's): the provider snapshot a project's
// sandboxes start from, and a cap on how many of its attempts run at once. Tenant tables: every
// read and write is scoped to the org and project.
import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { requireProject, type Scope } from "./scope";

export type ProjectSandboxSettings = {
  sandboxSnapshot: string | null;
  maxConcurrent: number | null;
};

/** A provider snapshot name: letters, digits, `.`, `_`, `-`; one to 128 characters; starts alphanumeric. */
export const SNAPSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function getProjectSandboxSettings(db: Db, scope: Scope): Promise<ProjectSandboxSettings> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    const [row] = await h.orm
      .select({ snap: s.projects.sandboxSnapshot, max: s.projects.maxConcurrent })
      .from(s.projects)
      .where(and(eq(s.projects.id, projectId), eq(s.projects.orgId, scope.orgId)))
      .limit(1);
    return { sandboxSnapshot: row?.snap ?? null, maxConcurrent: row?.max ?? null };
  });
}

/**
 * Sets the named settings (null clears one; undefined leaves it). Returns the settings after, or
 * undefined when the project is not in the org.
 */
export function setProjectSandboxSettings(
  db: Db,
  scope: Scope,
  patch: Partial<ProjectSandboxSettings>,
): Promise<ProjectSandboxSettings | undefined> {
  if (patch.sandboxSnapshot != null && !SNAPSHOT_NAME.test(patch.sandboxSnapshot))
    throw new Error("a snapshot name is letters, digits, . _ - (up to 128, starting alphanumeric)");
  if (
    patch.maxConcurrent != null &&
    (!Number.isSafeInteger(patch.maxConcurrent) || patch.maxConcurrent < 0)
  )
    throw new Error("maxConcurrent is a whole number, 0 or more");
  return db.transaction(async (tx) => {
    const { projectId } = requireProject(scope);
    const set: Partial<typeof s.projects.$inferInsert> = {};
    if (patch.sandboxSnapshot !== undefined) set.sandboxSnapshot = patch.sandboxSnapshot;
    if (patch.maxConcurrent !== undefined) set.maxConcurrent = patch.maxConcurrent;
    if (Object.keys(set).length > 0) {
      const rows = await tx.orm
        .update(s.projects)
        .set(set)
        .where(and(eq(s.projects.id, projectId), eq(s.projects.orgId, scope.orgId)))
        .returning({ id: s.projects.id });
      if (rows.length === 0) return undefined;
    }
    const [row] = await tx.orm
      .select({ snap: s.projects.sandboxSnapshot, max: s.projects.maxConcurrent })
      .from(s.projects)
      .where(and(eq(s.projects.id, projectId), eq(s.projects.orgId, scope.orgId)))
      .limit(1);
    return row ? { sandboxSnapshot: row.snap ?? null, maxConcurrent: row.max ?? null } : undefined;
  });
}

/**
 * Every project that has a cap, by project id. Instance-level (the claim loop asks before it has a
 * scope), like `orgsWithQuotas`.
 */
export async function projectsWithCaps(db: Db): Promise<Map<string, number>> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({ id: s.projects.id, max: s.projects.maxConcurrent })
      .from(s.projects)
      .where(isNotNull(s.projects.maxConcurrent));
    return new Map(rows.map((r) => [r.id, Number(r.max)]));
  });
}
