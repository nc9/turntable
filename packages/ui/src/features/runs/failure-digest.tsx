import { CircleX } from "lucide-react";
import { getBackend } from "@/api";
import type { Job, JobAttempt } from "@/api/types";
import { sanitize } from "@/log/parser";
import { useAsync } from "@/lib/use-async";

const BASIS: Record<string, string> = {
  annotation: "From an error annotation in the log",
  error_pattern: "From the first error in the log",
  tail: "The last lines of the log",
};

/**
 * Why a failed job failed, from the server's `failure_digest`: the failing step and a short
 * excerpt of its log. The excerpt is untrusted log text, so it is sanitised and rendered as text.
 */
export function FailureDigestPanel({ job, attempt }: { job: Job; attempt: JobAttempt | null }) {
  const failed = job.state === "failure" || job.state === "infra_error";
  const q = useAsync(
    async () => {
      if (!failed) return null;
      const r = await getBackend().api.failureDigest({ jobId: job.id });
      return r.digests.find((d) => d.jobId === job.id) ?? null;
    },
    // Refetch when the job lands in a failed state or gets a new attempt.
    [job.id, failed, attempt?.id, attempt?.state],
  );
  if (!failed || q.error || !q.data) return null;
  const d = q.data;
  return (
    <section
      aria-labelledby="digest-h"
      className="mt-4 overflow-hidden rounded-lg border border-st-failure/40 bg-st-failure-bg"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 pt-3 text-sm">
        <CircleX className="size-4 shrink-0 text-st-failure" aria-hidden="true" />
        <h2 id="digest-h" className="font-medium text-foreground">
          {d.infraErrorReason ? "Infrastructure error" : "Why this failed"}
        </h2>
        {d.step ? (
          <span className="text-[13px] text-dim">
            in step <span className="font-mono text-xs">{sanitize(d.step.name)}</span>
          </span>
        ) : null}
        {d.basis ? <span className="text-xs text-dim">{BASIS[d.basis]}</span> : null}
      </div>
      {d.infraErrorReason ? (
        <p className="px-3.5 pt-2 text-[13px] text-foreground">{sanitize(d.infraErrorReason)}</p>
      ) : null}
      {d.excerpt ? (
        <pre className="m-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-background p-3 font-mono text-xs leading-5 text-foreground">
          {sanitize(d.excerpt)}
        </pre>
      ) : (
        <div className="h-3" />
      )}
      {d.truncated ? (
        <p className="px-3.5 pb-3 text-xs text-dim">Excerpt shortened. The full log is below.</p>
      ) : null}
    </section>
  );
}
