// `turntable token create`: mints an agent token from the command line. Local access to the data
// directory is the trust root, so this writes through the repos directly (no network, no
// principal). The secret goes to stdout once; everything else goes to stderr.
import type { Db } from "../db";
import {
  appendAudit,
  ensureLocalTenant,
  findApiTokenById,
  getOrgBySlug,
  getProject,
  getProjectBySlug,
  insertApiToken,
  listApiTokens,
  revokeApiToken,
  type Scope,
} from "../db/repos";
import { AGENT_ROLES, type AgentRole } from "../db/schema";
import { generateToken, hashToken } from "./tokens";

/** Roles the CLI will mint: every agent role. Org roles are for people and never go on a token. */
export const CLI_ROLES: readonly AgentRole[] = AGENT_ROLES;

const DAY_MS = 86_400_000;

export type TokenCreateOptions = {
  org: string;
  project?: string | undefined;
  role: string;
  name: string;
  expiresInDays?: number | undefined;
  now?: (() => number) | undefined;
};

export type CreatedToken = {
  id: string;
  secret: string;
  role: AgentRole;
  org: string;
  project: string | null;
  expiresAt: number;
};

export async function createTokenFromCli(db: Db, opts: TokenCreateOptions): Promise<CreatedToken> {
  if (!(CLI_ROLES as readonly string[]).includes(opts.role)) {
    throw new Error(`unknown role ${opts.role}; use one of: ${CLI_ROLES.join(", ")}`);
  }
  const name = opts.name.trim();
  if (name.length === 0 || name.length > 80) throw new Error("--name must be 1 to 80 characters");
  const days = opts.expiresInDays ?? 90;
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error("--expires-days must be an integer from 1 to 365");
  }
  // The built-in `local` org and project exist from the first local run; create them on demand
  // so a fresh data directory can mint its first token.
  if (opts.org === "local" && !(await getOrgBySlug(db, "local"))) await ensureLocalTenant(db);
  const org = await getOrgBySlug(db, opts.org);
  if (!org) throw new Error(`no org with slug ${opts.org}`);
  let scope: Scope = { orgId: org.id };
  if (opts.project !== undefined) {
    const project = await getProjectBySlug(db, scope, opts.project);
    if (!project) throw new Error(`no project ${opts.project} in org ${opts.org}`);
    scope = { orgId: org.id, projectId: project.id };
  }
  const secret = generateToken();
  const expiresAt = (opts.now ?? Date.now)() + days * DAY_MS;
  const role = opts.role as AgentRole;
  const row = await db.transaction(async (tx) => {
    const created = await insertApiToken(tx, scope, {
      name,
      role,
      tokenHash: hashToken(secret),
      createdBy: "cli:local",
      expiresAt,
    });
    await appendAudit(tx, scope, {
      principalKind: "cli",
      principalId: "local",
      op: "create_api_token",
      effect: "write",
      outcome: "ok",
      input: { name, role, org: opts.org, project: opts.project ?? null, expires_in_days: days },
    });
    return created;
  });
  return {
    id: row.id,
    secret,
    role,
    org: opts.org,
    project: opts.project ?? null,
    expiresAt,
  };
}

export type TokenSummary = {
  id: string;
  name: string;
  role: AgentRole;
  project: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  status: "active" | "revoked" | "expired";
};

/** Tokens of an org, or of one project of it. Never includes a secret or a hash. */
export async function listTokensFromCli(
  db: Db,
  opts: { org: string; project?: string | undefined; now?: (() => number) | undefined },
): Promise<TokenSummary[]> {
  const org = await getOrgBySlug(db, opts.org);
  if (!org) throw new Error(`no org with slug ${opts.org}`);
  let scope: Scope = { orgId: org.id };
  if (opts.project !== undefined) {
    const project = await getProjectBySlug(db, scope, opts.project);
    if (!project) throw new Error(`no project ${opts.project} in org ${opts.org}`);
    scope = { orgId: org.id, projectId: project.id };
  }
  const now = (opts.now ?? Date.now)();
  const rows = await listApiTokens(db, scope);
  const slugs = new Map<string, string>();
  const slugOf = async (projectId: string | null): Promise<string | null> => {
    if (projectId === null) return null;
    if (!slugs.has(projectId)) {
      slugs.set(projectId, (await getProject(db, { orgId: org.id }, projectId))?.slug ?? projectId);
    }
    return slugs.get(projectId) ?? null;
  };
  const out: TokenSummary[] = [];
  for (const r of rows) {
    out.push({
      id: r.id,
      name: r.name,
      role: r.role as AgentRole,
      project: await slugOf(r.projectId),
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
      status:
        r.revokedAt !== null
          ? "revoked"
          : r.expiresAt !== null && r.expiresAt <= now
            ? "expired"
            : "active",
    });
  }
  return out;
}

/** Revokes a token by id. Throws for an unknown or already revoked token. Audited. */
export async function revokeTokenFromCli(
  db: Db,
  id: string,
  now: () => number = Date.now,
): Promise<{ id: string; name: string }> {
  const row = await findApiTokenById(db, id);
  if (!row) throw new Error(`no token with id ${id}`);
  const scope: Scope = { orgId: row.orgId, ...(row.projectId ? { projectId: row.projectId } : {}) };
  await db.transaction(async (tx) => {
    if (!(await revokeApiToken(tx, scope, row.id, now()))) {
      throw new Error(`token ${id} is already revoked`);
    }
    await appendAudit(tx, scope, {
      principalKind: "cli",
      principalId: "local",
      op: "revoke_api_token",
      effect: "destructive",
      outcome: "ok",
      input: { id: row.id, name: row.name },
    });
  });
  return { id: row.id, name: row.name };
}
