import type { Run } from "../db/repos";

export type ApprovalDecision =
  | { ok: true; approvers: readonly string[] }
  | { ok: false; reason: string };

/**
 * Whether a release run has the approval its environment requires. Two-person signed approvals
 * (#46) implement this; until they exist, the only implementation denies.
 */
export interface ApprovalVerifier {
  verify(run: Run, environment: string): Promise<ApprovalDecision>;
}

/** The default: no approval is ever found, so nothing is signed. */
export const denyAllApprovals: ApprovalVerifier = {
  async verify() {
    return { ok: false, reason: "approval verification is not available" };
  },
};
