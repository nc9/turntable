import type { ApproversOverview } from "@/api/types";

/**
 * Says which built-in approval default is in force for `production` and `release`, and why (#663).
 * Nothing shows when an explicit policy entry covers both: the default is not in force then.
 */
export function ApprovalDefaultNotice({
  mode,
  policies,
}: {
  mode: ApproversOverview["defaultMode"];
  policies: ApproversOverview["policies"];
}) {
  const inForce = policies.some(
    (p) =>
      (p.environment === "production" || p.environment === "release") && p.source === "default",
  );
  if (!inForce) return null;
  if (mode === "solo") {
    return (
      <div
        role="note"
        data-approval-default="solo"
        className="mt-5 rounded-lg border border-st-infra/40 bg-st-infra-bg p-3.5 text-sm"
      >
        <p className="font-medium">Solo: you are the only person who can approve.</p>
        <p className="mt-1 text-foreground">
          Releases and production need one approval and you may approve your own run. When a second
          owner or admin joins, they need two people and the author cannot approve; that switch is
          automatic and does not go back. For a stronger solo setup, set a hardware key policy.
        </p>
      </div>
    );
  }
  return (
    <div
      role="note"
      data-approval-default="strict"
      className="mt-5 rounded-lg border border-st-infra/40 bg-st-infra-bg p-3.5 text-sm"
    >
      <p className="font-medium">Releases and production need two people.</p>
      <p className="mt-1 text-foreground">
        This org has had a second person who can approve, so the stronger default applies: two
        distinct approvers, the author excluded. It stays that way if people leave. To require two
        people explicitly, set the policy under Settings, Approvals.
      </p>
    </div>
  );
}
