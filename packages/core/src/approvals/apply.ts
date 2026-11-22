// Applying a verified, signed statement: checks that it binds this run, records it, and releases
// the run's gated jobs once enough distinct people have approved. Runs inside the op's
// transaction, so a refusal leaves nothing behind.
import type { Db } from "../db";
import {
  activateEnrolment,
  activePeople,
  ApprovalConflict,
  consumeChallenge,
  getEnrolment,
  getEnvPolicy,
  getOrgById,
  getProject,
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
  MAX_STATEMENT_TTL_MS,
  type EnrolStatement,
  type EnvStatement,
} from "./statement";
import { dbKeyStore } from "./store";
import { verifySignature, VerifyError, type SignatureMaterial, type Verified } from "./verify";
import type { RelyingParty } from "./webauthn";

type Ctx = { db: Db; scope: Scope; now: number; rp?: RelyingParty | undefined };

async function verified(
  c: Ctx,
  statement: EnvStatement | EnrolStatement,
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

/**
 * The run's author may not approve it. This fails closed: when the approver's forge login or the
 * run's author is unknown, it cannot be established that they are different people, so the
 * approval is refused (unless the environment's policy allows author approval).
 */
export function authorBlocked(
  policy: { allowAuthorApproval: boolean },
  approverForgeLogin: string | null,
  runActor: string | null,
): "author" | "unknown" | null {
  if (policy.allowAuthorApproval) return null;
  if (
    approverForgeLogin === null ||
    approverForgeLogin === "" ||
    runActor === null ||
    runActor === ""
  )
    return "unknown";
  return approverForgeLogin.toLowerCase() === runActor.toLowerCase() ? "author" : null;
}

function checkExpiry(expiresAt: number, now: number): void {
  if (expiresAt <= now) throw new OpError("invalid_input", "the statement has expired");
  if (expiresAt > now + MAX_STATEMENT_TTL_MS)
    throw new OpError("invalid_input", "the statement is valid for too long (7 days at most)");
}

/** Consumes the server-issued nonce (WebAuthn) and advances the authenticator's counter. */
async function consumeProof(
  c: Ctx,
  v: Verified,
  kind: "approve" | "enrol",
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
    kind: "environment" | "enrol";
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
  const blocked = authorBlocked(policy, v.key.forgeLogin, run.actor);
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
  const people = new Set(live.map((r) => r.person));
  let released = 0;
  let state = run.status as string;
  if (people.size >= policy.required) {
    const r = await releaseEnvironmentJobs(c.db, c.scope, run.id, statement.environment);
    released = r.released;
    state = r.state;
  }
  return {
    run_id: run.id,
    environment: statement.environment,
    approvals: people.size,
    required: policy.required,
    released_jobs: released,
    state,
  };
}

/** Quorum for adding an approver: the production policy's count, capped by who could sign. */
export async function enrolmentQuorum(db: Db, orgId: string, enrolPerson: string): Promise<number> {
  const prod = await getEnvPolicy(db, orgId, "production");
  const others = (await activePeople(db, orgId)).filter((p) => p !== enrolPerson).length;
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
    statement.key_fingerprint !==
      keyFingerprint({ kind: e.kind, credentialId: e.credentialId, publicKey: e.publicKey })
  ) {
    throw new OpError("conflict", "the statement is not for this enrolment");
  }
  if (v.key.person === e.person)
    throw new OpError("forbidden", "a person cannot approve enrolling their own key");
  await consumeProof(c, v, "enrol", statement.nonce);
  await record(c, v, signature, {
    kind: "enrol",
    enrolmentId: e.id,
    expiresAt: statement.expires_at,
  });
  const people = new Set(
    (await listEnrolmentRecords(c.db, c.scope.orgId, e.id))
      .filter((r) => r.expiresAt > c.now)
      .map((r) => r.person),
  );
  const required = await enrolmentQuorum(c.db, c.scope.orgId, e.person);
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
  const people = (await activePeople(db, orgId)).length;
  const out: string[] = [];
  let max = 0;
  for (const environment of environments) {
    max = Math.max(max, (await getEnvPolicy(db, orgId, environment)).required);
  }
  if (people === 0)
    out.push(
      "No approver is enrolled, so no protected job can be approved. Enrol the first one with longshore approvals bootstrap.",
    );
  else if (people < max)
    out.push(
      `Approvals need ${max} distinct people but only ${people} ${people === 1 ? "is" : "are"} enrolled. Until ${max} people are enrolled, a sole approver can enrol more keys alone, so the two-person rule is not yet a guarantee.`,
    );
  return out;
}
