// The per-project `untrusted_run_approval` policy: who may release a run held for an untrusted
// author through `approve_run`. Pure, so every mode and caller is tested without a database.
import type { UntrustedRunApproval } from "../db/schema";
import type { Principal } from "./principal";

export type ApprovalRefusal = {
  /** Stable reason code, returned in the message and written to the audit row. */
  reason: "approval_requires_human" | "agents_may_not_approve";
  message: string;
  /** What the audit row records about the caller. */
  caller: { caller_kind: "agent" | "person"; transport: "mcp" | "rest" | "local" };
};

/**
 * Whether `approve_run` is refused for this caller under the project's policy.
 *
 * - `human`: refused unless the call carries a signed statement (`signed`). `approve_run` is a
 *   bearer-token op, so a token alone never satisfies this policy; the caller then verifies the
 *   statement against the org's enrolled approvers and refuses the call if it does not hold. The
 *   token only relays what a person signed.
 * - `no_agents`: refused over MCP whoever holds the token, and on any transport for an agent
 *   token, so an agent cannot step around the MCP block by calling REST.
 * - `any`: allowed (the role check still applies).
 *
 * A caller that is not a token is a person at the host (the local CLI). An unknown transport is
 * not MCP, but an agent token is refused whatever the transport.
 */
export function approvalRefusal(
  policy: UntrustedRunApproval,
  caller: { principal: Principal; transport: "mcp" | "rest" | undefined },
  signed = false,
): ApprovalRefusal | undefined {
  const caller_kind = caller.principal.kind === "token" ? caller.principal.tokenKind : "person";
  const transport = caller.transport ?? "local";
  const who = { caller_kind, transport } as const;
  if (policy === "human") {
    if (signed) return undefined;
    return {
      reason: "approval_requires_human",
      message:
        "approval_requires_human: this project requires an enrolled approver's signed statement " +
        "(WebAuthn or ed25519, from approve_run_challenge) for a run held for an untrusted author; " +
        "a token alone cannot approve it",
      caller: who,
    };
  }
  if (policy === "no_agents" && (transport === "mcp" || caller_kind === "agent")) {
    return {
      reason: "agents_may_not_approve",
      message:
        "agents_may_not_approve: this project does not let an agent approve a run held for an " +
        "untrusted author (not over MCP, not with an agent token). Ask a person to approve it " +
        "in the web UI, or with their own person token over REST or the CLI",
      caller: who,
    };
  }
  return undefined;
}
