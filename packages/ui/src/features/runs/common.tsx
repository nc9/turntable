import { eq, useLiveQuery } from "@tanstack/react-db";
import { Link } from "@tanstack/react-router";
import { GitBranch, GitCommitHorizontal } from "lucide-react";
import { useMemo } from "react";
import type { Job, JobAttempt, Run } from "@/api/types";
import { attemptsCollection, jobsCollection, runsCollection } from "@/db/collections";
import { branchFromRef, shortSha } from "@/lib/format";

export function useRunRow(runId: string): Run | null {
  const { data } = useLiveQuery(
    (q) => q.from({ run: runsCollection }).where(({ run }) => eq(run.id, runId)),
    [runId],
  );
  return data?.[0] ?? null;
}

export function useRunJobs(runId: string): Job[] {
  const { data } = useLiveQuery(
    (q) => q.from({ job: jobsCollection }).where(({ job }) => eq(job.runId, runId)),
    [runId],
  );
  // Stable order: creation order of the workflow's jobs.
  return useMemo(() => (data ?? []).toSorted((a, b) => (a.id < b.id ? -1 : 1)), [data]);
}

export function useRunAttempts(jobIds: string[]): JobAttempt[] {
  const { data } = useLiveQuery((q) => q.from({ a: attemptsCollection }), []);
  return useMemo(() => {
    const set = new Set(jobIds);
    return (data ?? []).filter((a) => set.has(a.jobId)).toSorted((a, b) => a.attempt - b.attempt);
  }, [data, jobIds.join(",")]);
}

export function RefChip({ run, className }: { run: Run; className?: string }) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 ${className ?? ""}`}>
      <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{branchFromRef(run.ref)}</span>
    </span>
  );
}

export function ShaChip({ sha }: { sha: string | null }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs">
      <GitCommitHorizontal className="size-3.5" aria-hidden="true" />
      {shortSha(sha)}
    </span>
  );
}

export function RunLink({
  orgSlug,
  projectSlug,
  runId,
  children,
  className,
  ...rest
}: {
  orgSlug: string;
  projectSlug: string;
  runId: string;
  children: React.ReactNode;
  className?: string;
  "data-run-row"?: string;
}) {
  return (
    <Link
      to="/$org/$project/runs/$runId"
      params={{ org: orgSlug, project: projectSlug, runId }}
      {...(className ? { className } : {})}
      {...rest}
    >
      {children}
    </Link>
  );
}
