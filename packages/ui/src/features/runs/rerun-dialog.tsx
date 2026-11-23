import { RotateCw } from "lucide-react";
import { useState } from "react";
import type { Job, Run } from "@/api/types";
import { isSubmitKey, SubmitHint } from "@/components/submit-hint";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { rerunAction } from "@/db/collections";
import { toast } from "@/lib/toast";

const MAX_REASON = 500;

/**
 * Rerun the failed jobs of a run, or one job. The API audits a reason, so the dialog asks for
 * one. Pass `job` for a one-job rerun from the job page.
 */
export function RerunButton({
  run,
  jobs,
  job,
  label,
}: {
  run: Run;
  jobs: Job[];
  job?: Job;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const failed = jobs.filter((j) => j.state === "failure" || j.state === "infra_error");
  const pending = run.id.startsWith("pending_");
  const nothing = !job && failed.length === 0;
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        disabled={pending || nothing}
        title={nothing ? "No failed jobs to rerun" : undefined}
        onClick={() => setOpen(true)}
      >
        <RotateCw />
        {label ?? (job ? "Rerun job" : "Rerun")}
      </Button>
      {open ? (
        <RerunDialog
          run={run}
          jobs={jobs}
          {...(job ? { job } : {})}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function RerunDialog({
  run,
  jobs,
  job,
  onClose,
}: {
  run: Run;
  jobs: Job[];
  job?: Job;
  onClose: () => void;
}) {
  const failed = jobs.filter((j) => j.state === "failure" || j.state === "infra_error");
  const [target, setTarget] = useState<string>(job ? job.jobKey : "failed");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const trimmed = reason.trim();
  const invalid = trimmed.length === 0;
  const submit = () => {
    setTouched(true);
    if (invalid) return;
    const keys = target === "failed" ? undefined : [target];
    const tx = rerunAction({ runId: run.id, ...(keys ? { jobKeys: keys } : {}), reason: trimmed });
    tx.isPersisted.promise.then(
      () => toast(target === "failed" ? "Failed jobs requeued" : "Job requeued"),
      (e: unknown) =>
        toast(e instanceof Error ? e.message : "Could not rerun. Nothing was changed.", "error"),
    );
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="p-5"
        onKeyDown={(e) => {
          if (isSubmitKey(e)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <DialogTitle className="text-base font-semibold">Rerun jobs</DialogTitle>
        <DialogDescription className="mt-1 text-sm text-dim">
          Each job gets a new attempt in this run. The reason is recorded in the audit log.
        </DialogDescription>
        {job ? null : (
          <div className="mt-4">
            <label htmlFor="rerun-target" className="text-sm font-medium">
              What to rerun
            </label>
            <select
              id="rerun-target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="mt-1.5 h-9 w-full rounded-md border border-line-strong bg-surface px-2.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <option value="failed">Failed jobs ({failed.length})</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.jobKey}>
                  Only {j.name}
                  {j.shard ? ` (shard ${j.shard.index + 1} of ${j.shard.total})` : ""}
                </option>
              ))}
            </select>
          </div>
        )}
        {job ? (
          <p className="mt-4 text-sm">
            Rerunning <span className="font-mono text-[13px]">{job.name}</span>
          </p>
        ) : null}
        <div className="mt-4">
          <label htmlFor="rerun-reason" className="text-sm font-medium">
            Reason
          </label>
          <textarea
            id="rerun-reason"
            value={reason}
            maxLength={MAX_REASON}
            rows={3}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={touched && invalid}
            aria-describedby={touched && invalid ? "rerun-reason-error" : undefined}
            placeholder="For example: flaky network on the runner"
            className="mt-1.5 w-full resize-y rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-foreground placeholder:text-faint focus-visible:outline-2 focus-visible:outline-ring"
          />
          {touched && invalid ? (
            <p id="rerun-reason-error" className="mt-1 text-[13px] text-st-failure">
              Add a short reason so the rerun can be audited.
            </p>
          ) : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} aria-keyshortcuts="Meta+Enter Control+Enter">
            Rerun
            <SubmitHint />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
