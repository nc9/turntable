import type { PreviewWorkflow, WorkflowPreview } from "@/api/onboarding";
import { cn } from "@/lib/utils";

const VERDICT_STYLE = {
  run: "bg-st-success-bg text-st-success",
  skip: "bg-muted text-dim",
  fail: "bg-st-failure-bg text-st-failure",
} as const;

/**
 * What the planner would do with one project's workflow files. Every name, path, trigger, reason
 * and fix comes from a file in the repo and is untrusted: each is a React text node, so it shows
 * as literal characters (no HTML, no markdown).
 */
export function WorkflowPreviewView({ preview }: { preview: WorkflowPreview }) {
  if (preview.workflows.length === 0)
    return <p className="text-sm text-dim">No workflow files found at the default branch.</p>;
  return (
    <div className="space-y-3">
      <SecretsSummary preview={preview} />
      {preview.workflows.map((w) => (
        <WorkflowRows key={w.path} w={w} />
      ))}
      {preview.truncated ? (
        <p className="text-[13px] text-dim">
          More workflow files not shown: the preview reads at most 50 files.
        </p>
      ) : null}
    </div>
  );
}

function WorkflowRows({ w }: { w: PreviewWorkflow }) {
  return (
    <div className="rounded-lg border border-line">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line bg-subtle px-3 py-2">
        <span className="font-mono text-[13px]">{w.path}</span>
        {w.name ? <span className="text-[13px] text-dim">{w.name}</span> : null}
        {w.triggers.length > 0 ? (
          <span className="text-xs text-faint">on {w.triggers.join(", ")}</span>
        ) : null}
        {!w.too_large && !w.ingested ? (
          <span className="text-xs text-faint">not ingested by Turntable</span>
        ) : null}
      </div>
      {w.too_large ? (
        <p className="px-3 py-2 text-[13px] text-dim">
          Too large to preview. Turntable still reads it when it runs.
        </p>
      ) : w.jobs.length === 0 ? (
        <p className="px-3 py-2 text-[13px] text-dim">No jobs.</p>
      ) : (
        <ul>
          {w.jobs.map((j) => (
            <li
              key={j.job_id}
              className="flex flex-col gap-1 border-b border-line px-3 py-2 last:border-b-0"
            >
              <div className="flex items-center gap-2 text-[13px]">
                <span
                  className={cn(
                    "w-10 shrink-0 rounded px-1.5 py-0.5 text-center text-xs",
                    VERDICT_STYLE[j.verdict],
                  )}
                >
                  {j.verdict}
                </span>
                <span className="min-w-0 break-words font-medium">{j.name ?? j.job_id}</span>
                {j.name && j.name !== j.job_id ? (
                  <span className="min-w-0 break-words font-mono text-xs text-faint">
                    {j.job_id}
                  </span>
                ) : null}
              </div>
              {j.reason ? <p className="pl-12 text-[13px] text-dim">{j.reason}</p> : null}
              {j.fix ? <p className="pl-12 text-[13px]">Fix: {j.fix}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The one-line answer to "which secrets does this project need", and a per-job table of every
 * secret and var name the workflows refer to. Names only: the server never returns a value.
 */
export function SecretsSummary({ preview }: { preview: WorkflowPreview }) {
  const rows = preview.workflows.flatMap((w) =>
    w.jobs.filter((j) => (j.refs ?? []).length > 0).map((j) => ({ path: w.path, job: j })),
  );
  return (
    <div className="space-y-2" data-testid="secrets-summary">
      <p className="text-sm font-medium">
        {preview.needs_summary?.text ?? "Secret needs are not available."}
      </p>
      {rows.length > 0 ? (
        <table className="w-full text-left text-[13px]">
          <thead className="text-xs text-faint">
            <tr>
              <th className="py-1 pr-3 font-normal">Job</th>
              <th className="py-1 pr-3 font-normal">Runs</th>
              <th className="py-1 font-normal">References</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ path, job: j }) => (
              <tr key={`${path}:${j.job_id}`} className="border-t border-line align-top">
                <td className="py-1.5 pr-3">
                  <span className="break-words font-mono text-xs">{j.job_id}</span>
                  <span className="block text-xs text-faint">{path}</span>
                </td>
                <td className="py-1.5 pr-3">{j.will_run ? "runs" : "won't run"}</td>
                <td className="py-1.5">
                  <ul className="space-y-0.5">
                    {(j.refs ?? []).map((r) => (
                      <li key={`${r.kind}:${r.name}`} className="break-words">
                        <span className="font-mono text-xs">
                          {r.kind === "secret" ? "secrets" : "vars"}.{r.name}
                        </span>{" "}
                        <span className="text-xs text-dim">
                          {r.provided ? "provided by Turntable, not needed" : r.where.join(", ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
