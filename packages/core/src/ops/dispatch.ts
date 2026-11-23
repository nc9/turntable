// The single enforcement point for operations. Authentication, scope, role, validation and audit
// all happen here; adapters (REST, MCP, CLI) only translate transport and never decide access.
import { auditFailure, systemOrgId } from "../audit/failures";
import type { BackupConfig } from "../db/backup";
import type { SettingsRuntime } from "../settings/resolve";
import type { Db } from "../db";
import {
  appendAudit,
  findApiTokenByHash,
  findInstanceTokenByHash,
  getOrgById,
  getOrgBySlug,
  getProjectBySlug,
  type Scope,
  touchApiToken,
  touchInstanceToken,
} from "../db/repos";
import type { DoctorReport } from "../doctor/types";
import type { Op, OpContext } from "./define";
import type { TrustAnchors } from "../approvals/attestation";
import type { RelyingParty } from "../approvals/webauthn";
import type { WebhookService } from "../webhooks/service";
import type { GithubFacts } from "../github/api";
import type { InstallationClaims } from "../github/claim";
import type { SecretStore } from "../secrets/store";
import type { SecretVault } from "../secrets/vault";
import { OpError } from "./errors";
import { authenticateSigned } from "./signed";
import { type Credential, orgRole, type Principal } from "./principal";
import type { OpRegistry } from "./registry";
import { roleSatisfies } from "./roles";
import { hashToken, looksLikeInstanceToken, looksLikeToken } from "./tokens";

export type Transport = "mcp" | "rest";

export type DispatchEnv = {
  registry: OpRegistry;
  db: Db;
  now?: () => number;
  /** Set when the server has a master key; the vault ops need it. */
  vault?: SecretVault | undefined;
  claims?: InstallationClaims | undefined;
  /** GitHub API facts (the App's credentials); `resync_installation` needs them. */
  githubFacts?: GithubFacts | undefined;
  /**
   * Let a `tti_` instance token authenticate. Set only by the REST adapter: MCP and the realtime
   * socket leave it off, so an instance token is simply not a credential there.
   */
  allowInstance?: boolean | undefined;
  /**
   * Which adapter carries the call. Set by the MCP adapters (`mcp`) and the REST adapter
   * (`rest`); absent for in-process callers (the CLI, tests). `approve_run` reads it to refuse an
   * MCP call under a project's `no_agents` policy.
   */
  transport?: Transport | undefined;
  /** The instance's per-org concurrency cap (`--org-cap`), the ceiling `set_quotas` clamps to. */
  instanceOrgCap?: number | undefined;
  /** The data dir and database file `db_backup` works on; `{ dialect: "pg" }` on Postgres. */
  backup?: BackupConfig | undefined;
  webhooks?: WebhookService | undefined;
  /** WebAuthn relying party for human approvals (TURNTABLE_PUBLIC_URL or the WEBAUTHN vars). */
  webauthn?: RelyingParty | undefined;
  /** Attestation trust anchors; the pinned vendor roots when absent. */
  attestationAnchors?: TrustAnchors | undefined;
  /** The secret store, for ops that read an org's audit public key; absent without a master key. */
  auditStore?: SecretStore | undefined;
  /** The readiness checks, for the `doctor` operation. */
  doctor?: (() => Promise<DoctorReport>) | undefined;
  /** The settings registry and its environment and file layers (boot builds it). */
  settings?: SettingsRuntime | undefined;
  /** Set by the MCP adapter alone: the call is an agent's, so MCP-off settings are refused. */
  viaMcp?: boolean | undefined;
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

/** The input as audited: fields that carry a secret value never go into the log. */
export function redactInput(op: Op, input: unknown): unknown {
  if (op.secretInputFields.length === 0 || input === null || typeof input !== "object") {
    return input;
  }
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const f of op.secretInputFields) if (f in out) out[f] = "[redacted]";
  return out;
}

/** A short stable digest of an unrecognised token, so repeats of it share a throttle bucket. */
const unknownTokenSource = (c: Credential): string =>
  c.kind === "bearer" ? hashToken(c.token).slice(0, 12) : "none";

/** Step 1: turns a credential into a principal, or throws `unauthenticated`. */
export async function authenticate(env: DispatchEnv, credential: Credential): Promise<Principal> {
  if (credential.kind === "principal") return credential.principal;
  // A signed request is authenticated against its input, by authenticateSigned.
  if (credential.kind === "signed") throw new AuthFailure();
  const token = credential.token;
  if (looksLikeInstanceToken(token)) return authenticateInstance(env, token);
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
    // Only an explicit `person` is one; anything else, a missing value included, is an agent.
    tokenKind: row.kind === "person" ? "person" : "agent",
  };
}

/**
 * A `tti_` token. Accepted only when the adapter allows it, from the instance_tokens table (never
 * api_tokens), and the principal it gives holds no org grant. Failures look like any bad token.
 */
async function authenticateInstance(env: DispatchEnv, token: string): Promise<Principal> {
  if (env.allowInstance !== true) throw new AuthFailure();
  const row = await findInstanceTokenByHash(env.db, hashToken(token));
  const now = (env.now ?? Date.now)();
  if (!row || row.revokedAt !== null || (row.expiresAt !== null && row.expiresAt <= now)) {
    throw new AuthFailure(await systemOrgId(env.db), row?.id);
  }
  if (row.lastUsedAt === null || now - row.lastUsedAt > TOUCH_INTERVAL_MS) {
    await touchInstanceToken(env.db, row.id, now).catch(() => {});
  }
  return { kind: "instance", id: row.id, orgId: await systemOrgId(env.db), role: "instance_admin" };
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
      `turntable: op ${op.name} returned output that violates its schema`,
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
      if (credential.kind === "signed") {
        const signedOp = env.registry.get(name);
        if (!signedOp) throw new OpError("not_found", `unknown operation: ${name}`);
        if (rawInput === null || typeof rawInput !== "object" || Array.isArray(rawInput))
          throw new OpError("invalid_input", "input must be a JSON object");
        const r = await authenticateSigned(env, signedOp, rawInput as Record<string, unknown>);
        principal = r.principal;
        rawInput = r.raw;
      } else {
        principal = await authenticate(env, credential);
      }
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
    if (op.auth.type === "signature" && credential.kind !== "signed") {
      throw new OpError("signature_required", `${op.name} requires a human signature`);
    }
    // An approver principal is proof of one signed statement, good for signature ops only.
    if (principal.kind === "approver" && op.auth.type !== "signature") {
      throw new OpError("forbidden", `${op.name} does not take a signed request`);
    }
    if (rawInput === null || typeof rawInput !== "object" || Array.isArray(rawInput)) {
      throw new OpError("invalid_input", "input must be a JSON object");
    }
    const raw = rawInput as Record<string, unknown>;
    // Instance ops and org ops never meet: an instance op takes the instance administrator and
    // no one else (an org token of any role is refused), and the administrator, who holds no org
    // grant, is refused every org op. The instance op's scope is the system org, where its audit
    // entries go.
    if (op.auth.type === "instance" && principal.kind !== "instance") {
      throw new OpError("forbidden", `${op.name} is for the instance administrator`);
    }
    if (op.auth.type !== "instance" && principal.kind === "instance") {
      throw new OpError("forbidden", "an instance token holds no org grant");
    }
    const scope: Scope =
      principal.kind === "instance"
        ? { orgId: principal.orgId }
        : await resolveScope(env.db, principal, op, raw);
    const audited = op.effect !== "read";
    const audit = (outcome: string, input: unknown) =>
      appendAudit(env.db, scope, {
        principalKind: principal.kind,
        principalId: principal.id,
        op: op!.name,
        effect: op!.effect,
        outcome,
        input: redactInput(op!, input),
      }).catch(() => {});

    if (
      op.auth.type !== "signature" &&
      op.auth.type !== "instance" &&
      !roleSatisfies(orgRole(principal), op.auth.minRole)
    ) {
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
      vault: env.vault,
      claims: env.claims,
      githubFacts: env.githubFacts,
      webhooks: env.webhooks,
      webauthn: env.webauthn,
      transport: env.transport,
      instanceOrgCap: env.instanceOrgCap,
      backup: env.backup,
      attestationAnchors: env.attestationAnchors,
      doctor: env.doctor,
      auditStore: env.auditStore,
      settings: env.settings,
      viaMcp: env.viaMcp,
    });
    const target = op;
    if (!audited) {
      const output = validateOutput(target, await target.handler(ctx(env.db), input));
      return { ok: true, op: target, output, untrusted: target.untrustedOutput };
    }
    if (target.outsideTransaction) {
      // The handler runs without the write lock; the audit row gets its own short transaction.
      let output: unknown;
      try {
        output = validateOutput(target, await target.handler(ctx(env.db), input));
      } catch (err) {
        const code = err instanceof OpError ? err.code : "internal";
        await audit(`error:${code}`, input);
        throw err;
      }
      const detail = target.auditDetail?.(output) ?? {};
      await env.db.transaction(
        async (tx) => {
          await appendAudit(tx, scope, {
            principalKind: principal.kind,
            principalId: principal.id,
            op: target.name,
            effect: target.effect,
            outcome: "ok",
            input: { ...(redactInput(target, input) as object), ...detail },
          });
        },
        { lock: `audit:${scope.orgId}` },
      );
      return { ok: true, op: target, output, untrusted: target.untrustedOutput };
    }
    try {
      const output = await env.db.transaction(
        async (tx) => {
          const out = validateOutput(target, await target.handler(ctx(tx), input));
          await appendAudit(tx, scope, {
            principalKind: principal.kind,
            principalId: principal.id,
            op: target.name,
            effect: target.effect,
            outcome: "ok",
            input: redactInput(target, input),
          });
          return out;
        },
        { lock: `audit:${scope.orgId}` },
      );
      return { ok: true, op: target, output, untrusted: target.untrustedOutput };
    } catch (err) {
      const code = err instanceof OpError ? err.code : "internal";
      await audit(
        `error:${code}`,
        err instanceof OpError && err.auditDetail ? { ...input, ...err.auditDetail } : input,
      );
      throw err;
    }
  } catch (err) {
    if (err instanceof OpError) return { ok: false, error: err, ...(op ? { op } : {}) };
    console.error("turntable: unexpected error in operation dispatch", err);
    return { ok: false, error: new OpError("internal", "internal error"), ...(op ? { op } : {}) };
  }
}
