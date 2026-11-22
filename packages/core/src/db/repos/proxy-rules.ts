// A project's secrets-proxy rules. Part of the only code allowed to name tenant tables.
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { ulid } from "../ulid";
import { requireProject, type Scope, scoped } from "./scope";

export type ProxyRuleRow = typeof s.proxyRules.$inferSelect;

const COLS = { orgId: s.proxyRules.orgId, projectId: s.proxyRules.projectId };

export interface ProxyRuleInput {
  name: string;
  secret: string;
  host: string;
  port: number;
  methods: readonly string[];
  pathPrefix: string;
  inject:
    | { type: "header"; name: string; format?: string | undefined }
    | { type: "basic"; username: string };
}

/** Creates the rule, or replaces the one of that name. */
export function setProxyRule(
  db: Db,
  scope: Scope,
  createdBy: string,
  input: ProxyRuleInput,
): Promise<{ row: ProxyRuleRow; created: boolean }> {
  return db.transaction(async (tx) => {
    const { projectId } = requireProject(scope);
    const [existing] = await tx.orm
      .select()
      .from(s.proxyRules)
      .where(scoped(scope, COLS, eq(s.proxyRules.name, input.name)))
      .limit(1);
    const fields = {
      secret: input.secret,
      host: input.host,
      port: input.port,
      methods: JSON.stringify(input.methods),
      pathPrefix: input.pathPrefix,
      injectType: input.inject.type,
      injectHeader: input.inject.type === "header" ? input.inject.name : null,
      injectFormat: input.inject.type === "header" ? (input.inject.format ?? null) : null,
      injectUsername: input.inject.type === "basic" ? input.inject.username : null,
      updatedAt: Date.now(),
    };
    if (existing) {
      await tx.orm
        .update(s.proxyRules)
        .set(fields)
        .where(and(eq(s.proxyRules.id, existing.id), eq(s.proxyRules.orgId, scope.orgId)));
    } else {
      await tx.orm.insert(s.proxyRules).values({
        id: ulid(),
        orgId: scope.orgId,
        projectId,
        name: input.name,
        createdBy,
        ...fields,
      });
    }
    const [row] = await tx.orm
      .select()
      .from(s.proxyRules)
      .where(scoped(scope, COLS, eq(s.proxyRules.name, input.name)))
      .limit(1);
    return { row: row!, created: !existing };
  });
}

export function listProxyRules(db: Db, scope: Scope): Promise<ProxyRuleRow[]> {
  return db.run((h) =>
    h.orm.select().from(s.proxyRules).where(scoped(scope, COLS)).orderBy(asc(s.proxyRules.name)),
  );
}

export function deleteProxyRule(db: Db, scope: Scope, name: string): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .delete(s.proxyRules)
      .where(scoped(scope, COLS, eq(s.proxyRules.name, name)))
      .returning({ id: s.proxyRules.id });
    return rows.length > 0;
  });
}

const PT_COLS = {
  orgId: s.proxyPassthroughHosts.orgId,
  projectId: s.proxyPassthroughHosts.projectId,
};

export interface PassthroughEntry {
  host: string;
  ports: number[];
}

/** Adds the host, or replaces its ports. Returns whether it was new. */
export function setPassthroughHost(
  db: Db,
  scope: Scope,
  createdBy: string,
  host: string,
  ports: readonly number[],
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { projectId } = requireProject(scope);
    const [existing] = await tx.orm
      .select({ id: s.proxyPassthroughHosts.id })
      .from(s.proxyPassthroughHosts)
      .where(scoped(scope, PT_COLS, eq(s.proxyPassthroughHosts.host, host)))
      .limit(1);
    const json = JSON.stringify([...new Set(ports)].toSorted((x, y) => x - y));
    if (existing) {
      await tx.orm
        .update(s.proxyPassthroughHosts)
        .set({ ports: json })
        .where(
          and(
            eq(s.proxyPassthroughHosts.id, existing.id),
            eq(s.proxyPassthroughHosts.orgId, scope.orgId),
          ),
        );
      return false;
    }
    await tx.orm
      .insert(s.proxyPassthroughHosts)
      .values({ id: ulid(), orgId: scope.orgId, projectId, host, ports: json, createdBy });
    return true;
  });
}

export function listPassthroughHosts(db: Db, scope: Scope): Promise<PassthroughEntry[]> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({ host: s.proxyPassthroughHosts.host, ports: s.proxyPassthroughHosts.ports })
      .from(s.proxyPassthroughHosts)
      .where(scoped(scope, PT_COLS))
      .orderBy(asc(s.proxyPassthroughHosts.host));
    return rows.map((r) => ({ host: r.host, ports: JSON.parse(r.ports) as number[] }));
  });
}

export function deletePassthroughHost(db: Db, scope: Scope, host: string): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .delete(s.proxyPassthroughHosts)
      .where(scoped(scope, PT_COLS, eq(s.proxyPassthroughHosts.host, host)))
      .returning({ id: s.proxyPassthroughHosts.id });
    return rows.length > 0;
  });
}
