// Presentation helpers for the approval policy editor (#664). The server owns every rule (who,
// lock, step-up, quorum); this only decides when to ask for the passkey up front and carries the
// server's refusal text through unchanged.
import { ApiError } from "@/api/http-adapter";
import type { ApprovalPolicy, ApprovalPolicyEnv, StepUpProof } from "@/api/types";

export type PolicyDraft = {
  environment: string;
  required: number;
  allowAuthorApproval: boolean;
  keyPolicy: "any" | "hardware";
};

/** Whether `next` weakens what `cur` enforces: fewer approvers, the author allowed, any key. */
export function loosensPolicy(cur: ApprovalPolicyEnv, next: PolicyDraft): boolean {
  return (
    next.required < cur.required ||
    (next.allowAuthorApproval && !cur.allowAuthorApproval) ||
    (cur.keyPolicy === "hardware" && next.keyPolicy === "any")
  );
}

/** The exact input a step-up is bound to, as the op takes it. */
export const stepUpInput = (d: PolicyDraft): Record<string, unknown> => ({
  environment: d.environment,
  required: d.required,
  allow_author_approval: d.allowAuthorApproval,
  key_policy: d.keyPolicy,
});

export type PolicySaveResult =
  { ok: true; policy: ApprovalPolicy } | { ok: false; message: string };

/** Saves one environment: asks for the passkey first when loosening, or when the server says to. */
export async function saveApprovalPolicy(
  save: (a: PolicyDraft & { stepUp?: StepUpProof }) => Promise<ApprovalPolicy>,
  cur: ApprovalPolicyEnv,
  draft: PolicyDraft,
  confirm?: (input: Record<string, unknown>) => Promise<StepUpProof>,
): Promise<PolicySaveResult> {
  try {
    if (confirm && loosensPolicy(cur, draft)) {
      return {
        ok: true,
        policy: await save({ ...draft, stepUp: await confirm(stepUpInput(draft)) }),
      };
    }
    try {
      return { ok: true, policy: await save(draft) };
    } catch (e) {
      if (!confirm || !(e instanceof ApiError) || e.reason !== "step_up_required") throw e;
      return {
        ok: true,
        policy: await save({ ...draft, stepUp: await confirm(stepUpInput(draft)) }),
      };
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "The change was not accepted." };
  }
}
