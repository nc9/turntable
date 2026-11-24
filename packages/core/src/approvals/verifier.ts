// The interface the signing service (#44) and the release lane call before they act: has this
// run, at this commit and workflow, been approved for this environment by enough distinct
// people? It never trusts a stored "approved" flag. Each stored statement is checked again: it
// must bind exactly this subject, be unexpired, and its signature must verify against the
// approver key (the org's enrolled keys, or the caller's own key store).
import { approverIdentity } from "./identity";
import { keyPolicyViolation } from "./key-policy";
import type { Db } from "../db";
import {
  effectiveKeyPolicy,
  getEnvPolicy,
  getKeyPolicy,
  getRun,
  listEnvironmentRecords,
  parseTrust,
  spendApprovalRecords,
} from "../db/repos";
import { authorBlocked, liveEnvironmentRecords, requiredApprovals } from "./apply";
import { dbKeyStore } from "./store";
import { statementHash, envStatementSchema, releaseStatementSchema } from "./statement";
import { signatureSchema, verifySignature, type ApproverKeyStore } from "./verify";
import type { RelyingParty } from "./webauthn";

export type ApprovalSubject = {
  orgId: string;
  projectId: string;
  runId: string;
  /** The commit the artifact was built from. */
  headSha: string;
  /** Hex sha256 of the workflow, as in the run's trust decision. */
  workflowHash: string;
  /**
   * The release manifest digest the approval must name (#424, see release/manifest.ts). When set,
   * only unspent `turntable.approve_release.v2` approvals of exactly this digest count, and a
   * `turntable.approve_environment.v1` approval counts for nothing. Set it for every signature.
   */
  manifestSha256?: string;
};

export type VerifiedApproval = {
  /** The stored record, so a signature can spend exactly the approvals it rests on. */
  recordId?: string;
  approverId: string;
  person: string;
  /** The verified forge login the approval counts under (see identity.ts). */
  identity: string;
  method: "webauthn" | "ed25519";
  statementHash: string;
  approvedAt: number;
  expiresAt: number;
};

export type ApprovalVerdict =
  | { approved: true; environment: string; required: number; approvals: VerifiedApproval[] }
  | {
      approved: false;
      environment: string;
      required: number;
      have: number;
      reason:
        | "insufficient_approvals"
        | "expired"
        | "self_approval"
        | "run_not_found"
        | "sha_mismatch"
        /** Approvals exist for this run and environment, but for another artifact set. */
        | "manifest_mismatch"
        /** An approval of exactly this manifest exists, and a signature already spent it. */
        | "approval_spent";
    };

export interface ApprovalVerifier {
  verify(
    subject: ApprovalSubject,
    environment: string,
    o?: { now?: number; keys?: ApproverKeyStore; rp?: RelyingParty },
  ): Promise<ApprovalVerdict>;
  /**
   * Spends the approvals a verdict rests on, atomically (all or none): false when any was already
   * spent. A verifier whose approvals are not single-use may omit it.
   */
  spend?(
    subject: ApprovalSubject,
    approvals: readonly VerifiedApproval[],
    o?: { now?: number },
  ): Promise<boolean>;
}

/**
 * What the signing service takes: a verifier whose approvals are single-use, so `spend` is
 * required and a wiring without it does not compile. The optional form above stays for callers
 * that only read a verdict (nothing to spend), such as the approve and challenge ops.
 */
export interface ReleaseApprovalVerifier extends ApprovalVerifier {
  spend(
    subject: ApprovalSubject,
    approvals: readonly VerifiedApproval[],
    o?: { now?: number },
  ): Promise<boolean>;
}

export function createApprovalVerifier(
  db: Db,
  defaults: { rp?: RelyingParty } = {},
): ReleaseApprovalVerifier {
  return {
    async spend(subject, approvals, o = {}) {
      const ids = approvals.flatMap((a) => (a.recordId ? [a.recordId] : []));
      if (ids.length !== approvals.length) return false;
      return spendApprovalRecords(db, subject.orgId, ids, o.now ?? Date.now());
    },
    async verify(subject, environment, o = {}) {
      const now = o.now ?? Date.now();
      const rp = o.rp ?? defaults.rp;
      const scope = { orgId: subject.orgId, projectId: subject.projectId };
      const policy = await getEnvPolicy(db, subject.orgId, environment);
      const keyPolicy = effectiveKeyPolicy(await getKeyPolicy(db, subject.orgId), policy);
      const run = await getRun(db, scope, subject.runId);
      // A run made from a tag has an author nobody can name: one more approver than usual.
      const required = run ? requiredApprovals(policy, run) : policy.required;
      const denied = (
        reason: Extract<ApprovalVerdict, { approved: false }>["reason"],
        have = 0,
      ): ApprovalVerdict => ({
        approved: false,
        environment,
        required,
        have,
        reason,
      });
      if (!run) return denied("run_not_found");
      const trust = parseTrust(run);
      if (
        run.sha === null ||
        run.sha.toLowerCase() !== subject.headSha.toLowerCase() ||
        !trust ||
        trust.workflowHash !== subject.workflowHash.toLowerCase()
      ) {
        return denied("sha_mismatch");
      }
      const all = await listEnvironmentRecords(db, subject.orgId, run.id, environment);
      const bind = {
        runId: run.id,
        headSha: subject.headSha,
        workflowHash: subject.workflowHash,
        environment,
      };
      const manifest = subject.manifestSha256;
      const live = liveEnvironmentRecords(
        all,
        manifest === undefined ? bind : { ...bind, manifest },
        now,
      );
      const keys = o.keys ?? dbKeyStore(db, subject.orgId);
      const good: VerifiedApproval[] = [];
      let selfApproved = false;
      for (const r of live) {
        let parsed;
        let sig;
        try {
          parsed =
            manifest === undefined
              ? envStatementSchema.parse(JSON.parse(r.statement))
              : releaseStatementSchema.parse(JSON.parse(r.statement));
          sig = signatureSchema.parse(JSON.parse(r.signature));
        } catch {
          continue;
        }
        const key = await keys.lookup(r.approverId);
        if (!key) continue;
        // A key that no longer satisfies the org's key policy stops counting, however it signed.
        if (keyPolicyViolation(keyPolicy, key) !== null) continue;
        try {
          const v = verifySignature(parsed, sig, key, { rp, counter: "ignore" });
          if (v.hash !== statementHash(parsed) || v.hash !== r.statementHash) continue;
        } catch {
          continue;
        }
        // A key with no forge login is tied to no person and counts for nothing.
        const identity = approverIdentity(key);
        if (identity === null) continue;
        if (authorBlocked(policy, key.forgeLogin, run) !== null) {
          selfApproved = true;
          continue;
        }
        good.push({
          recordId: r.id,
          approverId: key.id,
          person: key.person,
          identity,
          method: sig.kind,
          statementHash: r.statementHash,
          approvedAt: r.createdAt,
          expiresAt: r.expiresAt,
        });
      }
      const distinct = new Map<string, VerifiedApproval>();
      for (const a of good) if (!distinct.has(a.identity)) distinct.set(a.identity, a);
      if (distinct.size >= required)
        return {
          approved: true,
          environment,
          required,
          approvals: [...distinct.values()],
        };
      if (selfApproved && distinct.size < required) return denied("self_approval", distinct.size);
      if (manifest !== undefined) {
        // Say WHY a release approval does not count, when it is one of these (not an expiry).
        const ofRun = liveEnvironmentRecords(all, { ...bind }, now).filter((r) => {
          try {
            return releaseStatementSchema.safeParse(JSON.parse(r.statement)).success;
          } catch {
            return false;
          }
        });
        const same = ofRun.filter((r) => {
          try {
            return (
              (JSON.parse(r.statement) as { manifest_sha256?: string }).manifest_sha256 ===
              manifest.toLowerCase()
            );
          } catch {
            return false;
          }
        });
        if (same.length > 0 && same.every((r) => r.spentAt !== null))
          return denied("approval_spent", 0);
        if (ofRun.length > 0 && same.length === 0) return denied("manifest_mismatch", 0);
      }
      if (all.length > 0 && all.every((r) => r.expiresAt <= now)) return denied("expired", 0);
      return denied("insufficient_approvals", distinct.size);
    },
  };
}
