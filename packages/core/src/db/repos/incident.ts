// Incident response: the freeze flags, rotation flags and the per-use audit query. Part of the
// only code allowed to name tenant tables.
import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { ulid } from "../ulid";
import { scoped, type Scope } from "./scope";

export type FreezeLevel = "org" | "project";
export type FreezeState = {
  frozen: boolean;
  /** Which flag holds the scope frozen: the org's wins when both are set. */
  level: FreezeLevel | null;
  reason: string | null;
  frozenAt: number | null;
  frozenBy: string | null;
};

const NOT_FROZEN: FreezeState = {
  frozen: false,
  level: null,
  reason: null,
  frozenAt: null,
  frozenBy: null,
};

/**
 * SQL for the claim path: true when neither the run's org nor its project is frozen. Both are
 * checked at claim time, in the claim's transaction, so a freeze takes effect on the next claim.
 */
export function notFrozen(runOrgId: typeof s.runs.orgId, runProjectId: typeof s.runs.projectId) {
  return sql`(not exists (select 1 from ${s.orgs} where ${s.orgs.id} = ${runOrgId} and ${s.orgs.frozenAt} is not null)
    and not exists (select 1 from ${s.projects} where ${s.projects.id} = ${runProjectId} and ${s.projects.frozenAt} is not null))`;
}

/** The freeze that applies to a scope: its org's, else its project's. */
export function getFreeze(db: Db, scope: Scope): Promise<FreezeState> {
  return db.run(async (h) => {
    const [org] = await h.orm.select().from(s.orgs).where(eq(s.orgs.id, scope.orgId)).limit(1);
    if (org?.frozenAt != null) {
      return {
        frozen: true,
        level: "org" as const,
        reason: org.frozenReason,
        frozenAt: org.frozenAt,
        frozenBy: org.frozenBy,
      };
    }
    if (scope.projectId !== undefined) {
      const [p] = await h.orm
        .select()
        .from(s.projects)
        .where(and(eq(s.projects.id, scope.projectId), eq(s.projects.orgId, scope.orgId)))
        .limit(1);
      if (p?.frozenAt != null) {
        return {
          frozen: true,
          level: "project" as const,
          reason: p.frozenReason,
          frozenAt: p.frozenAt,
          frozenBy: p.frozenBy,
        };
      }
    }
    return NOT_FROZEN;
  });
}

/** Sets the freeze flag on the scope's own level (project when scoped to one, else org). */
export function setFreeze(
  db: Db,
  scope: Scope,
  o: { reason: string; by: string; now: number },
): Promise<{ level: FreezeLevel; alreadyFrozen: boolean; frozenAt: number }> {
  return db.run(async (h) => {
    if (scope.projectId !== undefined) {
      const where = and(eq(s.projects.id, scope.projectId), eq(s.projects.orgId, scope.orgId));
      const [p] = await h.orm.select().from(s.projects).where(where).limit(1);
      if (p?.frozenAt != null)
        return { level: "project" as const, alreadyFrozen: true, frozenAt: p.frozenAt };
      await h.orm
        .update(s.projects)
        .set({ frozenAt: o.now, frozenReason: o.reason, frozenBy: o.by })
        .where(where);
      return { level: "project" as const, alreadyFrozen: false, frozenAt: o.now };
    }
    const where = eq(s.orgs.id, scope.orgId);
    const [org] = await h.orm.select().from(s.orgs).where(where).limit(1);
    if (org?.frozenAt != null)
      return { level: "org" as const, alreadyFrozen: true, frozenAt: org.frozenAt };
    await h.orm
      .update(s.orgs)
      .set({ frozenAt: o.now, frozenReason: o.reason, frozenBy: o.by })
      .where(where);
    return { level: "org" as const, alreadyFrozen: false, frozenAt: o.now };
  });
}

/** Clears the scope's own flag only. Rotation flags stay. */
export function clearFreeze(
  db: Db,
  scope: Scope,
): Promise<{ level: FreezeLevel; wasFrozen: boolean; stillFrozenBy: FreezeLevel | null }> {
  return db.run(async (h) => {
    const [org] = await h.orm.select().from(s.orgs).where(eq(s.orgs.id, scope.orgId)).limit(1);
    const orgFrozen = org?.frozenAt != null;
    if (scope.projectId !== undefined) {
      const where = and(eq(s.projects.id, scope.projectId), eq(s.projects.orgId, scope.orgId));
      const [p] = await h.orm.select().from(s.projects).where(where).limit(1);
      const was = p?.frozenAt != null;
      if (was)
        await h.orm
          .update(s.projects)
          .set({ frozenAt: null, frozenReason: null, frozenBy: null })
          .where(where);
      return {
        level: "project" as const,
        wasFrozen: was,
        stillFrozenBy: orgFrozen ? ("org" as const) : null,
      };
    }
    if (orgFrozen)
      await h.orm
        .update(s.orgs)
        .set({ frozenAt: null, frozenReason: null, frozenBy: null })
        .where(eq(s.orgs.id, scope.orgId));
    return { level: "org" as const, wasFrozen: orgFrozen, stillFrozenBy: null };
  });
}

/** Runs in scope with at least one running job: what a freeze kills. */
export function runsWithRunningJobs(db: Db, scope: Scope): Promise<string[]> {
  return db.run(async (h) => {
    const rows = await h.orm
      .selectDistinct({ runId: s.jobs.runId })
      .from(s.jobs)
      .where(
        scoped(
          scope,
          { orgId: s.jobs.orgId, projectId: s.jobs.projectId },
          eq(s.jobs.state, "running"),
        ),
      );
    return rows.map((r) => r.runId);
  });
}

const FLAG_COLS = {
  orgId: s.incidentRotationFlags.orgId,
  projectId: s.incidentRotationFlags.projectId,
};

/** Opens a rotation flag for each name that has no open one. Returns how many were new. */
export function flagForRotation(
  db: Db,
  scope: Scope,
  names: readonly string[],
  o: { reason: string; by: string; now: number },
): Promise<number> {
  return db.run(async (h) => {
    const open = new Set(
      (
        await h.orm
          .select({ name: s.incidentRotationFlags.name })
          .from(s.incidentRotationFlags)
          .where(
            and(
              eq(s.incidentRotationFlags.orgId, scope.orgId),
              isNull(s.incidentRotationFlags.clearedAt),
            ),
          )
      ).map((r) => r.name),
    );
    let added = 0;
    for (const name of new Set(names)) {
      if (open.has(name)) continue;
      await h.orm.insert(s.incidentRotationFlags).values({
        id: ulid(),
        orgId: scope.orgId,
        projectId: scope.projectId ?? null,
        name,
        reason: o.reason,
        flaggedBy: o.by,
        flaggedAt: o.now,
      });
      added++;
    }
    return added;
  });
}

export type RotationFlag = {
  name: string;
  reason: string;
  flaggedBy: string;
  flaggedAt: number;
  projectId: string | null;
};

export function listOpenRotationFlags(db: Db, scope: Scope): Promise<RotationFlag[]> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select()
      .from(s.incidentRotationFlags)
      .where(scoped(scope, FLAG_COLS, isNull(s.incidentRotationFlags.clearedAt)))
      .orderBy(asc(s.incidentRotationFlags.name));
    return rows.map((r) => ({
      name: r.name,
      reason: r.reason,
      flaggedBy: r.flaggedBy,
      flaggedAt: r.flaggedAt,
      projectId: r.projectId,
    }));
  });
}

/** Called when a secret is rotated: closes its open flag. Returns whether one was open. */
export function clearRotationFlag(
  db: Db,
  scope: Scope,
  name: string,
  now: number,
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.incidentRotationFlags)
      .set({ clearedAt: now })
      .where(
        and(
          eq(s.incidentRotationFlags.orgId, scope.orgId),
          eq(s.incidentRotationFlags.name, name),
          isNull(s.incidentRotationFlags.clearedAt),
        ),
      )
      .returning({ id: s.incidentRotationFlags.id });
    return rows.length > 0;
  });
}

/**
 * Closes the open rotation flag of a vault secret name once every vault secret of that name in
 * the org has a version newer than the flag. A name can be several secrets (org, project,
 * environment, ref scopes) and a freeze flags the name, so rotating one scope must not clear
 * the flag while another scope still holds the old value. Returns whether a flag was closed.
 */
export function clearRotationFlagIfRotated(
  db: Db,
  scope: Scope,
  name: string,
  now: number,
): Promise<boolean> {
  return db.run(async (h) => {
    const [flag] = await h.orm
      .select()
      .from(s.incidentRotationFlags)
      .where(
        and(
          eq(s.incidentRotationFlags.orgId, scope.orgId),
          eq(s.incidentRotationFlags.name, name),
          isNull(s.incidentRotationFlags.clearedAt),
        ),
      )
      .limit(1);
    if (!flag) return false;
    const rows = await h.orm
      .select({ updatedAt: s.vaultSecrets.updatedAt })
      .from(s.vaultSecrets)
      .where(and(eq(s.vaultSecrets.orgId, scope.orgId), eq(s.vaultSecrets.name, name)));
    if (rows.some((r) => r.updatedAt <= flag.flaggedAt)) return false;
    await h.orm
      .update(s.incidentRotationFlags)
      .set({ clearedAt: now })
      .where(eq(s.incidentRotationFlags.id, flag.id));
    return true;
  });
}

export type SecretUseRow = { id: string; createdAt: number; input: string };

/**
 * Audit rows of successful secret uses in a time range, oldest first. The caller filters by name
 * (the vault writes the name inside `input`), so the scan is bounded by `limit`.
 */
export function listSecretUseAudit(
  db: Db,
  scope: Scope,
  o: { since: number; until: number; limit: number },
): Promise<SecretUseRow[]> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({ id: s.auditLog.id, createdAt: s.auditLog.createdAt, input: s.auditLog.input })
      .from(s.auditLog)
      .where(
        scoped(
          scope,
          { orgId: s.auditLog.orgId, projectId: s.auditLog.projectId },
          eq(s.auditLog.op, "secret_use"),
          eq(s.auditLog.outcome, "ok"),
          gte(s.auditLog.createdAt, o.since),
          lte(s.auditLog.createdAt, o.until),
        ),
      )
      .orderBy(asc(s.auditLog.createdAt), asc(s.auditLog.id))
      .limit(o.limit);
    return rows;
  });
}
