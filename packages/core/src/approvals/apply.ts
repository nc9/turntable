// Applying a verified, signed statement: checks that it binds this run, records it, and releases
// the run's gated jobs once enough distinct people have approved. Runs inside the op's
// transaction, so a refusal leaves nothing behind.
import { approverIdentity, NO_FORGE_LOGIN, normalizeLogin } from "./identity";
import {
  allowlistHash,
  KeyPolicyError,
  keyPolicyViolation,
  parseKeyPolicy,
  samePolicy,
  sortedPolicy,
  type KeyPolicy,
} from "./key-policy";
import type { Db } from "../db";
import {
  activateEnrolment,
  activeIdentities,
  getKeyPolicy,
  listApprovers,
  listPolicyRecords,
  setKeyPolicy,
  recordIdentities,
  ApprovalConflict,
  consumeChallenge,
  getEnrolment,
  appendAudit,
  effectiveKeyPolicy,
  getEnvPolicy,
  getOrgById,
  getProject,
  appendEvent,
  insertApprover,
  lastApproverRevocation,
  revokeApprover,
  getRun,
  insertRecord,
  listEnrolmentRecords,
  listEnvironmentRecords,
  parseTrust,
  releaseEnvironmentJobs,
  setSignCount,
  waitingEnvironments,
  type ApprovalRecord,
  type Scope,
} from "../db/repos";
import { OpError } from "../ops/errors";
import {
  canonicalStatement,
  keyFingerprint,
  MAX_RUN_STATEMENT_TTL_MS,
  MAX_STATEMENT_TTL_MS,
  POLICY_STATEMENT_TYPE,
  policyDigest,
  statementHash as hashOf,
  type EnrolStatement,
  type RunStatement,
  type EnvStatement,
  type PolicyStatement,
} from "./statement";
import { systemOrgId } from "../audit/failures";
import { parseEd25519PublicKey } from "./keys";
import { dbKeyStore } from "./store";
import { verifySignature, VerifyError, type SignatureMaterial, type Verified } from "./verify";
import type { RelyingParty } from "./webauthn";

type Ctx = { db: Db; scope: Scope; now: number; rp?: RelyingParty | undefined };

async function verified(
  c: Ctx,
  statement: EnvStatement | EnrolStatement | PolicyStatement | RunStatement,
  signature: SignatureMaterial,
): Promise<Verified> {
  const key = await dbKeyStore(c.db, c.scope.orgId).lookup(statement.approver);
  if (!key) throw new OpError("unauthenticated", "signature not accepted");
  try {
    return verifySignature(statement, signature, key, { rp: c.rp, counter: "check" });
  } catch (e) {
    if (e instanceof VerifyError) throw new OpError("unauthenticated", "signature not accepted");
    throw e;
  }
}

/**
 * A signed statement names its tenant. It applies only where it was signed for: the org slug (and
 * the project slug, for an environment statement) must be those of the scope the request resolved
 * to, so a statement valid for one org or project can never be spent in another.
 */
async function checkTenant(c: Ctx, statement: { org: string; project?: string }): Promise<void> {
  const org = await getOrgById(c.db, c.scope.orgId);
  if (!org || org.slug !== statement.org)
    throw new OpError("conflict", "the statement is for another org");
  if (statement.project !== undefined) {
    const project = c.scope.projectId
      ? await getProject(c.db, { orgId: c.scope.orgId }, c.scope.projectId)
      : undefined;
    if (!project || project.slug !== statement.project)
      throw new OpError("conflict", "the statement is for another project");
  }
}

const unknown = (s: string | null | undefined): boolean =>
  s === null || s === undefined || s === "";

/** What authorBlocked reads of a run: its author, its ref and the stored trust decision. */
export type AuthorRun = { actor: string | null; ref: string; trust: string | null };

/**
 * The tag a run was made from, when the poller's tag ingest made it: the stored trust facts name a
 * tag (set by ingest, never by input) AND the ref is that tag's ref. Only such a run has an
 * unknown author by construction; any other run with no author is simply unknown. (The tagger's
 * name is free text the tag's creator chose, so it is not read anywhere as a signal.)
 */
export function ingestedTag(run: AuthorRun): { tag: string } | null {
  if (run.trust === null) return null;
  try {
    const facts = (JSON.parse(run.trust) as { facts?: { tag?: unknown } }).facts;
    const tag = facts?.tag;
    if (typeof tag !== "string" || tag === "" || run.ref !== `refs/tags/${tag}`) return null;
    return { tag };
  } catch {
    return null;
  }
}

/**
 * The run's author may not approve it. This fails closed: when the approver's forge login or the
 * run's author is unknown, it cannot be established that they are different people, so the
 * approval is refused (unless the environment's policy allows author approval).
 *
 * One exception, for a run whose author is unknown BY CONSTRUCTION (one the poller made from a
 * tag): no approver is excluded, whoever tagged, and the environment instead needs one more
 * distinct identity than it normally does (`requiredApprovals`), so at least `required` of them
 * are not the author. Any other run with no author stays unknown.
 */
export function authorBlocked(
  policy: { allowAuthorApproval: boolean; required: number },
  approverForgeLogin: string | null,
  run: AuthorRun,
): "author" | "unknown" | null {
  if (policy.allowAuthorApproval) return null;
  if (unknown(approverForgeLogin)) return "unknown";
  const login = (approverForgeLogin as string).toLowerCase();
  if (!unknown(run.actor)) return login === (run.actor as string).toLowerCase() ? "author" : null;
  return ingestedTag(run) === null ? "unknown" : null;
}

/** True for an ingested tag run with no known author, under a policy that has the author rule on. */
export const authorUnknownByConstruction = (
  policy: { allowAuthorApproval: boolean },
  run: AuthorRun,
): boolean => !policy.allowAuthorApproval && unknown(run.actor) && ingestedTag(run) !== null;

/**
 * How many distinct identities an environment needs for this run: its `required`, plus one when
 * the author is unknown by construction (the author may be one of the approvers and cannot be
 * told apart, so `required` of them must be someone else). The solo policy (`allowAuthorApproval`)
 * keeps `required`.
 */
export const requiredApprovals = (
  policy: { allowAuthorApproval: boolean; required: number },
  run: AuthorRun,
): number => policy.required + (authorUnknownByConstruction(policy, run) ? 1 : 0);

function checkExpiry(expiresAt: number, now: number): void {
  if (expiresAt <= now) throw new OpError("invalid_input", "the statement has expired");
  if (expiresAt > now + MAX_STATEMENT_TTL_MS)
    throw new OpError("invalid_input", "the statement is valid for too long (7 days at most)");
}

/**
 * A human's signed approval of a run held for an untrusted author (#324). Checks, in one
 * transaction with the release that follows, that: the key is an active approver of THIS org that
 * counts and satisfies the org key policy; the signature verifies over exactly this statement;
 * the statement names this org and the run's project, binds this run's sha, workflow and trust
 * class, and is live for at most 10 minutes; and its server-issued nonce is unused (spent here,
 * for webauthn and ed25519 alike). The caller releases the run's jobs afterwards.
 */
export async function verifyRunApproval(
  c: Ctx,
  statement: RunStatement,
  signature: SignatureMaterial,
  run: { id: string; projectId: string; sha: string | null; trust: string | null },
): Promise<{ hash: string; approverId: string; person: string; method: "webauthn" | "ed25519" }> {
  const v = await verified(c, statement, signature);
  const org = await getOrgById(c.db, c.scope.orgId);
  if (!org || org.slug !== statement.org)
    throw new OpError("conflict", "the statement is for another org");
  const project = await getProject(c.db, { orgId: c.scope.orgId }, run.projectId);
  if (!project || project.slug !== statement.project)
    throw new OpError("conflict", "the statement is for another project");
  if (statement.expires_at <= c.now)
    throw new OpError("invalid_input", "the statement has expired");
  if (statement.expires_at > c.now + MAX_RUN_STATEMENT_TTL_MS)
    throw new OpError("invalid_input", "the statement is valid for too long (10 minutes at most)");
  const trust = parseTrust(run);
  if (statement.run_id !== run.id)
    throw new OpError("conflict", "the statement is for another run");
  if (run.sha === null || run.sha.toLowerCase() !== statement.head_sha)
    throw new OpError("conflict", "head_sha is not the sha of this run");
  if (!trust || trust.workflowHash !== statement.workflow_hash)
    throw new OpError("conflict", "workflow_hash is not the hash of this run's workflow");
  if (trust.class !== statement.trust_class)
    throw new OpError("conflict", "the statement is for another trust class");
  if (approverIdentity(v.key) === null)
    throw new OpError("forbidden", `this key does not count: ${NO_FORGE_LOGIN}`);
  const violation = keyPolicyViolation(await getKeyPolicy(c.db, c.scope.orgId), v.key);
  if (violation !== null) throw new OpError("forbidden", `this key cannot approve: ${violation}`);
  // Both methods spend the server-issued challenge: a replayed statement is refused even if its
  // signature still verifies.
  const ok = await consumeChallenge(c.db, c.scope.orgId, {
    id: statement.nonce,
    kind: "approve",
    statementHash: v.hash,
    now: c.now,
  });
  if (!ok) throw new OpError("conflict", "the challenge is unknown, already used or expired");
  if (v.signCount !== null) await setSignCount(c.db, c.scope.orgId, v.key.id, v.signCount);
  await record({ ...c, scope: { ...c.scope, projectId: run.projectId } }, v, signature, {
    kind: "run",
    runId: run.id,
    expiresAt: statement.expires_at,
  });
  return { hash: hashOf(statement), approverId: v.key.id, person: v.key.person, method: v.method };
}

/** Consumes the server-issued nonce (WebAuthn) and advances the authenticator's counter. */
async function consumeProof(
  c: Ctx,
  v: Verified,
  kind: "approve" | "enrol" | "policy",
  nonce: string,
): Promise<void> {
  if (v.method !== "webauthn") return; // an offline statement is single-use by its hash alone
  const ok = await consumeChallenge(c.db, c.scope.orgId, {
    id: nonce,
    kind,
    statementHash: v.hash,
    now: c.now,
  });
  if (!ok) throw new OpError("conflict", "the challenge is unknown, already used or expired");
  if (v.signCount !== null) await setSignCount(c.db, c.scope.orgId, v.key.id, v.signCount);
}

async function record(
  c: Ctx,
  v: Verified,
  signature: SignatureMaterial,
  r: {
    kind: "environment" | "enrol" | "policy" | "run";
    runId?: string;
    environment?: string;
    enrolmentId?: string;
    expiresAt: number;
  },
): Promise<void> {
  try {
    await insertRecord(
      c.db,
      c.scope.orgId,
      {
        ...(c.scope.projectId ? { projectId: c.scope.projectId } : {}),
        ...r,
        statementHash: v.hash,
        statement: canonicalStatement(v.statement),
        method: v.method,
        approverId: v.key.id,
        person: v.key.person,
        signature: JSON.stringify(signature),
      },
      c.now,
    );
  } catch (e) {
    if (e instanceof ApprovalConflict) throw new OpError("conflict", e.message);
    throw e;
  }
}

/** The statements of `records` that still bind (run, sha, workflow, environment) and are live. */
export function liveEnvironmentRecords(
  records: readonly ApprovalRecord[],
  bind: { runId: string; headSha: string; workflowHash: string; environment: string },
  now: number,
): ApprovalRecord[] {
  return records.filter((r) => {
    if (r.expiresAt <= now) return false;
    try {
      const s = JSON.parse(r.statement) as Partial<EnvStatement>;
      return (
        s.run_id === bind.runId &&
        s.head_sha === bind.headSha.toLowerCase() &&
        s.workflow_hash === bind.workflowHash.toLowerCase() &&
        s.environment === bind.environment
      );
    } catch {
      return false;
    }
  });
}

export type EnvironmentApprovalResult = {
  run_id: string;
  environment: string;
  approvals: number;
  required: number;
  released_jobs: number;
  state: string;
};

export async function applyEnvironmentApproval(
  c: Ctx,
  statement: EnvStatement,
  signature: SignatureMaterial,
): Promise<EnvironmentApprovalResult> {
  const v = await verified(c, statement, signature);
  await checkTenant(c, statement);
  checkExpiry(statement.expires_at, c.now);
  const run = await getRun(c.db, c.scope, statement.run_id);
  if (!run) throw new OpError("not_found", "run not found");
  const trust = parseTrust(run);
  if (run.sha === null || run.sha.toLowerCase() !== statement.head_sha)
    throw new OpError("conflict", "head_sha is not the sha of this run");
  if (!trust || trust.workflowHash !== statement.workflow_hash)
    throw new OpError("conflict", "workflow_hash is not the hash of this run's workflow");
  if (!(await waitingEnvironments(c.db, c.scope, run.id)).includes(statement.environment))
    throw new OpError("conflict", "no job of this run waits for approval in that environment");
  const policy = await getEnvPolicy(c.db, c.scope.orgId, statement.environment);
  if (approverIdentity(v.key) === null)
    throw new OpError("forbidden", `this key does not count: ${NO_FORGE_LOGIN}`);
  const keyPolicy = effectiveKeyPolicy(await getKeyPolicy(c.db, c.scope.orgId), policy);
  const violation = keyPolicyViolation(keyPolicy, v.key);
  if (violation !== null) throw new OpError("forbidden", `this key cannot approve: ${violation}`);
  const blocked = authorBlocked(policy, v.key.forgeLogin, run);
  if (blocked === "author") throw new OpError("forbidden", "the author of a run cannot approve it");
  if (blocked === "unknown")
    throw new OpError(
      "forbidden",
      "cannot establish that the approver is not the author of this run (the approver's forge login or the run's author is unknown)",
    );
  await consumeProof(c, v, "approve", statement.nonce);
  await record(c, v, signature, {
    kind: "environment",
    runId: run.id,
    environment: statement.environment,
    expiresAt: statement.expires_at,
  });
  const live = liveEnvironmentRecords(
    await listEnvironmentRecords(c.db, c.scope.orgId, run.id, statement.environment),
    {
      runId: run.id,
      headSha: statement.head_sha,
      workflowHash: statement.workflow_hash,
      environment: statement.environment,
    },
    c.now,
  );
  const people = await recordIdentities(c.db, c.scope.orgId, live, keyPolicy);
  let released = 0;
  let state = run.status as string;
  const needed = requiredApprovals(policy, run);
  if (people.size >= needed && authorUnknownByConstruction(policy, run)) {
    // Said in the audit trail: this release of the jobs did not rest on telling the approvers from
    // the author, but on one more approver than the environment normally needs.
    await appendAudit(c.db, c.scope, {
      principalKind: "approver",
      principalId: v.key.id,
      op: "approval_author_unknown",
      effect: "write",
      outcome: "ok",
      input: {
        run: run.id,
        environment: statement.environment,
        approvers: [...people].toSorted(),
        note: `author unknown; required ${needed} distinct approvers (${policy.required}+1)`,
      },
    });
  }
  if (people.size >= needed) {
    const r = await releaseEnvironmentJobs(c.db, c.scope, run.id, statement.environment);
    released = r.released;
    state = r.state;
  }
  return {
    run_id: run.id,
    environment: statement.environment,
    approvals: people.size,
    required: needed,
    released_jobs: released,
    state,
  };
}

/** Quorum for adding an approver: the production policy's count, capped by who could sign. */
export async function enrolmentQuorum(
  db: Db,
  orgId: string,
  enrolIdentity: string | null,
): Promise<number> {
  const prod = await getEnvPolicy(db, orgId, "production");
  const keyPolicy = await getKeyPolicy(db, orgId);
  const others = (await activeIdentities(db, orgId, keyPolicy)).filter(
    (p) => p !== enrolIdentity,
  ).length;
  return Math.max(1, Math.min(prod.required, others));
}

export type EnrolmentApprovalResult = {
  enrolment_id: string;
  approvals: number;
  required: number;
  activated: boolean;
  approver_id: string | null;
};

export async function applyEnrolmentApproval(
  c: Ctx,
  statement: EnrolStatement,
  signature: SignatureMaterial,
): Promise<EnrolmentApprovalResult> {
  const v = await verified(c, statement, signature);
  await checkTenant(c, statement);
  checkExpiry(statement.expires_at, c.now);
  const e = await getEnrolment(c.db, c.scope.orgId, statement.enrolment_id);
  if (!e || e.activatedAt !== null || e.expiresAt <= c.now)
    throw new OpError("not_found", "no pending enrolment with that id");
  if (
    statement.person !== e.person ||
    normalizeLogin(statement.forge_login) !== normalizeLogin(e.forgeLogin ?? "") ||
    statement.key_fingerprint !==
      keyFingerprint({ kind: e.kind, credentialId: e.credentialId, publicKey: e.publicKey })
  ) {
    throw new OpError("conflict", "the statement is not for this enrolment");
  }
  const signer = approverIdentity(v.key);
  if (signer === null) throw new OpError("forbidden", `this key does not count: ${NO_FORGE_LOGIN}`);
  // The same person by login OR by name: an enrolee must not slip past by naming a new login.
  if (
    signer === approverIdentity(e) ||
    v.key.person.trim().toLowerCase() === e.person.trim().toLowerCase()
  )
    throw new OpError("forbidden", "a person cannot approve enrolling their own key");
  const keyPolicy = await getKeyPolicy(c.db, c.scope.orgId);
  const violation = keyPolicyViolation(keyPolicy, v.key);
  if (violation !== null) throw new OpError("forbidden", `this key cannot approve: ${violation}`);
  await consumeProof(c, v, "enrol", statement.nonce);
  await record(c, v, signature, {
    kind: "enrol",
    enrolmentId: e.id,
    expiresAt: statement.expires_at,
  });
  const people = await recordIdentities(
    c.db,
    c.scope.orgId,
    (await listEnrolmentRecords(c.db, c.scope.orgId, e.id)).filter((r) => r.expiresAt > c.now),
    keyPolicy,
  );
  const required = await enrolmentQuorum(c.db, c.scope.orgId, approverIdentity(e));
  let approverId: string | null = null;
  if (people.size >= required) {
    const a = await activateEnrolment(
      c.db,
      c.scope.orgId,
      e.id,
      `quorum:${[...people].join(",")}`,
      c.now,
    );
    approverId = a?.id ?? null;
  }
  return {
    enrolment_id: e.id,
    approvals: people.size,
    required,
    activated: approverId !== null,
    approver_id: approverId,
  };
}

/**
 * Warnings about how strong the approval setup is. The two-person rule is only as strong as who
 * can enrol approvers: with fewer people enrolled than an environment requires, a single approver
 * enrols further identities alone (the quorum is capped by who could sign), so "two people" can
 * be one person with two keys.
 */
export async function approvalWarnings(
  db: Db,
  orgId: string,
  environments: string[],
): Promise<string[]> {
  const keyPolicy = await getKeyPolicy(db, orgId);
  const people = (await activeIdentities(db, orgId, keyPolicy)).length;
  const out: string[] = [];
  let max = 0;
  for (const environment of environments) {
    max = Math.max(max, (await getEnvPolicy(db, orgId, environment)).required);
  }
  if (people === 0)
    out.push(
      "No approver is enrolled, so no protected job can be approved. Enrol the first one with turntable approvals bootstrap.",
    );
  else if (people < max)
    out.push(
      `Approvals need ${max} distinct people but only ${people} ${people === 1 ? "is" : "are"} enrolled. Until ${max} people are enrolled, a sole approver can enrol more keys alone, so the two-person rule is not yet a guarantee.`,
    );
  return out;
}

/**
 * Enrols the FIRST approver of an org from an offline ed25519 public key (#341). The one
 * implementation behind `turntable approvals bootstrap` (the host's CLI) and the instance
 * administrator's `bootstrap_approver` op. Refused with an ApprovalConflict once the org has any
 * active approver: it never adds to an existing set. With `delayMs`, also refused until that long
 * after the org's last approver revocation, so a stolen instance token cannot revoke every
 * approver and enrol its own key at once; an org that never had an approver has no delay. Callers
 * that need the check and the insert to be atomic run it in a transaction. A key that does not
 * parse throws, and nothing is written. Emits `approver.bootstrapped` to the org's feed (and so
 * to its outbound webhooks).
 */
export async function bootstrapFirstApprover(
  db: Db,
  orgId: string,
  a: { person: string; forgeLogin: string; publicKey: string; createdBy: string },
  now: number,
  opts: { delayMs?: number } = {},
): Promise<{ id: string; person: string; fingerprint: string }> {
  if ((await listApprovers(db, orgId)).length > 0) {
    throw new ApprovalConflict(
      "this org already has approvers. New approvers need a quorum of existing ones: use request_enrolment and approve_enrolment.",
    );
  }
  if (opts.delayMs !== undefined) {
    const revoked = await lastApproverRevocation(db, orgId);
    if (revoked !== null && revoked + opts.delayMs > now) {
      throw new ApprovalConflict(
        `this org's approvers were revoked recently: a first approver can be bootstrapped again after ${new Date(revoked + opts.delayMs).toISOString()}.`,
      );
    }
  }
  const publicKey = parseEd25519PublicKey(a.publicKey);
  const row = await insertApprover(
    db,
    orgId,
    {
      person: a.person,
      forgeLogin: a.forgeLogin,
      kind: "ed25519",
      publicKey,
      alg: "EdDSA",
      createdBy: a.createdBy,
    },
    now,
  );
  const fingerprint = keyFingerprint({ kind: "ed25519", credentialId: null, publicKey });
  await appendEvent(
    db,
    { orgId },
    {
      type: "approver.bootstrapped",
      payload: { approver_id: row.id, person: row.person, key_fingerprint: fingerprint },
    },
  );
  return { id: row.id, person: row.person, fingerprint };
}

/**
 * Revokes one approver key. When that leaves the org with no active approver, it also emits
 * `approvers.depleted` to the org's feed (and so its outbound webhooks) and audits the loss in
 * the org's chain and the system chain: from that moment the org's release gates cannot be
 * satisfied and only a delayed bootstrap restores them. Returns whether a key was revoked.
 */
export async function revokeApproverNotifying(
  db: Db,
  org: { id: string; slug: string },
  approverId: string,
  now: number,
  by: { kind: string; id: string },
): Promise<boolean> {
  const done = await revokeApprover(db, org.id, approverId, now);
  if (!done || (await listApprovers(db, org.id)).length > 0) return done;
  await appendEvent(
    db,
    { orgId: org.id },
    { type: "approvers.depleted", payload: { approver_id: approverId } },
  );
  const entry = {
    principalKind: by.kind,
    principalId: by.id,
    op: "revoke_approver",
    effect: "write" as const,
    outcome: "ok" as const,
    input: { target_org: org.slug, approver_id: approverId, active_approvers: 0 },
  };
  await appendAudit(db, { orgId: org.id }, entry);
  await appendAudit(db, { orgId: await systemOrgId(db) }, entry);
  return done;
}

// ---- key policy changes (#152) ----

/**
 * How many counted identities a policy change must leave. The enrolment quorum is the production
 * count capped by who could sign, so a change that shrinks the counted set would quietly lower it.
 * The change is refused when it would leave fewer counted identities than that pre-change quorum.
 */
export async function policyQuorum(db: Db, orgId: string): Promise<number> {
  const current = await getKeyPolicy(db, orgId);
  const prod = await getEnvPolicy(db, orgId, "production");
  const counted = (await activeIdentities(db, orgId, current)).length;
  return Math.max(1, Math.min(prod.required, counted));
}

async function guardPolicyChange(db: Db, orgId: string, next: KeyPolicy): Promise<void> {
  const need = await policyQuorum(db, orgId);
  const after = (await activeIdentities(db, orgId, next)).length;
  if (after < need)
    throw new KeyPolicyError(
      "conflict",
      `this policy would leave ${after} counted ${after === 1 ? "person" : "people"}, fewer than the ${need} the current quorum needs: enrol keys that satisfy it first, while the current policy is in force`,
    );
}

/** Builds the statement a quorum of approvers signs to change the key policy. */
export async function buildKeyPolicyStatement(
  db: Db,
  orgId: string,
  orgSlug: string,
  input: Parameters<typeof parseKeyPolicy>[0],
  o: { approver: string; expiresAt: number; nonce: string },
): Promise<PolicyStatement> {
  const next = sortedPolicy(parseKeyPolicy(input));
  const cur = await getKeyPolicy(db, orgId);
  const old = sortedPolicy(cur);
  if (samePolicy(old, next))
    throw new KeyPolicyError("invalid_input", "that is already the policy");
  await guardPolicyChange(db, orgId, next);
  return {
    type: POLICY_STATEMENT_TYPE,
    org: orgSlug,
    generation: cur.generation ?? 0,
    old,
    new: next,
    allowlist_hash: allowlistHash(next),
    approver: o.approver,
    expires_at: o.expiresAt,
    nonce: o.nonce,
  };
}

export type KeyPolicyApprovalResult = {
  approvals: number;
  required: number;
  applied: boolean;
  policy: KeyPolicy;
};

/**
 * One approver's signature on a policy change. The change applies when a quorum of the CURRENTLY
 * counted identities has signed the same statement, with the quorum computed before the change.
 */
export async function applyKeyPolicyApproval(
  c: Ctx,
  statement: PolicyStatement,
  signature: SignatureMaterial,
): Promise<KeyPolicyApprovalResult> {
  const v = await verified(c, statement, signature);
  await checkTenant(c, statement);
  checkExpiry(statement.expires_at, c.now);
  const current = await getKeyPolicy(c.db, c.scope.orgId);
  if (approverIdentity(v.key) === null)
    throw new OpError("forbidden", `this key does not count: ${NO_FORGE_LOGIN}`);
  const violation = keyPolicyViolation(current, v.key);
  if (violation !== null) throw new OpError("forbidden", `this key cannot approve: ${violation}`);
  if ((current.generation ?? 0) !== statement.generation || !samePolicy(current, statement.old))
    throw new OpError("conflict", "the policy changed since this statement was issued");
  let next: KeyPolicy;
  try {
    next = sortedPolicy(parseKeyPolicy(statement.new));
  } catch (e) {
    if (e instanceof KeyPolicyError) throw new OpError(e.code, e.message);
    throw e;
  }
  if (!samePolicy(next, statement.new) || allowlistHash(next) !== statement.allowlist_hash)
    throw new OpError("conflict", "the statement's policy or allowlist hash is not consistent");
  const digest = policyDigest(statement);
  await consumeProof(c, v, "policy", statement.nonce);
  await record(c, v, signature, {
    kind: "policy",
    enrolmentId: digest,
    expiresAt: statement.expires_at,
  });
  const recs = (await listPolicyRecords(c.db, c.scope.orgId, digest)).filter(
    (r) => r.expiresAt > c.now,
  );
  const people = await recordIdentities(c.db, c.scope.orgId, recs, current);
  const required = await policyQuorum(c.db, c.scope.orgId);
  if (people.size < required)
    return { approvals: people.size, required, applied: false, policy: current };
  try {
    await guardPolicyChange(c.db, c.scope.orgId, next);
  } catch (e) {
    if (e instanceof KeyPolicyError) throw new OpError(e.code, e.message);
    throw e;
  }
  await setKeyPolicy(c.db, c.scope.orgId, next, `quorum:${[...people].join(",")}`, c.now);
  return { approvals: people.size, required, applied: true, policy: next };
}

/**
 * The one direct way to set the policy: from the server's CLI, and only while the org has no
 * approver at all (the bootstrap, the local trust root). Once anyone is enrolled, a change needs a
 * quorum-signed statement.
 */
export async function setKeyPolicyBootstrap(
  db: Db,
  orgId: string,
  input: Parameters<typeof parseKeyPolicy>[0],
  now: number,
): Promise<KeyPolicy> {
  if ((await listApprovers(db, orgId)).length > 0)
    throw new KeyPolicyError(
      "conflict",
      "this org has approvers: change the key policy with a statement signed by a quorum of them",
    );
  const next = sortedPolicy(parseKeyPolicy(input));
  await setKeyPolicy(db, orgId, next, "cli:bootstrap", now);
  return next;
}
