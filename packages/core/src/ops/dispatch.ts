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
  listMembershipsOfUser,
  type Scope,
  touchApiToken,
  touchInstanceToken,
} from "../db/repos";
import type { DoctorReport } from "../doctor/types";
import type { Op, OpContext } from "./define";
import type { TrustAnchors } from "../approvals/attestation";
import type { RelyingParty } from "../approvals/webauthn";
import type { WebSessions } from "../auth/web-sessions";
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
  /**
   * Web sessions (#430). Set by the REST adapter's owner when sign-in is configured; absent, a
   * session cookie is not a credential anywhere.
   */
  sessions?: WebSessions | undefined;
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
  const any = op.secretInputFields.length > 0 || op.logOmitFields.length > 0;
  if (!any || input === null || typeof input !== "object") return input;
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const f of op.secretInputFields) if (f in out) out[f] = "[redacted]";
  for (const f of op.logOmitFields) if (f in out) out[f] = "[omitted]";
  return out;
}

/**
 * The audited input of a successful call: the redacted input, plus the op's own detail. The
 * redacted input wins: a detail key that collides with an input key is dropped (and named, never
 * its value), so a detail can never un-redact a secret or omitted field.
 */
function auditedInput(op: Op, input: unknown, detail: Record<string, unknown>): object {
  const base = redactInput(op, input);
  const redacted =
    base !== null && typeof base === "object" ? (base as Record<string, unknown>) : {};
  // A detail key that names a secret, omitted or one-time-secret field is dropped even when the
  // input left that (optional) field out: otherwise an omitted optional secret would slip through.
  const guarded = new Set([
    ...op.secretInputFields,
    ...op.logOmitFields,
    ...op.oneTimeSecretFields,
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (k in redacted || guarded.has(k)) {
      console.warn(
        `turntable: op ${op.name} auditDetail key "${k}" collides with an input or secret field; dropped`,
      );
      continue;
    }
    out[k] = v;
  }
  return { ...out, ...redacted };
}

/** A short stable digest of an unrecognised token, so repeats of it share a throttle bucket. */
const unknownTokenSource = (c: Credential): string =>
  c.kind === "bearer"
    ? hashToken(c.token).slice(0, 12)
    : c.kind === "session"
      ? hashToken(c.cookie).slice(0, 12)
      : "none";

/**
 * The writes a web session may make, until passkey step-up lands. Everything else that is not a
 * read (minting tokens, approvers and enrolment, loosening settings, approvals, ...) is refused
 * for a session by default, so a new op is closed to sessions until someone opens it here.
 */
export const SESSION_WRITE_OPS: ReadonlySet<string> = new Set(["invite_member"]);

/** Step 1: turns a credential into a principal, or throws `unauthenticated`. */
export async function authenticate(
  env: DispatchEnv,
  credential: Credential,
  /** The `org` the call names, which picks the org a session acts in. */
  orgHint?: unknown,
): Promise<Principal> {
  if (credential.kind === "principal") return credential.principal;
  if (credential.kind === "session") return authenticateSession(env, credential.cookie, orgHint);
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
 * A session cookie. The principal is a `member` whose role is the one Turntable's own membership
 * row gives in the org the call names, never anything GitHub says. A person in several orgs must
 * name one; a non-member gets the same error as an org that does not exist.
 */
async function authenticateSession(
  env: DispatchEnv,
  cookie: string,
  org: unknown,
): Promise<Principal> {
  const live = await env.sessions?.resolve(cookie);
  if (!live) throw new AuthFailure();
  if (org !== undefined && typeof org !== "string") {
    throw new OpError("invalid_input", "org must be a string");
  }
  const memberships = await listMembershipsOfUser(env.db, live.userId);
  const pick =
    org === undefined
      ? memberships.length === 1
        ? memberships[0]
        : undefined
      : memberships.find((m) => m.slug === org);
  if (!pick) {
    if (org === undefined && memberships.length > 1) {
      throw new OpError("invalid_input", "org is required: this account belongs to several orgs");
    }
    throw new OpError("not_found", NO_SUCH_SCOPE);
  }
  return { kind: "member", id: live.userId, orgId: pick.orgId, role: pick.role, session: true };
}

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
        principal = await authenticate(
          env,
          credential,
          rawInput !== null && typeof rawInput === "object"
            ? (rawInput as Record<string, unknown>).org
            : undefined,
        );
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
    // A web session is default-deny for writes: only the named ones, whatever the member's role.
    // It is judged before the scope (a project-scoped op with no project would fail there first);
    // a member principal is bound to one org, so the refusal is audited in that org's chain.
    if (credential.kind === "session" && op.effect !== "read" && !SESSION_WRITE_OPS.has(op.name)) {
      await appendAudit(
        env.db,
        { orgId: principal.orgId },
        {
          principalKind: principal.kind,
          principalId: principal.id,
          op: op.name,
          effect: op.effect,
          outcome: "error:forbidden",
          input: redactInput(op, raw),
        },
      ).catch(() => {});
      throw new OpError(
        "forbidden",
        `${op.name} needs a passkey step-up, which a web session cannot give yet: use a token`,
      );
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
            input: auditedInput(target, input, detail),
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
            input: auditedInput(target, input, target.auditDetail?.(out) ?? {}),
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
