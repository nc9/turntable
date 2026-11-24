// `turntable token create`: mints an agent token from the command line. Local access to the data
// directory is the trust root, so this writes through the repos directly (no network, no
// principal). The secret goes to stdout once; everything else goes to stderr.
import type { Db } from "../db";
import {
  appendAudit,
  appendEvent,
  countActiveApiTokens,
  ensureLocalTenant,
  findApiTokenById,
  getOrgBySlug,
  getProject,
  getProjectBySlug,
  insertApiToken,
  listApiTokens,
  revokeApiToken,
  type Scope,
  tokenSubtree,
  lockOrgTokens,
} from "../db/repos";
import { AGENT_ROLES, type AgentRole, TOKEN_KINDS, type TokenKind } from "../db/schema";
import { systemOrgId } from "../audit/failures";
import { generateToken, hashToken } from "./tokens";

/** Roles the CLI will mint: every agent role. Org roles are for people and never go on a token. */
export const CLI_ROLES: readonly AgentRole[] = AGENT_ROLES;

const DAY_MS = 86_400_000;

export type TokenCreateOptions = {
  org: string;
  project?: string | undefined;
  role: string;
  /** `agent` (default) or `person`. */
  kind?: string | undefined;
  name: string;
  expiresInDays?: number | undefined;
  now?: (() => number) | undefined;
};

export type CreatedToken = {
  id: string;
  secret: string;
  role: AgentRole;
  kind: TokenKind;
  org: string;
  project: string | null;
  expiresAt: number;
};

export async function createTokenFromCli(db: Db, opts: TokenCreateOptions): Promise<CreatedToken> {
  if (!(CLI_ROLES as readonly string[]).includes(opts.role)) {
    throw new Error(`unknown role ${opts.role}; use one of: ${CLI_ROLES.join(", ")}`);
  }
  const kind = opts.kind ?? "agent";
  if (!(TOKEN_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`unknown kind ${kind}; use one of: ${TOKEN_KINDS.join(", ")}`);
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
      kind: kind as TokenKind,
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
      input: {
        name,
        role,
        kind,
        org: opts.org,
        project: opts.project ?? null,
        expires_in_days: days,
      },
    });
    return created;
  });
  return {
    id: row.id,
    secret,
    role,
    kind: kind as TokenKind,
    org: opts.org,
    project: opts.project ?? null,
    expiresAt,
  };
}

export type TokenSummary = {
  id: string;
  name: string;
  role: AgentRole;
  kind: TokenKind;
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
      // The column defaults to agent; anything but an explicit person reads as one (fail closed).
      kind: r.kind === "person" ? "person" : "agent",
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
    await lockOrgTokens(tx, row.orgId);
    const { rootChanged, children } = await revokeTokenCascade(tx, row.orgId, row.id, now(), {
      kind: "cli",
      id: "local",
    });
    // An already revoked root whose descendants were still live is not an error (a rotation).
    if (!rootChanged && children.length === 0) {
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
    // The last usable token gone leaves the org with no access but the instance administrator's
    // re-mint, which now waits (#367): tell the org, in both chains and on its feed.
    if ((await countActiveApiTokens(tx, { orgId: row.orgId }, now())) === 0) {
      await recordOrgTokensExhausted(tx, row.orgId, row.id, { kind: "cli", id: "local" });
    }
  });
  return { id: row.id, name: row.name };
}

/**
 * What revoking `rootId` would take with it: the token and every token it minted, transitively
 * (#437). `active` is the subset that is usable now; `survivors` counts the org's usable tokens
 * outside the subtree, so a caller can tell whether the revoke would leave the org with none.
 */
export async function planTokenCascade(
  db: Db,
  orgId: string,
  rootId: string,
  now: number,
  cascade: boolean,
): Promise<{ subtree: { id: string; name: string }[]; activeInTree: number; survivors: number }> {
  const all = await tokenSubtree(db, orgId, rootId);
  const subtree = cascade ? all : all.slice(0, 1);
  const usable = (t: { revokedAt: number | null; expiresAt: number | null }) =>
    t.revokedAt === null && (t.expiresAt === null || t.expiresAt > now);
  const activeInTree = subtree.filter(usable).length;
  const total = await countActiveApiTokens(db, { orgId }, now);
  return {
    subtree: subtree.map((t) => ({ id: t.id, name: t.name })),
    activeInTree,
    survivors: total - activeInTree,
  };
}

/**
 * Revokes a token and, when `cascade`, in the same transaction every token it minted (transitively), and audits
 * each child as `parent revoked` with the parent id (never a secret). Call it inside the revoking
 * transaction after `lockOrgTokens`. Returns whether the root changed and the child ids revoked.
 */
export async function revokeTokenCascade(
  tx: Db,
  orgId: string,
  rootId: string,
  now: number,
  by: { kind: string; id: string },
  cascade = true,
): Promise<{ rootChanged: boolean; children: string[] }> {
  const subtree = cascade ? await tokenSubtree(tx, orgId, rootId) : [];
  const rootChanged = await revokeApiToken(tx, { orgId }, rootId, now);
  const children: string[] = [];
  for (const t of subtree) {
    if (t.id === rootId) continue;
    if (!(await revokeApiToken(tx, { orgId }, t.id, now))) continue;
    children.push(t.id);
    await appendAudit(
      tx,
      { orgId },
      {
        principalKind: by.kind,
        principalId: by.id,
        op: "revoke_api_token",
        effect: "destructive",
        outcome: "ok",
        input: { id: t.id, name: t.name, reason: "parent revoked", parent_id: rootId },
      },
    );
  }
  return { rootChanged, children };
}

/**
 * The org's last usable token was just revoked: it has no access but the instance administrator's
 * re-mint, which waits (#367). Tells the org, in both audit chains and on its feed. Call inside
 * the revoking transaction.
 */
export async function recordOrgTokensExhausted(
  tx: Db,
  orgId: string,
  revokedId: string,
  by: { kind: string; id: string },
): Promise<void> {
  await appendAudit(
    tx,
    { orgId },
    {
      principalKind: by.kind,
      principalId: by.id,
      op: "org_tokens_exhausted",
      effect: "write",
      outcome: "ok",
      input: { revoked_id: revokedId },
    },
  );
  await appendAudit(
    tx,
    { orgId: await systemOrgId(tx) },
    {
      principalKind: by.kind,
      principalId: by.id,
      op: "org_tokens_exhausted",
      effect: "write",
      outcome: "ok",
      input: { org_id: orgId, revoked_id: revokedId },
    },
  );
  await appendEvent(
    tx,
    { orgId },
    { type: "org.tokens_exhausted", payload: { revoked_id: revokedId, reason: "revoked" } },
  );
}
