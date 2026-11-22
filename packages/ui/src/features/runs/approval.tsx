import { KeyRound, ShieldAlert } from "lucide-react";
import type { Job } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useCanApproveUntrusted } from "@/lib/permissions";

/**
 * Why a run is waiting for a human. Two gates, handled differently:
 * - untrusted author: an operator approves from the UI (button disabled until the API exists)
 * - release or environment: a WebAuthn security-key flow (#46), so no button here yet
 */
export function ApprovalNotice({ jobs }: { jobs: Job[] }) {
  const can = useCanApproveUntrusted();
  const waiting = jobs.filter((j) => j.state === "awaiting_approval");
  const author = waiting.filter((j) => j.approval === "untrusted_author");
  const env = waiting.filter((j) => j.approval === "environment");
  if (author.length === 0 && env.length === 0) return null;
  return (
    <div className="mt-5 flex flex-col gap-3">
      {author.length > 0 ? (
        <div
          role="note"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-st-approval/40 bg-st-approval-bg p-3.5 text-sm"
        >
          <ShieldAlert className="size-4 shrink-0 text-st-approval" aria-hidden="true" />
          <p className="min-w-0 flex-1 basis-64 text-foreground">
            This run comes from an author outside the project, so nothing has started. Review the
            change, then approve it to run.
          </p>
          {/* TODO(#17): enable once the approvals API exists and the caller has the operator role. */}
          <Tooltip label={can.reason}>
            <span tabIndex={0} className="inline-flex rounded-md">
              <Button size="sm" disabled={!can.allowed} aria-disabled={!can.allowed}>
                Approve and run
              </Button>
            </span>
          </Tooltip>
        </div>
      ) : null}
      {env.length > 0 ? (
        <div
          role="note"
          className="flex items-center gap-3 rounded-lg border border-st-approval/40 bg-st-approval-bg p-3.5 text-sm"
        >
          <KeyRound className="size-4 shrink-0 text-st-approval" aria-hidden="true" />
          <p className="text-foreground">
            Approval required: approve with your security key.
            <span className="ml-1 text-dim">Waiting: {env.map((j) => j.name).join(", ")}.</span>
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function approvalLabel(job: Job): string {
  return job.approval === "environment"
    ? "Approval required: approve with your security key"
    : "Waiting for an operator to approve";
}
