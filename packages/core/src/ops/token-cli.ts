// `turntable token create`: mints an agent token from the command line. Local access to the data
// directory is the trust root, so this writes through the repos directly (no network, no
// principal). The secret goes to stdout once; everything else goes to stderr.
import type { Db } from "../db";
import {
  appendAudit,
  getOrgBySlug,
  getProjectBySlug,
  insertApiToken,
  type Scope,
} from "../db/repos";
import { AGENT_ROLES, type AgentRole } from "../db/schema";
import { generateToken, hashToken } from "./tokens";

/** Roles the CLI will mint. release_operator is held back until release gating exists. */
export const CLI_ROLES = ["reader", "operator"] as const satisfies readonly AgentRole[];

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
    const known = AGENT_ROLES.includes(opts.role as AgentRole);
    throw new Error(
      known
        ? `role ${opts.role} cannot be created from the CLI yet; use one of: ${CLI_ROLES.join(", ")}`
        : `unknown role ${opts.role}; use one of: ${CLI_ROLES.join(", ")}`,
    );
  }
  const name = opts.name.trim();
  if (name.length === 0 || name.length > 80) throw new Error("--name must be 1 to 80 characters");
  const days = opts.expiresInDays ?? 90;
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error("--expires-in-days must be an integer from 1 to 365");
  }
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
