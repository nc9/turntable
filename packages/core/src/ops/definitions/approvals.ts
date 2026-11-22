import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  approvalWarnings,
  applyEnrolmentApproval,
  applyEnvironmentApproval,
  applyKeyPolicyApproval,
  buildKeyPolicyStatement,
  enrolmentQuorum,
  liveEnvironmentRecords,
} from "../../approvals/apply";
import {
  challengeOf,
  CHALLENGE_TTL_MS,
  canonicalStatement,
  ENROL_STATEMENT_TYPE,
  ENV_STATEMENT_TYPE,
  enrolStatementSchema,
  policyStatementSchema,
  envStatementSchema,
  keyFingerprint,
  MAX_STATEMENT_TTL_MS,
  statementHash,
} from "../../approvals/statement";
import { approverIdentity, normalizeLogin, notCountingReason } from "../../approvals/identity";
import { KeyPolicyError, keyPolicyViolation } from "../../approvals/key-policy";
import { parseEd25519PublicKey } from "../../approvals/keys";
import { dbKeyStore } from "../../approvals/store";
import { signatureSchema, verifySignature, VerifyError } from "../../approvals/verify";
import { verifyRegistration, WebAuthnError } from "../../approvals/webauthn";
import {
  ApprovalConflict,
  consumeChallenge,
  countOpenChallenges,
  purgeExpiredChallenges,
  recordIdentities,
  getApprover,
  getEnrolment,
  getEnvPolicy,
  getKeyPolicy,
  getOrgById,
  getProject,
  getRun,
  insertChallenge,
  insertEnrolment,
  listApprovers,
  listEnrolmentRecords,
  listEnvironmentRecords,
  listEnvPolicies,
  listPendingEnrolments,
  parseTrust,
  waitingEnvironments,
  PROTECTED_ENVIRONMENTS,
} from "../../db/repos";
import { APPROVER_KINDS } from "../../db/schema";
import { iso } from "../common";
import { defineOp, type OpContext } from "../define";
import { OpError } from "../errors";
import { principalLabel } from "../principal";

const nonce = () => randomBytes(24).toString("base64url");
const MAX_OPEN_CHALLENGES = 50;
const DEFAULT_APPROVAL_TTL_MS = 24 * 3600_000;
const ENROLMENT_TTL_MS = 7 * 24 * 3600_000;

const rp = (ctx: OpContext) => {
  if (!ctx.webauthn)
    throw new OpError(
      "unavailable",
      "WebAuthn is not configured: set LONGSHORE_PUBLIC_URL (or LONGSHORE_WEBAUTHN_RP_ID and LONGSHORE_WEBAUTHN_ORIGINS)",
    );
  return ctx.webauthn;
};

async function slugs(ctx: OpContext): Promise<{ org: string; project: string }> {
  const org = await getOrgById(ctx.db, ctx.scope.orgId);
  const project = ctx.scope.projectId
    ? await getProject(ctx.db, { orgId: ctx.scope.orgId }, ctx.scope.projectId)
    : undefined;
  if (!org || !project) throw new OpError("invalid_input", "project is required");
  return { org: org.slug, project: project.slug };
}

const signedInput = {
  statement: envStatementSchema,
  signature: signatureSchema,
};

// ---- reading ----

export const approvalStatus = defineOp({
  name: "approval_status",
  summary: "Which environments of a run wait for approval, and who has approved so far.",
  description:
    "For one run: the sha and workflow hash an approval must bind, and for each environment with " +
    "a job waiting on a human, how many distinct people are required (the environment's policy: " +
    "2 for production and release by default, 1 otherwise) and who has approved with a valid, " +
    "unexpired statement. Names are people's labels. Read-only. The author of a run cannot " +
    "approve it unless the policy allows.",
  input: z.object({ run_id: z.string().min(1).max(64) }),
  output: z.object({
    run_id: z.string(),
    head_sha: z.string().nullable(),
    workflow_hash: z.string().nullable(),
    author: z.string().nullable().describe("Forge login of the run's author. Untrusted text."),
    environments: z.array(
      z.object({
        environment: z.string(),
        required: z.int(),
        allow_author_approval: z.boolean(),
        waiting: z.boolean(),
        approvals: z.array(
          z.object({
            person: z.string(),
            method: z.enum(APPROVER_KINDS),
            approved_at: z.string(),
            expires_at: z.string(),
          }),
        ),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/approvals/status" },
  async handler(ctx, input) {
    const run = await getRun(ctx.db, ctx.scope, input.run_id);
    if (!run) throw new OpError("not_found", "run not found");
    const trust = parseTrust(run);
    const waiting = await waitingEnvironments(ctx.db, ctx.scope, run.id);
    const records = await listEnvironmentRecords(ctx.db, ctx.scope.orgId, run.id);
    const names = [...new Set([...waiting, ...records.map((r) => r.environment!)])].toSorted();
    const now = ctx.now();
    const environments = [];
    for (const environment of names) {
      const policy = await getEnvPolicy(ctx.db, ctx.scope.orgId, environment);
      const live =
        run.sha && trust
          ? liveEnvironmentRecords(
              records.filter((r) => r.environment === environment),
              { runId: run.id, headSha: run.sha, workflowHash: trust.workflowHash, environment },
              now,
            )
          : [];
      environments.push({
        environment,
        required: policy.required,
        allow_author_approval: policy.allowAuthorApproval,
        waiting: waiting.includes(environment),
        approvals: live.map((r) => ({
          person: r.person,
          method: r.method as "webauthn" | "ed25519",
          approved_at: iso(r.createdAt)!,
          expires_at: iso(r.expiresAt)!,
        })),
      });
    }
    return {
      run_id: run.id,
      head_sha: run.sha,
      workflow_hash: trust?.workflowHash ?? null,
      author: run.actor,
      environments,
    };
  },
});

const keyPolicyOutput = z.object({
  mode: z.enum(["any", "hardware"]),
  presets: z.array(z.string()),
  aaguids: z.array(z.string()),
});

export const approversOverview = defineOp({
  name: "approvers_overview",
  summary: "Enrolled approvers, pending enrolments and the per-environment approval policies.",
  description:
    "Who can approve in this org: each enrolled key (person label, kind, credential id for a " +
    "passkey), the enrolments waiting for a quorum of existing approvers, and the environment " +
    "policies (how many distinct people each environment needs). Public keys and credential ids " +
    "are not secret. Read-only.",
  input: z.object({}),
  output: z.object({
    approvers: z.array(
      z.object({
        id: z.string(),
        person: z.string(),
        forge_login: z.string().nullable(),
        kind: z.enum(APPROVER_KINDS),
        passkey_id: z.string().nullable(),
        created_at: z.string(),
        not_counting: z
          .string()
          .nullable()
          .describe(
            "Why this key counts toward no approval or quorum (no forge login, or it does not satisfy the key policy); null when it does.",
          ),
        attested: z.boolean().describe("A pinned vendor attestation chain verified at enrolment."),
        aaguid: z.string().nullable(),
      }),
    ),
    key_policy: keyPolicyOutput,
    pending_enrolments: z.array(
      z.object({
        id: z.string(),
        person: z.string(),
        forge_login: z.string().nullable(),
        kind: z.enum(APPROVER_KINDS),
        key_fingerprint: z.string(),
        approvals: z.int(),
        required: z.int(),
        expires_at: z.string(),
      }),
    ),
    policies: z.array(
      z.object({
        environment: z.string(),
        required: z.int(),
        allow_author_approval: z.boolean(),
        source: z.enum(["configured", "default"]),
      }),
    ),
    warnings: z
      .array(z.string())
      .describe("Ways the approval setup is weaker than it looks, such as too few approvers."),
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/approvers" },
  async handler(ctx) {
    const orgId = ctx.scope.orgId;
    const now = ctx.now();
    const approvers = await listApprovers(ctx.db, orgId);
    const keyPolicy = await getKeyPolicy(ctx.db, orgId);
    const pending = [];
    for (const e of await listPendingEnrolments(ctx.db, orgId, now)) {
      const recs = (await listEnrolmentRecords(ctx.db, orgId, e.id)).filter(
        (r) => r.expiresAt > now,
      );
      pending.push({
        id: e.id,
        person: e.person,
        forge_login: e.forgeLogin,
        kind: e.kind as "webauthn" | "ed25519",
        key_fingerprint: keyFingerprint(e),
        approvals: (await recordIdentities(ctx.db, orgId, recs, keyPolicy)).size,
        required: await enrolmentQuorum(ctx.db, orgId, approverIdentity(e)),
        expires_at: iso(e.expiresAt)!,
      });
    }
    const configured = await listEnvPolicies(ctx.db, orgId);
    const names = new Set([...PROTECTED_ENVIRONMENTS, ...configured.map((p) => p.environment)]);
    const policies = [];
    for (const environment of [...names].toSorted()) {
      const p = await getEnvPolicy(ctx.db, orgId, environment);
      policies.push({
        environment,
        required: p.required,
        allow_author_approval: p.allowAuthorApproval,
        source: p.source,
      });
    }
    return {
      approvers: approvers.map((a) => ({
        id: a.id,
        person: a.person,
        forge_login: a.forgeLogin,
        kind: a.kind as "webauthn" | "ed25519",
        passkey_id: a.credentialId,
        created_at: iso(a.createdAt)!,
        not_counting: notCountingReason(a) ?? keyPolicyViolation(keyPolicy, a),
        attested: a.attested,
        aaguid: a.aaguid,
      })),
      key_policy: keyPolicy,
      pending_enrolments: pending,
      policies,
      warnings: await approvalWarnings(ctx.db, orgId, [...names]),
    };
  },
});

// ---- challenges (REST, UI and CLI only: an agent never builds a statement to sign) ----

const challengeOutput = z.object({
  statement: z.record(z.string(), z.unknown()),
  canonical: z.string().describe("The exact text an offline ed25519 key signs."),
  statement_hash: z.string(),
  challenge: z.string().describe("base64url of the statement hash: the WebAuthn challenge."),
  rp_id: z.string().nullable(),
  passkey_id: z.string().nullable().describe("The approver's passkey id (WebAuthn credential id)."),
  challenge_expires_at: z.string(),
});

async function openChallenge(
  ctx: OpContext,
  kind: "approve" | "enrol" | "policy",
  statement: { nonce: string },
  hash: string,
  approverId: string,
) {
  const approver = await getApprover(ctx.db, ctx.scope.orgId, approverId);
  if (!approver || approver.revokedAt !== null) throw new OpError("not_found", "no such approver");
  await storeChallenge(ctx, kind, statement.nonce, hash);
  return approver;
}

/**
 * Stores a challenge under a cap on what one principal may hold open, so one token cannot fill
 * the table or crowd out another caller's challenges. Expired rows are purged on the way.
 */
async function storeChallenge(
  ctx: OpContext,
  kind: "approve" | "enrol" | "register" | "policy",
  id: string,
  hash: string,
): Promise<void> {
  const now = ctx.now();
  const principal = principalLabel(ctx.principal);
  await purgeExpiredChallenges(ctx.db, ctx.scope.orgId, now);
  if ((await countOpenChallenges(ctx.db, ctx.scope.orgId, principal, now)) >= MAX_OPEN_CHALLENGES)
    throw new OpError("conflict", "too many open challenges: wait for some to expire");
  await insertChallenge(ctx.db, ctx.scope.orgId, {
    id,
    kind,
    statementHash: hash,
    principal,
    expiresAt: now + CHALLENGE_TTL_MS,
  });
}

export const approvalChallenge = defineOp({
  name: "approval_challenge",
  summary: "Issue the statement an approver signs to approve a run in an environment.",
  description:
    "Builds the approval statement for a run waiting on an environment and the single-use " +
    "challenge for it. A passkey signs `challenge` in the browser (WebAuthn); an offline ed25519 " +
    "key signs `canonical`. The statement binds the org, project, run, head sha, workflow hash, " +
    "environment, the approver's key id, an expiry and a nonce: change any of them and the " +
    "signature is void. Issuing a statement approves nothing. Not available over MCP: an agent " +
    "may relay a statement a human already signed, never create one for signing.",
  input: z.object({
    run_id: z.string().min(1).max(64),
    environment: z.string().min(1).max(100),
    approver: z.string().min(1).max(64).describe("The approver key id that will sign."),
    ttl_minutes: z
      .int()
      .min(5)
      .max(MAX_STATEMENT_TTL_MS / 60_000)
      .default(DEFAULT_APPROVAL_TTL_MS / 60_000)
      .describe("How long the approval stays valid once signed."),
  }),
  output: challengeOutput,
  effect: "write",
  auth: { type: "token", minRole: "operator" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "POST", path: "/approvals/challenge" },
  mcp: false,
  async handler(ctx, input) {
    const now = ctx.now();
    const run = await getRun(ctx.db, ctx.scope, input.run_id);
    if (!run) throw new OpError("not_found", "run not found");
    const trust = parseTrust(run);
    if (run.sha === null || !trust)
      throw new OpError("conflict", "the run has no recorded sha or workflow hash to approve");
    if (!(await waitingEnvironments(ctx.db, ctx.scope, run.id)).includes(input.environment))
      throw new OpError("conflict", "no job of this run waits for approval in that environment");
    const { org, project } = await slugs(ctx);
    const statement = envStatementSchema.parse({
      type: ENV_STATEMENT_TYPE,
      org,
      project,
      run_id: run.id,
      head_sha: run.sha.toLowerCase(),
      workflow_hash: trust.workflowHash,
      environment: input.environment,
      approver: input.approver,
      expires_at: now + input.ttl_minutes * 60_000,
      nonce: nonce(),
    });
    const hash = statementHash(statement);
    const approver = await openChallenge(ctx, "approve", statement, hash, input.approver);
    return {
      statement,
      canonical: canonicalStatement(statement),
      statement_hash: hash,
      challenge: challengeOf(statement),
      rp_id: ctx.webauthn?.rpId ?? null,
      passkey_id: approver.credentialId,
      challenge_expires_at: iso(now + CHALLENGE_TTL_MS)!,
    };
  },
});

export const enrolmentChallenge = defineOp({
  name: "enrolment_challenge",
  summary: "Issue the statement an approver signs to approve enrolling a new key.",
  description:
    "For a pending enrolment (see approvers_overview): builds the statement an existing approver " +
    "signs to approve it, with its single-use challenge. Enrolling a key needs a quorum of " +
    "distinct existing approvers (the production policy's count, capped by how many people " +
    "could sign). A person cannot approve their own new key. Not available over MCP.",
  input: z.object({
    enrolment_id: z.string().min(1).max(64),
    approver: z.string().min(1).max(64),
  }),
  output: challengeOutput,
  effect: "write",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/approvers/challenge" },
  mcp: false,
  async handler(ctx, input) {
    const now = ctx.now();
    const e = await getEnrolment(ctx.db, ctx.scope.orgId, input.enrolment_id);
    if (!e || e.activatedAt !== null || e.expiresAt <= now)
      throw new OpError("not_found", "no pending enrolment with that id");
    const org = await getOrgById(ctx.db, ctx.scope.orgId);
    const statement = enrolStatementSchema.parse({
      type: ENROL_STATEMENT_TYPE,
      org: org!.slug,
      enrolment_id: e.id,
      person: e.person,
      forge_login: e.forgeLogin === null ? "" : normalizeLogin(e.forgeLogin),
      key_fingerprint: keyFingerprint(e),
      approver: input.approver,
      expires_at: Math.min(e.expiresAt, now + DEFAULT_APPROVAL_TTL_MS),
      nonce: nonce(),
    });
    const hash = statementHash(statement);
    const approver = await openChallenge(ctx, "enrol", statement, hash, input.approver);
    return {
      statement,
      canonical: canonicalStatement(statement),
      statement_hash: hash,
      challenge: challengeOf(statement),
      rp_id: ctx.webauthn?.rpId ?? null,
      passkey_id: approver.credentialId,
      challenge_expires_at: iso(now + CHALLENGE_TTL_MS)!,
    };
  },
});

// ---- key policy (#152) ----

export const keyPolicyChallenge = defineOp({
  name: "key_policy_challenge",
  summary: "Issue the statement an approver signs to change the key policy.",
  description:
    "Builds the policy-change statement (the policy being replaced, the new one, the hash of the " +
    "allowlist it expands to, an expiry and a nonce) and the single-use challenge for one " +
    "approver to sign. The change applies when a quorum of the currently counted approvers has " +
    "signed it with approve_key_policy. Refused when the change would leave fewer counted people " +
    "than the current quorum needs. Needs release_operator. Not available over MCP.",
  input: z.object({
    mode: z.enum(["any", "hardware"]),
    presets: z.array(z.string().max(40)).max(10).optional(),
    aaguids: z.array(z.string().max(40)).max(200).optional(),
    approver: z.string().min(1).max(64),
  }),
  output: challengeOutput,
  effect: "write",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/approvers/key-policy/challenge" },
  mcp: false,
  async handler(ctx, input) {
    const now = ctx.now();
    const org = await getOrgById(ctx.db, ctx.scope.orgId);
    let statement;
    try {
      statement = policyStatementSchema.parse(
        await buildKeyPolicyStatement(ctx.db, ctx.scope.orgId, org!.slug, input, {
          approver: input.approver,
          expiresAt: now + DEFAULT_APPROVAL_TTL_MS,
          nonce: nonce(),
        }),
      );
    } catch (e) {
      if (e instanceof KeyPolicyError) throw new OpError(e.code, e.message);
      throw e;
    }
    const hash = statementHash(statement);
    const approver = await openChallenge(ctx, "policy", statement, hash, input.approver);
    return {
      statement,
      canonical: canonicalStatement(statement),
      statement_hash: hash,
      challenge: challengeOf(statement),
      rp_id: ctx.webauthn?.rpId ?? null,
      passkey_id: approver.credentialId,
      challenge_expires_at: iso(now + CHALLENGE_TTL_MS)!,
    };
  },
});

export const approveKeyPolicy = defineOp({
  name: "approve_key_policy",
  summary: "Approve a key policy change with a signed statement. Human only.",
  description:
    "Records one approver's signed policy-change statement. A policy change is a change of what " +
    "counts as an approval, so it needs the same quorum as enrolling a key: when enough distinct " +
    "people among the currently counted approvers have signed the same statement (the production " +
    "policy's count, capped by how many could sign, computed before the change), the policy " +
    "changes. Takes no bearer token: the signature is the credential.",
  input: z.object({ statement: policyStatementSchema, signature: signatureSchema }),
  output: z.object({
    approvals: z.int(),
    required: z.int(),
    applied: z.boolean(),
    policy: keyPolicyOutput,
  }),
  effect: "write",
  auth: { type: "signature", minRole: "viewer" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/approvers/key-policy" },
  async handler(ctx, input) {
    return applyKeyPolicyApproval(
      { db: ctx.db, scope: ctx.scope, now: ctx.now(), rp: ctx.webauthn },
      input.statement,
      input.signature,
    );
  },
});

// ---- enrolment ----

export const registerChallenge = defineOp({
  name: "register_challenge",
  summary: "Issue a challenge for registering a new passkey as an approver key.",
  description:
    "Returns a single-use challenge for `navigator.credentials.create`. Registering only creates " +
    "a pending enrolment (request_enrolment); it becomes an approver when a quorum of existing " +
    "approvers signs it. Needs release_operator. Not available over MCP.",
  input: z.object({}),
  output: z.object({
    challenge: z.string(),
    rp_id: z.string(),
    expires_at: z.string(),
    attestation: z
      .enum(["none", "direct"])
      .describe(
        "The attestation conveyance to request in navigator.credentials.create: direct under the hardware key policy.",
      ),
  }),
  effect: "write",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/approvers/register-challenge" },
  mcp: false,
  async handler(ctx) {
    const rpv = rp(ctx);
    const now = ctx.now();
    const id = nonce();
    await storeChallenge(ctx, "register", id, "");
    const kp = await getKeyPolicy(ctx.db, ctx.scope.orgId);
    return {
      challenge: id,
      rp_id: rpv.rpId,
      expires_at: iso(now + CHALLENGE_TTL_MS)!,
      attestation: kp.mode === "hardware" ? ("direct" as const) : ("none" as const),
    };
  },
});

export const requestEnrolment = defineOp({
  name: "request_enrolment",
  summary: "Ask to enrol a passkey or an ed25519 public key as an approver, pending a quorum.",
  description:
    "Creates a pending enrolment for a person's key: a WebAuthn registration made with the " +
    "challenge from register_challenge (attestation none, or direct and verified against pinned " +
    "vendor roots under the hardware key policy), or an ed25519 public key (refused under the " +
    "hardware policy). Nothing is " +
    "enrolled until a quorum of existing approvers signs it. Refused while no approver exists: " +
    "the first approver is enrolled from the server's CLI (the local trust root). Needs " +
    "release_operator. Not available over MCP.",
  input: z.object({
    person: z.string().trim().min(1).max(200).describe("A name for the human who holds the key."),
    forge_login: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe(
        "Their forge login. Required: an approval is refused when it cannot be shown that the approver is not the run's author.",
      ),
    ed25519_public_key: z.string().max(4096).optional(),
    webauthn: z
      .strictObject({
        challenge: z.string().min(16).max(128),
        client_data_json: z.string().max(8192),
        attestation_object: z.string().max(16384),
      })
      .optional(),
  }),
  output: z.object({
    enrolment_id: z.string(),
    kind: z.enum(APPROVER_KINDS),
    key_fingerprint: z.string(),
    required: z.int(),
    expires_at: z.string(),
  }),
  effect: "write",
  auth: { type: "token", minRole: "release_operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/approvers/enrolments" },
  mcp: false,
  async handler(ctx, input) {
    if ((input.ed25519_public_key === undefined) === (input.webauthn === undefined))
      throw new OpError("invalid_input", "give exactly one of ed25519_public_key or webauthn");
    const orgId = ctx.scope.orgId;
    const now = ctx.now();
    if ((await listApprovers(ctx.db, orgId)).length === 0) {
      throw new OpError(
        "conflict",
        "no approver is enrolled yet: the first approver is enrolled from the server CLI (longshore approvals bootstrap)",
      );
    }
    const keyPolicy = await getKeyPolicy(ctx.db, orgId);
    let key: {
      kind: "webauthn" | "ed25519";
      credentialId: string | null;
      publicKey: string;
      alg: string;
      signCount: number;
      aaguid: string | null;
      attested: boolean;
    };
    if (input.ed25519_public_key !== undefined) {
      if (keyPolicy.mode === "hardware")
        throw new OpError(
          "invalid_input",
          "this org's key policy is hardware: an offline ed25519 key cannot be enrolled",
        );
      try {
        key = {
          kind: "ed25519",
          credentialId: null,
          publicKey: parseEd25519PublicKey(input.ed25519_public_key),
          alg: "EdDSA",
          signCount: 0,
          aaguid: null,
          attested: false,
        };
      } catch {
        throw new OpError("invalid_input", "ed25519_public_key is not a valid ed25519 public key");
      }
    } else {
      const w = input.webauthn!;
      const ok = await consumeChallenge(ctx.db, orgId, {
        id: w.challenge,
        kind: "register",
        statementHash: "",
        now,
      });
      if (!ok) throw new OpError("conflict", "the challenge is unknown, already used or expired");
      try {
        const r = verifyRegistration(
          { clientDataJSON: w.client_data_json, attestationObject: w.attestation_object },
          {
            challenge: w.challenge,
            rp: rp(ctx),
            ...(ctx.attestationAnchors ? { anchors: ctx.attestationAnchors } : {}),
            now,
          },
        );
        key = {
          kind: "webauthn",
          credentialId: r.credentialId,
          publicKey: r.publicKey,
          alg: r.alg,
          signCount: r.signCount,
          aaguid: r.attestation.verified ? r.attestation.aaguid : null,
          attested: r.attestation.verified,
        };
        const violation = keyPolicyViolation(keyPolicy, key);
        if (violation !== null)
          throw new OpError(
            "invalid_input",
            `registration refused by the key policy: ${violation}`,
          );
      } catch (e) {
        if (e instanceof WebAuthnError)
          throw new OpError("invalid_input", `registration refused: ${e.message}`);
        throw e;
      }
    }
    try {
      const e = await insertEnrolment(
        ctx.db,
        orgId,
        {
          person: input.person,
          forgeLogin: input.forge_login,
          ...key,
          requestedBy: principalLabel(ctx.principal),
          expiresAt: now + ENROLMENT_TTL_MS,
        },
        now,
      );
      return {
        enrolment_id: e.id,
        kind: key.kind,
        key_fingerprint: keyFingerprint(key),
        required: await enrolmentQuorum(ctx.db, orgId, approverIdentity(e)),
        expires_at: iso(e.expiresAt)!,
      };
    } catch (e) {
      if (e instanceof ApprovalConflict) throw new OpError("conflict", e.message);
      throw e;
    }
  },
});

// ---- approving ----

const environmentOutput = z.object({
  run_id: z.string(),
  environment: z.string(),
  approvals: z
    .int()
    .describe("Distinct approvers (by verified forge login) with a valid approval now."),
  required: z.int(),
  released_jobs: z.int(),
  state: z.string(),
});

export const approveEnvironment = defineOp({
  name: "approve_environment",
  // Signature op: a human-signed statement is the credential, never a token.
  mcp: false,
  summary: "Approve a run for an environment with a signed statement. Human only.",
  description:
    "Records one approver's signed statement for a run waiting on an environment. The statement " +
    "binds the run's head sha, workflow hash and the environment; the signature is a WebAuthn " +
    "assertion over its hash or an offline ed25519 signature over its canonical text. When " +
    "enough distinct people have approved (2 for production and release by default) the gated " +
    "jobs are released. The run's author cannot approve it unless the policy allows. This " +
    "operation takes no bearer token: the signature is the credential, so no token, session or " +
    "agent can approve by itself.",
  input: z.object(signedInput),
  output: environmentOutput,
  effect: "write",
  auth: { type: "signature", minRole: "viewer" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "POST", path: "/approvals" },
  async handler(ctx, input) {
    return applyEnvironmentApproval(
      { db: ctx.db, scope: ctx.scope, now: ctx.now(), rp: ctx.webauthn },
      input.statement,
      input.signature,
    );
  },
});

export const submitApproval = defineOp({
  name: "submit_approval",
  summary: "Upload an approval statement a human already signed.",
  description:
    "Relays a statement that an enrolled approver signed elsewhere (a passkey in a browser, or an " +
    "offline key) to the server, for an agent or script that holds only a token. It cannot " +
    "create or alter a statement: the signature must verify over exactly the statement given, " +
    "so a token without a human's signature approves nothing. Same checks and effect as " +
    "approve_environment.",
  input: z.object(signedInput),
  output: environmentOutput,
  effect: "write",
  auth: { type: "token", minRole: "operator" },
  untrustedOutput: false,
  scope: "project",
  http: { method: "POST", path: "/approvals/relay" },
  async handler(ctx, input) {
    // The same verification as the signature op: the token only carries the bytes.
    const s = input.statement;
    const key = await dbKeyStore(ctx.db, ctx.scope.orgId).lookup(s.approver);
    try {
      if (!key) throw new VerifyError("unauthenticated", "unknown approver");
      verifySignature(s, input.signature, key, { rp: ctx.webauthn, counter: "check" });
    } catch (e) {
      if (e instanceof VerifyError) throw new OpError("unauthenticated", "signature not accepted");
      throw e;
    }
    const org = await getOrgById(ctx.db, ctx.scope.orgId);
    const project = await getProject(ctx.db, { orgId: ctx.scope.orgId }, ctx.scope.projectId!);
    if (s.org !== org?.slug || s.project !== project?.slug)
      throw new OpError("forbidden", "the statement is for another org or project");
    return applyEnvironmentApproval(
      { db: ctx.db, scope: ctx.scope, now: ctx.now(), rp: ctx.webauthn },
      input.statement,
      input.signature,
    );
  },
});

export const approveEnrolment = defineOp({
  name: "approve_enrolment",
  // Signature op: a human-signed statement is the credential, never a token.
  mcp: false,
  summary: "Approve enrolling a new approver key with a signed statement. Human only.",
  description:
    "Records one existing approver's signed statement approving a pending enrolment. When a " +
    "quorum of distinct existing people has signed (the production policy's count, capped by " +
    "how many could sign), the key becomes an approver. A person cannot approve their own " +
    "new key. Takes no bearer token: the signature is the credential.",
  input: z.object({ statement: enrolStatementSchema, signature: signatureSchema }),
  output: z.object({
    enrolment_id: z.string(),
    approvals: z.int(),
    required: z.int(),
    activated: z.boolean(),
    approver_id: z.string().nullable(),
  }),
  effect: "write",
  auth: { type: "signature", minRole: "viewer" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/approvers/approve" },
  async handler(ctx, input) {
    return applyEnrolmentApproval(
      { db: ctx.db, scope: ctx.scope, now: ctx.now(), rp: ctx.webauthn },
      input.statement,
      input.signature,
    );
  },
});
