// Human approvals (#46): enrolled approver keys, per-environment policy, single-use challenges,
// pending enrolments and the signed records. Part of the only code allowed to name tenant tables.
import { DEFAULT_KEY_POLICY, keyPolicyViolation, type KeyPolicy } from "../../approvals/key-policy";
import { approverIdentity } from "../../approvals/identity";
import { and, asc, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "..";
import { isUniqueViolation } from "../errors";
import { aggregateRunStatus } from "../job-state";
import * as s from "../schema";
import { ulid } from "../ulid";
import { listAttempts, listJobs, setRunStatus, transitionJob, updateAttempt } from "./index";
import { effectiveStates } from "./readiness";
import { type Scope } from "./scope";

export type Approver = typeof s.approvers.$inferSelect;
export type ApprovalRecord = typeof s.approvalRecords.$inferSelect;
export type Enrolment = typeof s.approverEnrolments.$inferSelect;

export class ApprovalConflict extends Error {}

// ---- policy ----

/** Environments that always need approval and default to two people. */
export const PROTECTED_ENVIRONMENTS: readonly string[] = ["production", "release"];

export type EnvPolicy = {
  environment: string;
  required: number;
  allowAuthorApproval: boolean;
  /** `configured` is a stored row; `default` is the built-in rule. */
  source: "configured" | "default";
  /** Whether a job in this environment waits for human approval at all. */
  gated: boolean;
};

export function getEnvPolicy(db: Db, orgId: string, environment: string): Promise<EnvPolicy> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.approvalPolicies)
      .where(
        and(eq(s.approvalPolicies.orgId, orgId), eq(s.approvalPolicies.environment, environment)),
      )
      .limit(1);
    if (row) {
      return {
        environment,
        required: row.required,
        allowAuthorApproval: row.allowAuthorApproval === 1,
        source: "configured" as const,
        gated: true,
      };
    }
    const prot = PROTECTED_ENVIRONMENTS.includes(environment);
    return {
      environment,
      required: prot ? 2 : 1,
      allowAuthorApproval: false,
      source: "default" as const,
      gated: prot,
    };
  });
}

export function setEnvPolicy(
  db: Db,
  orgId: string,
  o: {
    environment: string;
    required: number;
    allowAuthorApproval: boolean;
    by: string;
    now: number;
  },
): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .insert(s.approvalPolicies)
      .values({
        orgId,
        environment: o.environment,
        required: o.required,
        allowAuthorApproval: o.allowAuthorApproval ? 1 : 0,
        updatedBy: o.by,
        updatedAt: o.now,
      })
      .onConflictDoUpdate({
        target: [s.approvalPolicies.orgId, s.approvalPolicies.environment],
        set: {
          required: o.required,
          allowAuthorApproval: o.allowAuthorApproval ? 1 : 0,
          updatedBy: o.by,
          updatedAt: o.now,
        },
      });
  });
}

export function listEnvPolicies(db: Db, orgId: string) {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.approvalPolicies)
      .where(eq(s.approvalPolicies.orgId, orgId))
      .orderBy(asc(s.approvalPolicies.environment)),
  );
}

// ---- key policy (#152) ----

export async function getKeyPolicy(db: Db, orgId: string): Promise<KeyPolicy> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.approvalKeyPolicies)
      .where(eq(s.approvalKeyPolicies.orgId, orgId))
      .limit(1);
    if (!row) return DEFAULT_KEY_POLICY;
    return {
      generation: row.generation,
      mode: row.policy === "hardware" ? "hardware" : "any",
      presets: JSON.parse(row.presets) as string[],
      aaguids: JSON.parse(row.aaguids) as string[],
    };
  });
}

export function setKeyPolicy(
  db: Db,
  orgId: string,
  p: KeyPolicy,
  by: string,
  now: number,
): Promise<void> {
  return db.run(async (h) => {
    const [cur] = await h.orm
      .select({ g: s.approvalKeyPolicies.generation })
      .from(s.approvalKeyPolicies)
      .where(eq(s.approvalKeyPolicies.orgId, orgId))
      .limit(1);
    const row = {
      orgId,
      generation: (cur?.g ?? 0) + 1,
      policy: p.mode,
      presets: JSON.stringify(p.presets),
      aaguids: JSON.stringify(p.aaguids),
      updatedBy: by,
      updatedAt: now,
    };
    await h.orm
      .insert(s.approvalKeyPolicies)
      .values(row)
      .onConflictDoUpdate({ target: s.approvalKeyPolicies.orgId, set: row });
  });
}

// ---- approvers ----

export function listApprovers(db: Db, orgId: string, o: { includeRevoked?: boolean } = {}) {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.approvers)
      .where(
        and(
          eq(s.approvers.orgId, orgId),
          o.includeRevoked ? undefined : isNull(s.approvers.revokedAt),
        ),
      )
      .orderBy(asc(s.approvers.person), asc(s.approvers.id)),
  );
}

export function getApprover(db: Db, orgId: string, id: string): Promise<Approver | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.approvers)
      .where(and(eq(s.approvers.orgId, orgId), eq(s.approvers.id, id)))
      .limit(1);
    return row;
  });
}

/**
 * One forge login is one identity. Refuse a login an active approver already holds under a
 * different person label: a second key for the same human is fine (same label, counts once), a
 * second "person" for one login is the two-person rule being gamed.
 */
type Handle = Parameters<Parameters<Db["run"]>[0]>[0];

async function assertIdentityFree(
  h: Handle,
  orgId: string,
  a: { person: string; forgeLogin?: string | null | undefined },
): Promise<void> {
  const id = approverIdentity(a);
  if (id === null) return;
  const rows = await h.orm
    .select()
    .from(s.approvers)
    .where(and(eq(s.approvers.orgId, orgId), isNull(s.approvers.revokedAt)));
  const held = rows.find(
    (r) =>
      approverIdentity(r) === id && r.person.trim().toLowerCase() !== a.person.trim().toLowerCase(),
  );
  if (held)
    throw new ApprovalConflict(
      "that forge login already belongs to an enrolled approver under a different person",
    );
  // And the other way round: a person label an active approver holds under another login. Taking
  // a new login under the same name would make the enrolee look like someone else to the check
  // that a person cannot approve their own key.
  const same = rows.find(
    (r) =>
      r.person.trim().toLowerCase() === a.person.trim().toLowerCase() &&
      approverIdentity(r) !== null &&
      approverIdentity(r) !== id,
  );
  if (same)
    throw new ApprovalConflict(
      "an enrolled approver already has that name under a different forge login",
    );
}

export type NewApprover = {
  aaguid?: string | null | undefined;
  attested?: boolean | undefined;
  person: string;
  forgeLogin?: string | null | undefined;
  kind: s.ApproverKind;
  credentialId?: string | null | undefined;
  publicKey: string;
  alg: string;
  signCount?: number | undefined;
  createdBy: string;
};

export function insertApprover(
  db: Db,
  orgId: string,
  a: NewApprover,
  now: number,
): Promise<Approver> {
  return db.run(async (h) => {
    await assertIdentityFree(h, orgId, a);
    const row = {
      id: ulid(),
      orgId,
      person: a.person,
      forgeLogin: a.forgeLogin ?? null,
      kind: a.kind,
      credentialId: a.credentialId ?? null,
      publicKey: a.publicKey,
      alg: a.alg,
      signCount: a.signCount ?? 0,
      aaguid: a.aaguid ?? null,
      attested: a.attested ?? false,
      createdBy: a.createdBy,
      createdAt: now,
      revokedAt: null,
    };
    try {
      await h.orm.insert(s.approvers).values(row);
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApprovalConflict("that key is already enrolled");
      throw e;
    }
    return row;
  });
}

/** When the org's most recent approver revocation happened, or null if none was ever revoked. */
export function lastApproverRevocation(db: Db, orgId: string): Promise<number | null> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select({ at: sql<number | null>`max(${s.approvers.revokedAt})` })
      .from(s.approvers)
      .where(eq(s.approvers.orgId, orgId));
    return row?.at == null ? null : Number(row.at);
  });
}

export function revokeApprover(db: Db, orgId: string, id: string, now: number): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.approvers)
      .set({ revokedAt: now })
      .where(
        and(eq(s.approvers.orgId, orgId), eq(s.approvers.id, id), isNull(s.approvers.revokedAt)),
      )
      .returning({ id: s.approvers.id });
    return rows.length > 0;
  });
}

export function setSignCount(db: Db, orgId: string, id: string, count: number): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .update(s.approvers)
      .set({ signCount: count })
      .where(and(eq(s.approvers.orgId, orgId), eq(s.approvers.id, id)));
  });
}

/**
 * Distinct identities (verified forge logins) holding at least one active key. A key without a
 * forge login has no identity and is left out. With a key policy, only keys that satisfy it
 * count: a person whose keys all fail it cannot sign.
 */
export async function activeIdentities(
  db: Db,
  orgId: string,
  policy?: KeyPolicy,
): Promise<string[]> {
  const rows = await listApprovers(db, orgId);
  return [
    ...new Set(
      rows
        .filter((r) => !policy || keyPolicyViolation(policy, r) === null)
        .flatMap((r) => approverIdentity(r) ?? []),
    ),
  ];
}

/**
 * The identities behind a set of records, by the approver key that signed. A record whose key is
 * revoked, has no forge login, no longer satisfies the key policy, or is gone, counts for nothing.
 */
export async function recordIdentities(
  db: Db,
  orgId: string,
  records: { approverId: string }[],
  policy?: KeyPolicy,
): Promise<Set<string>> {
  const out = new Set<string>();
  const cache = new Map<string, string | null>();
  for (const r of records) {
    let id = cache.get(r.approverId);
    if (id === undefined) {
      const a = await getApprover(db, orgId, r.approverId);
      // A revoked key stops counting, as it stops verifying (`verifySignature`) and stops being
      // active (`activeIdentities`); so does a key that no longer satisfies the key policy.
      id =
        a && a.revokedAt === null && !(policy && keyPolicyViolation(policy, a) !== null)
          ? approverIdentity(a)
          : null;
      cache.set(r.approverId, id);
    }
    if (id !== null) out.add(id);
  }
  return out;
}

// ---- challenges ----

export function insertChallenge(
  db: Db,
  orgId: string,
  c: {
    id: string;
    kind: "approve" | "enrol" | "register" | "policy";
    statementHash: string;
    principal: string;
    expiresAt: number;
  },
): Promise<void> {
  return db.run(async (h) => {
    await h.orm.insert(s.approvalChallenges).values({ orgId, ...c });
  });
}

/** Marks a challenge used if it is unused, unexpired, of this kind and for this statement. */
export function consumeChallenge(
  db: Db,
  orgId: string,
  c: { id: string; kind: string; statementHash: string; now: number },
): Promise<boolean> {
  return db.run(async (h) => {
    const rows = await h.orm
      .update(s.approvalChallenges)
      .set({ usedAt: c.now })
      .where(
        and(
          eq(s.approvalChallenges.orgId, orgId),
          eq(s.approvalChallenges.id, c.id),
          eq(s.approvalChallenges.kind, c.kind),
          eq(s.approvalChallenges.statementHash, c.statementHash),
          isNull(s.approvalChallenges.usedAt),
          gt(s.approvalChallenges.expiresAt, c.now),
        ),
      )
      .returning({ id: s.approvalChallenges.id });
    return rows.length > 0;
  });
}

/** Drops challenge rows that have expired, so the table cannot grow without bound. */
export function purgeExpiredChallenges(db: Db, orgId: string, now: number): Promise<void> {
  return db.run(async (h) => {
    await h.orm
      .delete(s.approvalChallenges)
      .where(and(eq(s.approvalChallenges.orgId, orgId), lte(s.approvalChallenges.expiresAt, now)));
  });
}

/** Open (unused, unexpired) challenges one principal holds. */
export function countOpenChallenges(
  db: Db,
  orgId: string,
  principal: string,
  now: number,
): Promise<number> {
  return db.run(async (h) => {
    const rows = await h.orm
      .select({ id: s.approvalChallenges.id })
      .from(s.approvalChallenges)
      .where(
        and(
          eq(s.approvalChallenges.orgId, orgId),
          eq(s.approvalChallenges.principal, principal),
          isNull(s.approvalChallenges.usedAt),
          gt(s.approvalChallenges.expiresAt, now),
        ),
      )
      .limit(1000);
    return rows.length;
  });
}

// ---- enrolments ----

export function insertEnrolment(
  db: Db,
  orgId: string,
  e: Omit<NewApprover, "createdBy"> & { requestedBy: string; expiresAt: number },
  now: number,
): Promise<Enrolment> {
  return db.run(async (h) => {
    await assertIdentityFree(h, orgId, e);
    const row = {
      id: ulid(),
      orgId,
      person: e.person,
      forgeLogin: e.forgeLogin ?? null,
      kind: e.kind,
      credentialId: e.credentialId ?? null,
      publicKey: e.publicKey,
      alg: e.alg,
      signCount: e.signCount ?? 0,
      aaguid: e.aaguid ?? null,
      attested: e.attested ?? false,
      requestedBy: e.requestedBy,
      createdAt: now,
      expiresAt: e.expiresAt,
      activatedAt: null,
    };
    await h.orm.insert(s.approverEnrolments).values(row);
    return row;
  });
}

export function getEnrolment(db: Db, orgId: string, id: string): Promise<Enrolment | undefined> {
  return db.run(async (h) => {
    const [row] = await h.orm
      .select()
      .from(s.approverEnrolments)
      .where(and(eq(s.approverEnrolments.orgId, orgId), eq(s.approverEnrolments.id, id)))
      .limit(1);
    return row;
  });
}

export function listPendingEnrolments(db: Db, orgId: string, now: number) {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.approverEnrolments)
      .where(
        and(
          eq(s.approverEnrolments.orgId, orgId),
          isNull(s.approverEnrolments.activatedAt),
          gt(s.approverEnrolments.expiresAt, now),
        ),
      )
      .orderBy(desc(s.approverEnrolments.createdAt)),
  );
}

/** Turns a pending enrolment into an approver, once. Returns the approver, or undefined if done. */
export function activateEnrolment(
  db: Db,
  orgId: string,
  id: string,
  by: string,
  now: number,
): Promise<Approver | undefined> {
  return db.transaction(async (tx) => {
    const e = await getEnrolment(tx, orgId, id);
    if (!e || e.activatedAt !== null || e.expiresAt <= now) return undefined;
    const approver = await insertApprover(
      tx,
      orgId,
      {
        person: e.person,
        forgeLogin: e.forgeLogin,
        kind: e.kind as s.ApproverKind,
        credentialId: e.credentialId,
        publicKey: e.publicKey,
        alg: e.alg,
        signCount: e.signCount,
        aaguid: e.aaguid,
        attested: e.attested,
        createdBy: by,
      },
      now,
    );
    await tx.run(async (h) => {
      await h.orm
        .update(s.approverEnrolments)
        .set({ activatedAt: now })
        .where(and(eq(s.approverEnrolments.orgId, orgId), eq(s.approverEnrolments.id, id)));
    });
    return approver;
  });
}

// ---- records ----

export type NewRecord = {
  projectId?: string | undefined;
  kind: "environment" | "enrol" | "policy";
  runId?: string | undefined;
  environment?: string | undefined;
  enrolmentId?: string | undefined;
  statementHash: string;
  statement: string;
  method: string;
  approverId: string;
  person: string;
  signature: string;
  expiresAt: number;
};

export function insertRecord(db: Db, orgId: string, r: NewRecord, now: number): Promise<void> {
  return db.run(async (h) => {
    try {
      await h.orm.insert(s.approvalRecords).values({
        id: ulid(),
        orgId,
        projectId: r.projectId ?? null,
        kind: r.kind,
        runId: r.runId ?? null,
        environment: r.environment ?? null,
        enrolmentId: r.enrolmentId ?? null,
        statementHash: r.statementHash,
        statement: r.statement,
        method: r.method,
        approverId: r.approverId,
        person: r.person,
        signature: r.signature,
        createdAt: now,
        expiresAt: r.expiresAt,
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApprovalConflict("this statement was already submitted");
      throw e;
    }
  });
}

export function listEnvironmentRecords(
  db: Db,
  orgId: string,
  runId: string,
  environment?: string,
): Promise<ApprovalRecord[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.approvalRecords)
      .where(
        and(
          eq(s.approvalRecords.orgId, orgId),
          eq(s.approvalRecords.kind, "environment"),
          eq(s.approvalRecords.runId, runId),
          environment === undefined ? undefined : eq(s.approvalRecords.environment, environment),
        ),
      )
      .orderBy(asc(s.approvalRecords.createdAt)),
  );
}

/** The signed records for one key policy proposal (they share its digest in `enrolment_id`). */
export function listPolicyRecords(
  db: Db,
  orgId: string,
  digest: string,
): Promise<ApprovalRecord[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.approvalRecords)
      .where(
        and(
          eq(s.approvalRecords.orgId, orgId),
          eq(s.approvalRecords.kind, "policy"),
          eq(s.approvalRecords.enrolmentId, digest),
        ),
      )
      .orderBy(asc(s.approvalRecords.createdAt)),
  );
}

export function listEnrolmentRecords(
  db: Db,
  orgId: string,
  enrolmentId: string,
): Promise<ApprovalRecord[]> {
  return db.run((h) =>
    h.orm
      .select()
      .from(s.approvalRecords)
      .where(
        and(
          eq(s.approvalRecords.orgId, orgId),
          eq(s.approvalRecords.kind, "enrol"),
          eq(s.approvalRecords.enrolmentId, enrolmentId),
        ),
      )
      .orderBy(asc(s.approvalRecords.createdAt)),
  );
}

// ---- gated jobs ----

/** The environment a job's plan names, if any. */
export function plannedEnvironment(planned: unknown): string | undefined {
  const p = typeof planned === "string" ? safeParse(planned) : planned;
  const e = (p as { environment?: unknown } | null | undefined)?.environment;
  return typeof e === "string" && e !== "" ? e : undefined;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Environments with at least one job of the run waiting on a human. */
export async function waitingEnvironments(db: Db, scope: Scope, runId: string): Promise<string[]> {
  const jobs = await listJobs(db, scope, runId);
  const names = jobs
    .filter((j) => j.state === "awaiting_approval" && j.approvalKind === "environment")
    .map((j) => plannedEnvironment(j.planned))
    .filter((n): n is string => n !== undefined);
  return [...new Set(names)].toSorted();
}

/** Releases the run's jobs that wait on `environment`. Returns how many were released. */
export function releaseEnvironmentJobs(
  db: Db,
  scope: Scope,
  runId: string,
  environment: string,
): Promise<{ released: number; state: string }> {
  return db.transaction(async (tx) => {
    const jobs = (await listJobs(tx, scope, runId)).filter(
      (j) =>
        j.state === "awaiting_approval" &&
        j.approvalKind === "environment" &&
        plannedEnvironment(j.planned) === environment,
    );
    for (const job of jobs) {
      await transitionJob(tx, scope, job.id, "queued");
      const waiting = (await listAttempts(tx, scope, job.id)).findLast(
        (a) => a.state === "awaiting_approval",
      );
      if (waiting) await updateAttempt(tx, scope, waiting.id, { state: "queued" });
    }
    const all = await listJobs(tx, scope, runId);
    const state = aggregateRunStatus(effectiveStates(all));
    if (jobs.length > 0) await setRunStatus(tx, scope, runId, state);
    return { released: jobs.length, state };
  });
}
