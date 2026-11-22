// The single enforcement point for operations. Authentication, scope, role, validation and audit
// all happen here; adapters (REST, MCP, CLI) only translate transport and never decide access.
import { auditFailure } from "../audit/failures";
import type { Db } from "../db";
import {
  appendAudit,
  findApiTokenByHash,
  getOrgById,
  getOrgBySlug,
  getProjectBySlug,
  type Scope,
  touchApiToken,
} from "../db/repos";
import type { Op, OpContext } from "./define";
import { OpError } from "./errors";
import type { Credential, Principal } from "./principal";
import type { OpRegistry } from "./registry";
import { roleSatisfies } from "./roles";
import { hashToken, looksLikeToken } from "./tokens";

export type DispatchEnv = {
  registry: OpRegistry;
  db: Db;
  now?: () => number;
};

export type DispatchResult =
  | { ok: true; op: Op; output: unknown; untrusted: boolean }
  | { ok: false; error: OpError; op?: Op };

/** How often a token's last_used_at is refreshed, so reads do not become writes. */
const TOUCH_INTERVAL_MS = 60_000;

const BAD_TOKEN = "invalid, expired or revoked token";

/**
 * An `unauthenticated` OpError that remembers which org's token it was, when it was one, so the
 * failure can be audited in that org's chain.
 */
export class AuthFailure extends OpError {
  readonly orgId: string | undefined;
  readonly tokenId: string | undefined;
  constructor(orgId?: string, tokenId?: string) {
    super("unauthenticated", BAD_TOKEN);
    this.orgId = orgId;
    this.tokenId = tokenId;
  }
}

/** A short stable digest of an unrecognised token, so repeats of it share a throttle bucket. */
const unknownTokenSource = (c: Credential): string =>
  c.kind === "bearer" ? hashToken(c.token).slice(0, 12) : "none";

/** Step 1: turns a credential into a principal, or throws `unauthenticated`. */
export async function authenticate(env: DispatchEnv, credential: Credential): Promise<Principal> {
  if (credential.kind === "principal") return credential.principal;
  const token = credential.token;
  // One message for every failure, so a caller cannot tell a wrong token from a revoked one.
  if (!looksLikeToken(token)) throw new AuthFailure();
  const row = await findApiTokenByHash(env.db, hashToken(token));
  const now = (env.now ?? Date.now)();
  if (!row || row.revokedAt !== null || (row.expiresAt !== null && row.expiresAt <= now)) {
    throw new AuthFailure(row?.orgId, row?.id);
  }
  if (row.lastUsedAt === null || now - row.lastUsedAt > TOUCH_INTERVAL_MS) {
    // Best effort: a failed touch must not fail the call.
    await touchApiToken(
      env.db,
      { orgId: row.orgId, ...(row.projectId ? { projectId: row.projectId } : {}) },
      row.id,
      now,
    ).catch(() => {});
  }
  return {
    kind: "token",
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    role: row.role as Extract<Principal, { kind: "token" }>["role"],
  };
}

const NO_SUCH_SCOPE = "org or project not found";

/**
 * Step 2: resolves the Scope from the principal's grant. The input's `org` and `project` can
 * only narrow it. A target outside the grant and one that does not exist give the same error.
 */
async function resolveScope(
  db: Db,
  principal: Principal,
  op: Op,
  raw: Record<string, unknown>,
): Promise<Scope> {
  const orgSlug = raw.org;
  const projectSlug = raw.project;
  if (orgSlug !== undefined && typeof orgSlug !== "string") {
    throw new OpError("invalid_input", "org must be a string");
  }
  if (projectSlug !== undefined && typeof projectSlug !== "string") {
    throw new OpError("invalid_input", "project must be a string");
  }
  const org =
    orgSlug === undefined ? await getOrgById(db, principal.orgId) : await getOrgBySlug(db, orgSlug);
  if (!org || org.id !== principal.orgId) throw new OpError("not_found", NO_SUCH_SCOPE);
  const grantProject = principal.kind === "token" ? principal.projectId : null;
  let projectId: string | undefined = grantProject ?? undefined;
  if (projectSlug !== undefined) {
    const project = await getProjectBySlug(db, { orgId: org.id }, projectSlug);
    if (!project || (grantProject !== null && project.id !== grantProject)) {
      throw new OpError("not_found", NO_SUCH_SCOPE);
    }
    projectId = project.id;
  }
  if (op.scope === "project" && projectId === undefined) {
    throw new OpError("invalid_input", "project is required for this operation");
  }
  return { orgId: org.id, ...(projectId ? { projectId } : {}) };
}

/**
 * For trusted in-process readers (the realtime server): authenticates a credential and resolves
 * the Scope of its grant with exactly the checks an operation gets. The data itself must still
 * be read by dispatching an operation, so roles, caps and redaction are never duplicated.
 */
export async function resolveCallerScope(
  env: DispatchEnv,
  credential: Credential,
  raw: Record<string, unknown> = {},
): Promise<{ principal: Principal; scope: Scope }> {
  const principal = await authenticate(env, credential);
  const scope = await resolveScope(env.db, principal, { scope: "org" } as Op, raw);
  return { principal, scope };
}

function validateInput(op: Op, raw: Record<string, unknown>): Record<string, unknown> {
  const parsed = op.input.safeParse(raw);
  if (!parsed.success) {
    throw new OpError(
      "invalid_input",
      "input does not match the operation's schema",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const { org: _org, project: _project, ...rest } = parsed.data as Record<string, unknown>;
  return rest;
}

function validateOutput(op: Op, output: unknown): unknown {
  const parsed = op.output.safeParse(output);
  if (!parsed.success) {
    // Never echo the offending value: it may be exactly what the schema exists to keep out.
    console.error(
      `longshore: op ${op.name} returned output that violates its schema`,
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
    throw new OpError("internal", "operation produced an invalid response");
  }
  // Parsed output drops fields the schema does not declare, a second guard against leaks.
  return parsed.data;
}

/**
 * Runs one operation for a credential.
 *
 * 1 authenticate, 2 resolve scope and check the grant, 3 check the role, 4 validate input,
 * 5 run the handler, 6 validate output, 7 audit writes. Reads run directly; writes run, and
 * write their audit row, in one transaction, so a failed write leaves no partial effect. A
 * failed or denied write is still audited, outside that transaction.
 */
export async function dispatch(
  env: DispatchEnv,
  credential: Credential,
  name: string,
  rawInput: unknown,
): Promise<DispatchResult> {
  let op: Op | undefined;
  try {
    let principal: Principal;
    try {
      principal = await authenticate(env, credential);
    } catch (err) {
      // An authentication failure has no scope yet; it is audited in the token's org, or in the
      // system chain when the token names none (throttled either way).
      if (err instanceof AuthFailure) {
        await auditFailure(env.db, {
          orgId: err.orgId,
          principalKind: "token",
          principalId: err.tokenId ?? "unknown",
          source: err.tokenId ?? `unknown:${unknownTokenSource(credential)}`,
          trackFirst: err.tokenId !== undefined,
          op: name,
          outcome: "error:unauthenticated",
          detail: { reason: err.orgId ? "revoked_or_expired" : "unknown_or_malformed" },
        });
      }
      throw err;
    }
    op = env.registry.get(name);
    if (!op) throw new OpError("not_found", `unknown operation: ${name}`);
    // Signature ops need a human-signed assertion. No bearer token or in-process principal
    // carries one, so they are refused here, not just left out of adapters.
    if (op.auth.type === "signature") {
      throw new OpError("signature_required", `${op.name} requires a human signature`);
    }
    if (rawInput === null || typeof rawInput !== "object" || Array.isArray(rawInput)) {
      throw new OpError("invalid_input", "input must be a JSON object");
    }
    const raw = rawInput as Record<string, unknown>;
    const scope = await resolveScope(env.db, principal, op, raw);
    const audited = op.effect !== "read";
    const audit = (outcome: string, input: unknown) =>
      appendAudit(env.db, scope, {
        principalKind: principal.kind,
        principalId: principal.id,
        op: op!.name,
        effect: op!.effect,
        outcome,
        input,
      }).catch(() => {});

    if (!roleSatisfies(principal.role, op.auth.minRole)) {
      if (audited) await audit("error:forbidden", raw);
      throw new OpError("forbidden", `${op.name} requires role ${op.auth.minRole}`);
    }
    let input: Record<string, unknown>;
    try {
      input = validateInput(op, raw);
    } catch (err) {
      if (audited) await audit("error:invalid_input", raw);
      throw err;
    }
    const ctx = (db: Db): OpContext => ({
      db,
      scope,
      principal,
      now: env.now ?? Date.now,
    });
    const target = op;
    if (!audited) {
      const output = validateOutput(target, await target.handler(ctx(env.db), input));
      return { ok: true, op: target, output, untrusted: target.untrustedOutput };
    }
    try {
      const output = await env.db.transaction(async (tx) => {
        const out = validateOutput(target, await target.handler(ctx(tx), input));
        await appendAudit(tx, scope, {
          principalKind: principal.kind,
          principalId: principal.id,
          op: target.name,
          effect: target.effect,
          outcome: "ok",
          input,
        });
        return out;
      });
      return { ok: true, op: target, output, untrusted: target.untrustedOutput };
    } catch (err) {
      const code = err instanceof OpError ? err.code : "internal";
      await audit(`error:${code}`, input);
      throw err;
    }
  } catch (err) {
    if (err instanceof OpError) return { ok: false, error: err, ...(op ? { op } : {}) };
    console.error("longshore: unexpected error in operation dispatch", err);
    return { ok: false, error: new OpError("internal", "internal error"), ...(op ? { op } : {}) };
  }
}
