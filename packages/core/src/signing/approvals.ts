// The approval the signing service asks for. The shape is the one #46 (human-only approvals)
// implements: it re-verifies stored signed statements itself and answers with a verdict. These
// types mirror its `approvals/verifier.ts` and are replaced by an import of it when it merges.

export type ApprovalSubject = {
  orgId: string;
  projectId: string;
  runId: string;
  /** The sha the artifact was built from. */
  headSha: string;
  /** Hex sha256 of the workflow, as in the run's trust decision. */
  workflowHash: string;
};

export type VerifiedApproval = {
  approverId: string;
  person: string;
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
  verify(subject: ApprovalSubject, environment: string): Promise<ApprovalVerdict>;
}

/** The default: no approval is ever found, so nothing is signed. */
export const denyAllApprovals: ApprovalVerifier = {
  async verify(_subject, environment) {
    return { approved: false, environment, required: 1, have: 0, reason: "insufficient_approvals" };
  },
};
