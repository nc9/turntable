import { CircleAlert, CircleCheck, Hourglass } from "lucide-react";
import { useEffect } from "react";
import { getBackend } from "@/api";
import type { IngestRepoStatus } from "@/api/types";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { useNow } from "@/components/live-clock";
import { Skeleton } from "@/components/ui/skeleton";
import { useScope } from "@/features/shell/scope";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useAsync } from "@/lib/use-async";
import { sanitize } from "@/log/parser";

const POLL_MS = 15_000;
const nf = new Intl.NumberFormat();

function Outcome({ repo }: { repo: IngestRepoStatus }) {
  if (repo.lastOutcome === null) return <span className="text-dim">Not polled yet</span>;
  if (repo.lastOutcome === "ok" && repo.consecutiveFailures === 0)
    return (
      <span className="inline-flex items-center gap-1.5">
        <CircleCheck className="size-3.5 text-st-success" aria-hidden="true" />
        Healthy
      </span>
    );
  if (repo.lastOutcome === "rate_limited")
    return (
      <span className="inline-flex items-center gap-1.5">
        <Hourglass className="size-3.5 text-st-infra" aria-hidden="true" />
        Rate limited
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5">
      <CircleAlert className="size-3.5 text-st-failure" aria-hidden="true" />
      Failing
    </span>
  );
}

/** Per-repo state of the GitHub ingest poller, and the API rate budget it spends. */
export function IngestPage() {
  const scope = useScope();
  const q = useAsync(() => getBackend().api.ingestStatus(), [scope.orgSlug]);
  const reload = q.reload;
  useEffect(() => {
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
  }, [reload]);
  const now = useNow(true);

  if (q.error && !q.data)
    return <ErrorState title="Could not load ingest status" message={q.error} onRetry={q.reload} />;
  const data = q.data;
  if (!data)
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4 p-5" role="status" aria-label="Loading">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  const rl = data.rateLimit;
  const pct =
    rl && rl.limit && rl.remaining !== null
      ? Math.max(0, Math.min(100, Math.round((rl.remaining / rl.limit) * 100)))
      : null;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-6 sm:px-5">
      <h1 className="text-xl font-semibold tracking-tight">Ingest status</h1>
      <p className="mt-0.5 text-sm text-dim">
        How Turntable picks up runs from GitHub.{" "}
        {data.running ? "The poller is running." : "The poller is not running."}
      </p>

      <section aria-labelledby="budget-h" className="mt-6 rounded-xl border border-line p-4">
        <h2 id="budget-h" className="text-sm font-semibold">
          Rate budget
        </h2>
        {rl && pct !== null && rl.limit !== null && rl.remaining !== null ? (
          <>
            <div className="mt-3 flex items-baseline justify-between text-sm">
              <span className="tabular">
                {nf.format(rl.remaining)} of {nf.format(rl.limit)} requests left
              </span>
              {rl.resetAt ? (
                <span className="text-dim" title={formatDateTime(rl.resetAt)}>
                  Resets {formatRelative(rl.resetAt, now)}
                </span>
              ) : null}
            </div>
            <div
              role="meter"
              aria-label="Requests left"
              aria-valuemin={0}
              aria-valuemax={rl.limit}
              aria-valuenow={rl.remaining}
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div
                className={`h-full rounded-full ${pct < 10 ? "bg-st-failure" : pct < 25 ? "bg-st-infra" : "bg-st-success"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-dim">
              Seen {formatRelative(rl.observedAt, now)}
              {rl.resource ? ` on the ${rl.resource} budget` : ""}.
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-dim">
            No rate limit seen yet. It appears after the first poll.
          </p>
        )}
      </section>

      <section aria-labelledby="repos-h" className="mt-6">
        <h2 id="repos-h" className="mb-3 text-sm font-semibold">
          Repositories
        </h2>
        {data.repos.length === 0 ? (
          <EmptyState title="No repositories polled">
            Connect a repository to a project and it shows up here.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-line bg-subtle text-xs text-dim">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Repository
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Last poll
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Next poll
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Failures
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Runs created
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.repos.map((r) => (
                  <tr key={`${r.repo}:${r.project}`} className="align-top">
                    <th scope="row" className="px-4 py-2.5 font-normal">
                      <span className="block font-mono text-[13px]">{sanitize(r.repo)}</span>
                      <span className="block text-xs text-dim">{sanitize(r.project)}</span>
                      {r.lastError ? (
                        <span className="mt-1 block max-w-xs break-words text-xs text-st-failure">
                          {sanitize(r.lastError)}
                        </span>
                      ) : null}
                    </th>
                    <td className="px-4 py-2.5">
                      <Outcome repo={r} />
                    </td>
                    <td
                      className="px-4 py-2.5 text-dim"
                      title={r.lastPollAt ? formatDateTime(r.lastPollAt) : undefined}
                    >
                      {r.lastPollAt ? formatRelative(r.lastPollAt, now) : "-"}
                    </td>
                    <td
                      className="px-4 py-2.5 text-dim"
                      title={r.nextPollAt ? formatDateTime(r.nextPollAt) : undefined}
                    >
                      {r.nextPollAt ? formatRelative(r.nextPollAt, now) : "-"}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right">{r.consecutiveFailures}</td>
                    <td className="tabular px-4 py-2.5 text-right">{nf.format(r.runsCreated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
