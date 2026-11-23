// Per-project sandbox settings (the instance operator's): the provider snapshot a project's
// sandboxes start from, and a cap on how many of its attempts run at once. Tenant tables: every
// read and write is scoped to the org and project.
import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { UNTRUSTED_RUN_APPROVALS, type UntrustedRunApproval } from "../schema";
import { getStoredSetting, putStoredSetting } from "./settings";
import { requireProject, type Scope } from "./scope";

export type ProjectSandboxSettings = {
  sandboxSnapshot: string | null;
  maxConcurrent: number | null;
  /** Who may release a run held for an untrusted author. Never null: the default is `no_agents`. */
  untrustedRunApproval: UntrustedRunApproval;
};

/**
 * `untrusted_run_approval` lives in the settings table (#321), the registry's database layer; the
 * `projects` column it came from is no longer read or written. A stored value is a policy;
 * anything unknown reads as the strictest, `human` (fail closed). This is the stored layer only:
 * `approve_run` and the ops read the effective value through the resolver, which adds the
 * environment and `turntable.toml`.
 */
const APPROVAL_KEY = "untrusted_run_approval";

async function storedApproval(db: Db, scope: Scope): Promise<UntrustedRunApproval> {
  const { projectId } = requireProject(scope);
  const stored = await getStoredSetting(
    db,
    { kind: "project", id: projectId, orgId: scope.orgId },
    APPROVAL_KEY,
  );
  if (stored === undefined) return "no_agents";
  return (UNTRUSTED_RUN_APPROVALS as readonly string[]).includes(stored.value as string)
    ? (stored.value as UntrustedRunApproval)
    : "human";
}

const COLS = {
  snap: s.projects.sandboxSnapshot,
  max: s.projects.maxConcurrent,
};
const settingsOf = (
  row: { snap: string | null; max: number | null },
  approval: UntrustedRunApproval,
) => ({
  sandboxSnapshot: row.snap ?? null,
  maxConcurrent: row.max ?? null,
  untrustedRunApproval: approval,
});

/** A provider snapshot name: letters, digits, `.`, `_`, `-`; one to 128 characters; starts alphanumeric. */
export const SNAPSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function getProjectSandboxSettings(db: Db, scope: Scope): Promise<ProjectSandboxSettings> {
  return db.run(async (h) => {
    const { projectId } = requireProject(scope);
    const [row] = await h.orm
      .select(COLS)
      .from(s.projects)
      .where(and(eq(s.projects.id, projectId), eq(s.projects.orgId, scope.orgId)))
      .limit(1);
    // A project that is not found reads as the default; the callers resolved it already.
    return row
      ? settingsOf(row, await storedApproval(db, scope))
      : settingsOf({ snap: null, max: null }, "no_agents");
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
  /** Who and when, for the settings row the approval policy is stored in. */
  by: { id: string; now: number } = { id: "local", now: Date.now() },
): Promise<ProjectSandboxSettings | undefined> {
  if (patch.sandboxSnapshot != null && !SNAPSHOT_NAME.test(patch.sandboxSnapshot))
    throw new Error("a snapshot name is letters, digits, . _ - (up to 128, starting alphanumeric)");
  if (
    patch.maxConcurrent != null &&
    (!Number.isSafeInteger(patch.maxConcurrent) || patch.maxConcurrent < 0)
  )
    throw new Error("maxConcurrent is a whole number, 0 or more");
  if (
    patch.untrustedRunApproval !== undefined &&
    !(UNTRUSTED_RUN_APPROVALS as readonly string[]).includes(patch.untrustedRunApproval)
  )
    throw new Error(`untrustedRunApproval is one of: ${UNTRUSTED_RUN_APPROVALS.join(", ")}`);
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
    } else if (patch.untrustedRunApproval !== undefined) {
      const [p] = await tx.orm
        .select({ id: s.projects.id })
        .from(s.projects)
        .where(and(eq(s.projects.id, projectId), eq(s.projects.orgId, scope.orgId)))
        .limit(1);
      if (!p) return undefined;
    }
    if (patch.untrustedRunApproval !== undefined) {
      await putStoredSetting(
        tx,
        { kind: "project", id: projectId, orgId: scope.orgId },
        APPROVAL_KEY,
        patch.untrustedRunApproval,
        by.id,
        by.now,
      );
    }
    const [row] = await tx.orm
      .select(COLS)
      .from(s.projects)
      .where(and(eq(s.projects.id, projectId), eq(s.projects.orgId, scope.orgId)))
      .limit(1);
    return row ? settingsOf(row, await storedApproval(tx, scope)) : undefined;
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

/** The scheduling class setting's key and the one non-default value. Mirrors `settings/definitions.ts`. */
const SCHEDULING_CLASS_KEY = "scheduling_class";

/**
 * Projects whose stored `scheduling_class` is `yield`, by id. Anything else (no row, `normal`, an
 * unknown value) is `normal`: an unreadable value never demotes a project.
 */
export async function yieldProjects(db: Db): Promise<Set<string>> {
  const rows = await db.run((h) =>
    h.orm
      .select({ id: s.settings.scopeId, value: s.settings.value })
      .from(s.settings)
      .where(and(eq(s.settings.scopeKind, "project"), eq(s.settings.key, SCHEDULING_CLASS_KEY))),
  );
  return new Set(rows.filter((r) => r.value === JSON.stringify("yield")).map((r) => r.id));
}
