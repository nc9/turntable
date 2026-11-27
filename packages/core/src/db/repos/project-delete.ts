// Deleting a project and everything that hangs off it (#577). Used by `remove_project` with
// `delete_history` and by `instance_prune_unconfigured_projects`. The audit chains are never
// touched: an entry that names a deleted project stays, and says what was deleted.
//
// The rows to delete are found from the schema's own foreign keys, so a table added later that
// points at a project (or at a table that does) is deleted with it and cannot block the delete.
import { getTableName, is, sql, type SQL } from "drizzle-orm";
import { getTableConfig as pgConfig, PgTable } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "..";
import { DIALECT } from "../dialect";
import * as s from "../schema";
import { externalLogStore } from "../../logstore/registry";
import { forgetOrgBytes } from "./quotas";
import type { Scope } from "./scope";

type Fk = { cols: string[]; parent: string; parentCols: string[] };
type TableInfo = { name: string; table: SQLiteTable; columns: Set<string>; fks: Fk[] };

const IDENT = /^[a-z_][a-z0-9_]*$/;
const q = (ident: string): SQL => {
  if (!IDENT.test(ident)) throw new Error(`unexpected identifier ${ident}`);
  return sql.raw(`"${ident}"`);
};

let cached: Map<string, TableInfo> | undefined;

function tables(): Map<string, TableInfo> {
  if (cached) return cached;
  const out = new Map<string, TableInfo>();
  for (const t of Object.values(s)) {
    const isPg = DIALECT === "pg";
    if (!is(t, isPg ? PgTable : SQLiteTable)) continue;
    const cfg = isPg ? pgConfig(t as PgTable) : sqliteConfig(t as SQLiteTable);
    out.set(cfg.name, {
      name: cfg.name,
      table: t as SQLiteTable,
      columns: new Set(cfg.columns.map((c) => c.name)),
      fks: cfg.foreignKeys.map((fk) => {
        const r = fk.reference();
        return {
          cols: r.columns.map((c) => c.name),
          parent: getTableName(r.foreignTable),
          parentCols: r.foreignColumns.map((c) => c.name),
        };
      }),
    });
  }
  cached = out;
  return out;
}

/** The tables whose rows hang off a project through foreign keys, deepest first. */
export function projectDependents(): string[] {
  const all = tables();
  const depth = new Map<string, number>([["projects", 0]]);
  // Longest path from `projects`, found by relaxation (the schema has no cycles through projects).
  for (let pass = 0; pass <= all.size; pass++) {
    let changed = false;
    for (const t of all.values()) {
      if (t.name === "projects") continue;
      for (const fk of t.fks) {
        if (fk.parent === t.name) continue;
        const d = depth.get(fk.parent);
        if (d !== undefined && (depth.get(t.name) ?? -1) < d + 1) {
          depth.set(t.name, d + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
    if (pass === all.size) throw new Error("foreign key cycle under projects");
  }
  return [...depth.entries()]
    .filter(([n]) => n !== "projects")
    .toSorted((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([n]) => n);
}

/** WHERE (as SQL) selecting this project's rows of `name`, which must be `projects` or a dependent. */
function condition(name: string, orgId: string, projectId: string, deps: Set<string>): SQL {
  if (name === "projects") return sql`${q("id")} = ${projectId} AND ${q("org_id")} = ${orgId}`;
  const t = tables().get(name)!;
  const parts: SQL[] = [];
  for (const fk of t.fks) {
    if (fk.parent === name || (fk.parent !== "projects" && !deps.has(fk.parent))) continue;
    const cols = sql.join(
      fk.cols.map((c) => q(c)),
      sql`, `,
    );
    const pcols = sql.join(
      fk.parentCols.map((c) => q(c)),
      sql`, `,
    );
    parts.push(
      sql`(${cols}) IN (SELECT ${pcols} FROM ${q(fk.parent)} WHERE ${condition(fk.parent, orgId, projectId, deps)})`,
    );
  }
  return sql.join(parts, sql` OR `);
}

/** The number of rows each dependent table holds for the project (zero tables left out). */
export function countProjectRows(
  db: Db,
  scope: { orgId: string },
  projectId: string,
): Promise<Record<string, number>> {
  return db.run(async (h) => {
    const deps = new Set(projectDependents());
    const out: Record<string, number> = {};
    for (const name of deps) {
      const rows = await h.orm
        .select({ n: sql<number | string>`count(*)` })
        .from(tables().get(name)!.table)
        .where(condition(name, scope.orgId, projectId, deps));
      const n = Number(rows[0]?.n ?? 0);
      if (n > 0) out[name] = n;
    }
    return out;
  });
}

/**
 * Deletes a project and every row of it: runs, jobs, logs, artifacts, tokens and secrets scoped to
 * it, settings, bindings. One transaction. Returns false when the org has no such project.
 */
export function deleteProjectCascade(db: Db, scope: Scope, projectId: string): Promise<boolean> {
  const ext = externalLogStore();
  return db.transaction(async (tx) => {
    const deps = new Set(projectDependents());
    const exists = await tx.orm
      .select({ x: sql<number>`1` })
      .from(tables().get("projects")!.table)
      .where(condition("projects", scope.orgId, projectId, deps));
    if (exists.length === 0) return false;
    // Rows that name the project with no foreign key (approval records and the like), except the
    // audit chains, which stay.
    for (const t of tables().values()) {
      if (t.name === "projects" || t.name === "audit_log" || deps.has(t.name)) continue;
      if (t.columns.has("project_id") && t.columns.has("org_id")) {
        await tx.orm
          .delete(t.table)
          .where(sql`${q("org_id")} = ${scope.orgId} AND ${q("project_id")} = ${projectId}`);
      }
    }
    await tx.orm
      .delete(s.settings)
      .where(
        sql`${q("scope_kind")} = 'project' AND ${q("scope_id")} = ${projectId} AND ${q("org_id")} = ${scope.orgId}`,
      );
    for (const name of deps) {
      await tx.orm
        .delete(tables().get(name)!.table)
        .where(condition(name, scope.orgId, projectId, deps));
    }
    await tx.orm.delete(s.projects).where(condition("projects", scope.orgId, projectId, deps));
    // An external store's logs go after the outermost commit and are not awaited: no HTTP under the
    // write lock, even when an op's own transaction wraps this call. The project is already gone,
    // so an unreachable store does not undo it: the retention TTL removes the rest.
    if (ext) {
      tx.afterCommit(() => {
        void ext
          .deleteProject(scope.orgId, projectId)
          .catch(() => {})
          .then(() => forgetOrgBytes(scope.orgId));
      });
    }
    return true;
  });
}

export type PruneCandidate = { id: string; slug: string; repos: string[] };

/**
 * The projects of an org that installation sync created and nobody set up (#577): never added on
 * purpose (`added_at` null), made by a sync (it has, or had, an installation binding), every
 * setting at its default (paused is the default a sync gives), no setting row, no run, no token,
 * secret, rule, pin, artifact or any other row of its own beyond its binding, and not named by a
 * static poll entry. An onboarding row names a project only through its first run or its agent
 * token, and both are rows of the project, so a project with either is never listed. Ordered by id.
 */
export function listPruneCandidates(
  db: Db,
  scope: { orgId: string },
  opts: { staticPollSlugs?: ReadonlySet<string> | undefined } = {},
): Promise<PruneCandidate[]> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select()
      .from(s.projects)
      .where(sql`${q("org_id")} = ${scope.orgId}`)
      .orderBy(s.projects.id);
    const out: PruneCandidate[] = [];
    for (const p of rows) {
      const defaults =
        p.addedAt === null &&
        (p.maxConcurrent === null || p.maxConcurrent === 0) &&
        p.requireShaPins === 0 &&
        p.egress === "none" &&
        p.releaseRefs === null &&
        p.signingKey === null &&
        p.signingEnvironment === null &&
        p.checksMode === "off" &&
        p.ingestConfig === null &&
        p.frozenAt === null &&
        p.cacheReleaseRestore === 0 &&
        p.oidcAudiences === null &&
        p.sandboxSnapshot === null &&
        p.untrustedRunApproval === "no_agents";
      if (!defaults || opts.staticPollSlugs?.has(p.slug)) continue;
      const bindings = await h.orm
        .select()
        .from(s.projectRepos)
        .where(sql`${q("org_id")} = ${scope.orgId} AND ${q("project_id")} = ${p.id}`);
      const fromSync =
        p.lastForgeRepoId !== null || bindings.some((b) => b.installationId !== null);
      if (!fromSync) continue;
      const [setting] = await h.orm
        .select({ k: s.settings.key })
        .from(s.settings)
        .where(
          sql`${q("scope_kind")} = 'project' AND ${q("scope_id")} = ${p.id} AND ${q("org_id")} = ${scope.orgId}`,
        )
        .limit(1);
      if (setting) continue;
      const owned = await countProjectRows(h, scope, p.id);
      if (Object.keys(owned).some((t) => t !== "project_repos")) continue;
      out.push({
        id: p.id,
        slug: p.slug,
        repos: bindings.map((b) => `${b.owner}/${b.repo}`),
      });
    }
    return out;
  });
}
