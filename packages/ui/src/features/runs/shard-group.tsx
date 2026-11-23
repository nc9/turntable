import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { getBackend } from "@/api";
import type { Job, JobAttempt, Run } from "@/api/types";
import { Duration } from "@/components/live-clock";
import { StateIcon } from "@/components/state-badge";
import { type ShardGroup, shardLabel } from "@/lib/shards";
import { cn } from "@/lib/utils";
import { RerunButton } from "./rerun-dialog";

const FINISHED = ["success", "failure", "infra_error", "cancelled", "skipped"];

/**
 * One row for a job the operator splits across sandboxes: its name, the fold of its shards'
 * states and the wall time from the first shard's start to the last one's finish. A disclosure
 * button opens the shards: which shard it is, the step it owns, its attempts, its own duration
 * and its own rerun. Open by default when a shard needs attention.
 */
export function ShardGroupRow({
  group,
  run,
  jobs,
  attempts,
  orgSlug,
  projectSlug,
  AttemptChip,
}: {
  group: ShardGroup;
  run: Run;
  /** Every job of the run (the rerun dialog lists them). */
  jobs: Job[];
  attempts: JobAttempt[];
  orgSlug: string;
  projectSlug: string;
  AttemptChip: (p: { attempt: JobAttempt; job?: Job }) => React.ReactNode;
}) {
  const needsAttention = group.shards.some(
    (s) => s.state === "failure" || s.state === "infra_error",
  );
  const [open, setOpen] = useState(needsAttention);
  const panelId = useId();
  const canRerun = getBackend().api.capabilities.rerun;
  return (
    <li className="border-b border-line last:border-b-0">
      <h3 className="m-0 text-base font-normal">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-left transition-colors duration-150 hover:bg-subtle focus-visible:-outline-offset-2"
        >
          <ChevronRight
            className={cn("size-4 shrink-0 text-faint transition-transform", open && "rotate-90")}
            aria-hidden="true"
          />
          <StateIcon state={group.state} className="size-[18px]" />
          <span className="min-w-0 flex-1 basis-40">
            <span className="block truncate text-sm font-medium">{group.name}</span>
            <span className="text-xs text-dim">
              {group.shards.length} shards, each in its own sandbox
            </span>
          </span>
          <span className="w-16 text-right text-xs text-dim">
            <Duration startedAt={group.startedAt} finishedAt={group.finishedAt} />
          </span>
        </button>
      </h3>
      <ul
        id={panelId}
        hidden={!open}
        aria-label={`Shards of ${group.name}`}
        className="border-t border-line bg-subtle"
      >
        {group.shards.map((shard) => {
          const shardAttempts = attempts.filter((a) => a.jobId === shard.id);
          return (
            <li
              key={shard.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line py-1.5 pl-11 pr-4 last:border-b-0"
            >
              <Link
                to="/$org/$project/runs/$runId/jobs/$jobId"
                params={{ org: orgSlug, project: projectSlug, runId: run.id, jobId: shard.id }}
                className="flex min-w-0 flex-1 basis-56 flex-wrap items-center gap-x-3 gap-y-1 rounded-md py-1.5 hover:text-foreground focus-visible:-outline-offset-2"
              >
                <StateIcon state={shard.state} className="size-4" />
                <span className="min-w-0 flex-1 basis-40">
                  <span className="block text-sm font-medium">{shardLabel(shard)}</span>
                  {shard.shard && shard.shard.steps.length > 0 ? (
                    <span className="block truncate font-mono text-xs text-dim">
                      {shard.shard.steps.join(", ")}
                    </span>
                  ) : null}
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  {shardAttempts.map((a) => (
                    <AttemptChip key={a.id} attempt={a} job={shard} />
                  ))}
                </span>
                <span className="w-16 text-right text-xs text-dim">
                  <Duration startedAt={shard.startedAt} finishedAt={shard.finishedAt} />
                </span>
              </Link>
              {canRerun && FINISHED.includes(shard.state) ? (
                <RerunButton
                  run={run}
                  jobs={jobs}
                  job={shard}
                  label={`Rerun ${shardLabel(shard).toLowerCase()}`}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </li>
  );
}
