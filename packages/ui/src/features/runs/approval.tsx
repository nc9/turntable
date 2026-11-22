import { Link } from "@tanstack/react-router";
import { KeyRound, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { getBackend } from "@/api";
import type { Job, Run } from "@/api/types";
import { isSubmitKey, SubmitHint } from "@/components/submit-hint";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { useScope } from "@/features/shell/scope";
import { useCanApprove } from "@/lib/permissions";
import { toast } from "@/lib/toast";

/**
 * Why a run is waiting for a human. Two gates, handled differently:
 * - untrusted author: an operator approves from the UI, bound to the head sha and workflow hash
 * - release or environment: signed with a passkey on the approval page (#46); a statement bound to
 *   the commit and workflow, and a quorum of distinct people
 */
export function ApprovalNotice({ run, jobs }: { run: Run; jobs: Job[] }) {
  const scope = useScope();
  const waiting = jobs.filter((j) => j.state === "awaiting_approval");
  const author = waiting.filter((j) => j.approval === "untrusted_author");
  const env = waiting.filter((j) => j.approval === "environment");
  if (author.length === 0 && env.length === 0) return null;
  return (
    <div className="mt-5 flex flex-col gap-3">
      {author.length > 0 ? <UntrustedGate run={run} /> : null}
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
          {getBackend().api.capabilities.humanApproval && scope.orgSlug && scope.projectSlug ? (
            <Link
              to="/$org/$project/runs/$runId/approve"
              params={{ org: scope.orgSlug, project: scope.projectSlug, runId: run.id }}
              className="ml-auto shrink-0 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-[13px] font-medium hover:bg-muted"
            >
              Review and approve
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function UntrustedGate({ run }: { run: Run }) {
  const can = useCanApprove();
  const [open, setOpen] = useState(false);
  const hash = run.trust?.workflowHash ?? null;
  const reasons = run.trust?.reasons ?? [];
  // Without a head sha and workflow hash there is nothing to bind an approval to.
  const bindable = run.sha !== null && hash !== null;
  const disabledReason = !can.allowed
    ? can.reason
    : !bindable
      ? "This run has no recorded sha or workflow hash to approve."
      : "";
  return (
    <div
      role="note"
      className="flex flex-wrap items-start gap-3 rounded-lg border border-st-approval/40 bg-st-approval-bg p-3.5 text-sm"
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-st-approval" aria-hidden="true" />
      <div className="min-w-0 flex-1 basis-64">
        <p className="font-medium text-foreground">Awaiting approval: untrusted author</p>
        <p className="mt-0.5 text-foreground">
          This run comes from an author outside the project, so nothing has started. Review the
          change, then approve it to run.
        </p>
        {reasons.length > 0 ? (
          <ul className="mt-1.5 list-inside list-disc text-[13px] text-dim">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
        {disabledReason ? <p className="mt-1.5 text-[13px] text-dim">{disabledReason}</p> : null}
      </div>
      {disabledReason ? (
        <Tooltip label={disabledReason}>
          <span tabIndex={0} className="inline-flex rounded-md">
            <Button size="sm" disabled aria-disabled="true">
              Approve and run
            </Button>
          </span>
        </Tooltip>
      ) : (
        <Button size="sm" onClick={() => setOpen(true)}>
          Approve and run
        </Button>
      )}
      {open && run.sha && hash ? (
        <ApproveDialog
          run={run}
          headSha={run.sha}
          workflowHash={hash}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ApproveDialog({
  run,
  headSha,
  workflowHash,
  onClose,
}: {
  run: Run;
  headSha: string;
  workflowHash: string;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await getBackend().api.approveRun({ runId: run.id, headSha, workflowHash });
      toast(`Approved. ${r.releasedJobs} ${r.releasedJobs === 1 ? "job" : "jobs"} released.`);
      onClose();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "The approval was not accepted. Reload the run to see its current state.",
      );
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        className="p-5"
        onKeyDown={(e) => {
          if (isSubmitKey(e)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <DialogTitle className="text-base font-semibold">Approve this run</DialogTitle>
        <DialogDescription className="mt-1 text-sm text-dim">
          The approval covers exactly this commit and this workflow. If either changes, the run is
          held again and needs a new approval.
        </DialogDescription>
        <dl className="mt-4 space-y-3 text-sm">
          <div>
            <dt className="text-dim">Head commit</dt>
            <dd className="mt-0.5 break-all font-mono text-[13px]">{headSha}</dd>
          </div>
          <div>
            <dt className="text-dim">Workflow hash</dt>
            <dd className="mt-0.5 break-all font-mono text-[13px]">{workflowHash}</dd>
          </div>
          <div>
            <dt className="text-dim">Author</dt>
            <dd className="mt-0.5">{run.actor ?? "unknown"}</dd>
          </div>
        </dl>
        {error ? (
          <p role="alert" className="mt-4 text-sm text-st-failure">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={busy}
            aria-keyshortcuts="Meta+Enter Control+Enter"
          >
            {busy ? "Approving" : "Approve and run"}
            <SubmitHint />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function approvalLabel(job: Job): string {
  return job.approval === "environment"
    ? "Approval required: approve with your security key"
    : "Waiting for an operator to approve";
}
