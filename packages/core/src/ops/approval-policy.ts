// The per-project `untrusted_run_approval` policy: who may release a run held for an untrusted
// author through `approve_run`. Pure, so every mode and caller is tested without a database.
import type { UntrustedRunApproval } from "../db/schema";
import type { Principal } from "./principal";

/** Why selecting `human` is refused until the signed-approval path exists (#324). */
export const HUMAN_MODE_UNAVAILABLE = "human approval mode isn't available yet (#324)";

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
 * - `human`: always. `approve_run` is a bearer-token op; only an enrolled approver's signature
 *   satisfies this policy, and no token or session does.
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
): ApprovalRefusal | undefined {
  const caller_kind = caller.principal.kind === "token" ? caller.principal.tokenKind : "person";
  const transport = caller.transport ?? "local";
  const who = { caller_kind, transport } as const;
  if (policy === "human") {
    return {
      reason: "approval_requires_human",
      message:
        "approval_requires_human: this project requires an enrolled approver's signed approval " +
        "(WebAuthn or ed25519) for a run held for an untrusted author; no token can approve it",
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
