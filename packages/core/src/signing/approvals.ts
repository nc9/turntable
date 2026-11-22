// The approval the signing service asks for: has this run, at this commit and workflow, been
// approved for this environment by enough distinct people? The verifier is implemented by the
// human-approvals module (`approvals/verifier.ts`), which re-verifies stored signed statements.
export type {
  ApprovalSubject,
  ApprovalVerdict,
  ApprovalVerifier,
  VerifiedApproval,
} from "../approvals/verifier";
import type { ApprovalVerifier } from "../approvals/verifier";

/** The default: no approval is ever found, so nothing is signed. */
export const denyAllApprovals: ApprovalVerifier = {
  async verify(_subject, environment) {
    return { approved: false, environment, required: 1, have: 0, reason: "insufficient_approvals" };
  },
};
