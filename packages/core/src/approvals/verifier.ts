// The interface the signing service (#44) and the release lane call before they act: has this
// run, at this commit and workflow, been approved for this environment by enough distinct
// people? It never trusts a stored "approved" flag. Each stored statement is checked again: it
// must bind exactly this subject, be unexpired, and its signature must verify against the
// approver key (the org's enrolled keys, or the caller's own key store).
import { approverIdentity } from "./identity";
import type { Db } from "../db";
import { getEnvPolicy, getRun, listEnvironmentRecords, parseTrust } from "../db/repos";
import { authorBlocked, liveEnvironmentRecords } from "./apply";
import { dbKeyStore } from "./store";
import { statementHash, envStatementSchema } from "./statement";
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
};

export type VerifiedApproval = {
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
        | "sha_mismatch";
    };

export interface ApprovalVerifier {
  verify(
    subject: ApprovalSubject,
    environment: string,
    o?: { now?: number; keys?: ApproverKeyStore; rp?: RelyingParty },
  ): Promise<ApprovalVerdict>;
}

export function createApprovalVerifier(
  db: Db,
  defaults: { rp?: RelyingParty } = {},
): ApprovalVerifier {
  return {
    async verify(subject, environment, o = {}) {
      const now = o.now ?? Date.now();
      const rp = o.rp ?? defaults.rp;
      const scope = { orgId: subject.orgId, projectId: subject.projectId };
      const policy = await getEnvPolicy(db, subject.orgId, environment);
      const denied = (
        reason: Extract<ApprovalVerdict, { approved: false }>["reason"],
        have = 0,
      ): ApprovalVerdict => ({
        approved: false,
        environment,
        required: policy.required,
        have,
        reason,
      });
      const run = await getRun(db, scope, subject.runId);
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
      const live = liveEnvironmentRecords(all, bind, now);
      const keys = o.keys ?? dbKeyStore(db, subject.orgId);
      const good: VerifiedApproval[] = [];
      let selfApproved = false;
      for (const r of live) {
        let parsed;
        let sig;
        try {
          parsed = envStatementSchema.parse(JSON.parse(r.statement));
          sig = signatureSchema.parse(JSON.parse(r.signature));
        } catch {
          continue;
        }
        const key = await keys.lookup(r.approverId);
        if (!key) continue;
        try {
          const v = verifySignature(parsed, sig, key, { rp, counter: "ignore" });
          if (v.hash !== statementHash(parsed) || v.hash !== r.statementHash) continue;
        } catch {
          continue;
        }
        // A key with no forge login is tied to no person and counts for nothing.
        const identity = approverIdentity(key);
        if (identity === null) continue;
        if (authorBlocked(policy, key.forgeLogin, run.actor) !== null) {
          selfApproved = true;
          continue;
        }
        good.push({
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
      if (distinct.size >= policy.required)
        return {
          approved: true,
          environment,
          required: policy.required,
          approvals: [...distinct.values()],
        };
      if (selfApproved && distinct.size < policy.required)
        return denied("self_approval", distinct.size);
      if (all.length > 0 && all.every((r) => r.expiresAt <= now)) return denied("expired", 0);
      return denied("insufficient_approvals", distinct.size);
    },
  };
}
