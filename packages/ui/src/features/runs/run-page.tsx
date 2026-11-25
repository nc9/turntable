import { Link, useParams } from "@tanstack/react-router";
import { ChevronRight, Info, OctagonX, RotateCw } from "lucide-react";
import { useMemo, useState } from "react";
import type { Job, JobAttempt, JobState, Run } from "@/api/types";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Duration } from "@/components/live-clock";
import { StateBadge, StateIcon } from "@/components/state-badge";
import { getBackend } from "@/api";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { cancelAction } from "@/db/collections";
import { useRunSync } from "@/db/sync";
import { useScope } from "@/features/shell/scope";
import { formatDateTime, formatRelative } from "@/lib/format";
import { groupJobs, type JobItem } from "@/lib/shards";
import { isActive, STATE_META } from "@/lib/states";
import { toast } from "@/lib/toast";
import { ApprovalNotice, approvalLabel } from "./approval";
import { retriedAutomatically } from "./infra-retry";
import { ArtifactsPanel } from "./artifacts-panel";
import { SandboxTimes } from "./sandbox-time";
import { RerunButton } from "./rerun-dialog";
import { EgressBadge, TrustBadge } from "./trust";
import { JobGraph } from "./job-graph";
import { ShardGroupRow } from "./shard-group";
import { RefChip, ShaChip, useRunAttempts, useRunJobs, useRunRow } from "./common";

export function AttemptChip({ attempt, job }: { attempt: JobAttempt; job?: Job }) {
  const infra = attempt.state === "infra_error";
  return (
    <span
      title={
        infra
          ? `Infra error (${attempt.errorClass ?? "unknown"}). Not a code failure.`
          : STATE_META[attempt.state].description
      }
      className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs ${infra ? "border-st-infra/40 bg-st-infra-bg text-st-infra" : "border-line text-dim"}`}
    >
      <StateIcon state={attempt.state} className="size-3.5" />
      <span>Attempt {attempt.attempt}</span>
      {infra && attempt.errorClass ? (
        <span className="font-mono text-[11px]">{attempt.errorClass}</span>
      ) : null}
      {!infra && attempt.state === "failure" && job ? <span>exit {attempt.exitCode}</span> : null}
    </span>
  );
}

function RunActions({ run, jobs }: { run: Run; jobs: Job[] }) {
  const canRerun = getBackend().api.capabilities.rerun;
  const active = isActive(run.status);
  const doCancel = () => {
    const tx = cancelAction({ runId: run.id });
    tx.isPersisted.promise.then(
      () => toast("Run cancelled"),
      () => toast("Could not cancel. The run is unchanged.", "error"),
    );
  };
  return (
    <div className="flex items-center gap-2">
      {active ? (
        <Button variant="destructive" size="sm" onClick={doCancel}>
          <OctagonX />
          Cancel run
        </Button>
      ) : null}
      {canRerun ? (
        <RerunButton run={run} jobs={jobs} />
      ) : (
        <Tooltip label="Rerun is not available through the API yet">
          <span tabIndex={0} className="inline-flex rounded-md">
            <Button variant="secondary" size="sm" disabled>
              <RotateCw />
              Rerun
            </Button>
          </span>
        </Tooltip>
      )}
    </div>
  );
}

/** One count per job: the shards of a split job count once, as the fold of their states. */
function jobSummary(items: JobItem[]): { state: JobState; count: number }[] {
  const counts = new Map<JobState, number>();
  for (const it of items) {
    const state = it.kind === "job" ? it.job.state : it.group.state;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return [...counts.entries()].map(([state, count]) => ({ state, count }));
}

export function RunPage() {
  const scope = useScope();
  const runId = (useParams({ strict: false }) as { runId?: string }).runId ?? "";
  const sync = useRunSync(runId || null);
  const [tab, setTab] = useState<"jobs" | "artifacts">("jobs");
  const run = useRunRow(runId);
  const jobs = useRunJobs(runId);
  const attempts = useRunAttempts(useMemo(() => jobs.map((j) => j.id), [jobs]));
  const orgSlug = scope.orgSlug as string;
  const projectSlug = scope.projectSlug as string;

  if (sync.error && !run)
    return (
      <ErrorState title="Could not load this run" message={sync.error} onRetry={sync.reload} />
    );
  if (!run) {
    return (
      <div
        className="mx-auto w-full max-w-6xl space-y-4 p-5"
        role="status"
        aria-label="Loading run"
      >
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="mt-6 h-56 w-full" />
      </div>
    );
  }
  const infraAttempts = attempts.filter((a) => a.state === "infra_error");
  const items = groupJobs(jobs);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16 pt-5 sm:px-5">
      <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1 text-[13px] text-dim">
        <Link
          to="/$org/$project"
          params={{ org: orgSlug, project: projectSlug }}
          className="rounded hover:text-foreground"
        >
          Runs
        </Link>
        <ChevronRight className="size-3.5 text-faint" aria-hidden="true" />
        <span className="font-mono text-xs">{run.id.slice(-8).toLowerCase()}</span>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight">{run.commitMessage}</h1>
            <StateBadge state={run.status} />
            <TrustBadge run={run} />
            <EgressBadge run={run} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-dim">
            <span>{run.workflowName}</span>
            <RefChip run={run} />
            <ShaChip sha={run.sha} />
            <span>
              {run.event.replace("_", " ")}
              {run.actor ? ` by ${run.actor}` : ""}
            </span>
            <span title={formatDateTime(run.createdAt)}>{formatRelative(run.createdAt)}</span>
            <span className="inline-flex items-center gap-1">
              Took{" "}
              <Duration
                startedAt={run.startedAt ?? (run.status === "queued" ? null : run.createdAt)}
                finishedAt={run.finishedAt}
                className="text-foreground"
              />
            </span>
          </div>
        </div>
        <RunActions run={run} jobs={jobs} />
      </div>

      <ApprovalNotice run={run} jobs={jobs} />

      {infraAttempts.length > 0 ? (
        <div
          role="note"
          className="mt-5 flex gap-3 rounded-lg border border-st-infra/40 bg-st-infra-bg p-3.5 text-sm"
        >
          <Info className="mt-0.5 size-4 shrink-0 text-st-infra" aria-hidden="true" />
          <p className="text-foreground">
            {infraAttempts.length === 1
              ? "One attempt hit an infrastructure error"
              : `${infraAttempts.length} attempts hit infrastructure errors`}
            . These attempts say nothing about your code.{" "}
            {infraAttempts.some(retriedAutomatically)
              ? "Turntable retries them automatically."
              : "Turntable does not retry them: fix the cause, then re-run."}
          </p>
        </div>
      ) : null}

      <div role="tablist" aria-label="Run" className="mt-6 flex gap-1 border-b border-line">
        {(["jobs", "artifacts"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`panel-${t}`}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors duration-150 ${tab === t ? "border-foreground font-medium text-foreground" : "border-transparent text-dim hover:text-foreground"}`}
          >
            {t === "jobs" ? "Jobs" : "Artifacts"}
          </button>
        ))}
      </div>

      {tab === "artifacts" ? (
        <div role="tabpanel" id="panel-artifacts" aria-labelledby="tab-artifacts">
          <ArtifactsPanel runId={run.id} project={projectSlug} />
        </div>
      ) : (
        <div role="tabpanel" id="panel-jobs" aria-labelledby="tab-jobs">
          <section className="mt-6" aria-labelledby="graph-h">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="graph-h" className="text-sm font-semibold">
                Jobs
              </h2>
              <div className="flex flex-wrap items-center gap-3 text-xs text-dim">
                {jobSummary(items).map((s) => (
                  <span key={s.state} className="inline-flex items-center gap-1">
                    <StateIcon state={s.state} className="size-3.5" />
                    {s.count} {STATE_META[s.state].label.toLowerCase()}
                  </span>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-line bg-subtle p-5">
              {jobs.length === 0 ? (
                sync.loading ? (
                  <Skeleton className="h-40 w-full" />
                ) : (
                  <EmptyState title="No jobs yet">
                    Jobs appear once the workflow is parsed.
                  </EmptyState>
                )
              ) : (
                <JobGraph
                  jobs={jobs}
                  attempts={attempts}
                  orgSlug={orgSlug}
                  projectSlug={projectSlug}
                  runId={run.id}
                />
              )}
            </div>
          </section>

          {jobs.length > 0 ? (
            <section className="mt-8" aria-labelledby="attempts-h">
              <h2 id="attempts-h" className="mb-3 text-sm font-semibold">
                Attempts
              </h2>
              <ul className="overflow-hidden rounded-xl border border-line">
                {items.map((item) => {
                  if (item.kind === "shards")
                    return (
                      <ShardGroupRow
                        key={item.group.id}
                        group={item.group}
                        run={run}
                        jobs={jobs}
                        attempts={attempts}
                        orgSlug={orgSlug}
                        projectSlug={projectSlug}
                        AttemptChip={AttemptChip}
                      />
                    );
                  const job = item.job;
                  const jobAttempts = attempts.filter((a) => a.jobId === job.id);
                  const last = jobAttempts.at(-1);
                  return (
                    <li key={job.id} className="border-b border-line last:border-b-0">
                      <Link
                        to="/$org/$project/runs/$runId/jobs/$jobId"
                        params={{
                          org: orgSlug,
                          project: projectSlug,
                          runId: run.id,
                          jobId: job.id,
                        }}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 transition-colors duration-150 hover:bg-subtle focus-visible:-outline-offset-2"
                      >
                        <StateIcon state={job.state} className="size-[18px]" />
                        <span className="min-w-0 flex-1 basis-40">
                          <span className="block truncate text-sm font-medium">{job.name}</span>
                          {job.state === "infra_error" ||
                          (last?.state === "infra_error" && job.state !== "success") ? (
                            <span className="text-xs text-st-infra">
                              Infra error, not a code failure
                            </span>
                          ) : job.state === "failure" ? (
                            <span className="text-xs text-st-failure">
                              Exited with code {job.exitCode}
                            </span>
                          ) : job.state === "awaiting_approval" ? (
                            <span className="text-xs text-st-approval">{approvalLabel(job)}</span>
                          ) : null}
                        </span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          {jobAttempts.map((a) => (
                            <AttemptChip key={a.id} attempt={a} job={job} />
                          ))}
                        </span>
                        <span className="w-16 text-right text-xs text-dim">
                          <Duration startedAt={job.startedAt} finishedAt={job.finishedAt} />
                        </span>
                        <SandboxTimes attempts={jobAttempts} now={Date.now()} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
