import { and, eq, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { LogKey } from "../../logstore/types";

/** Tenant scope. `orgId` is always enforced; `projectId` narrows further when set. */
export type Scope = { orgId: string; projectId?: string };

/** Builds the WHERE for a tenant-owned table: org_id always, project_id when the scope has one. */
export function scoped(
  scope: Scope,
  cols: { orgId: SQLiteColumn; projectId?: SQLiteColumn },
  ...extra: (SQL | undefined)[]
): SQL {
  if (!scope.orgId) throw new Error("scope.orgId is required");
  const parts: (SQL | undefined)[] = [eq(cols.orgId, scope.orgId)];
  if (scope.projectId !== undefined && cols.projectId) {
    parts.push(eq(cols.projectId, scope.projectId));
  }
  const where = and(...parts, ...extra);
  if (!where) throw new Error("unreachable: empty scope filter");
  return where;
}

/** Narrows a scope to one project, for writes that create project-owned rows. */
export function requireProject(scope: Scope): Scope & { projectId: string } {
  if (!scope.projectId) throw new Error("scope.projectId is required for this operation");
  return { orgId: scope.orgId, projectId: scope.projectId };
}

/** The log store key of an attempt in a project scope. */
export function logKey(scope: Scope, attemptId: string): LogKey {
  return { orgId: scope.orgId, projectId: requireProject(scope).projectId, attemptId };
}
