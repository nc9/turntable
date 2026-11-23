import { useState } from "react";
import { getBackend } from "@/api";
import type { SandboxUsage } from "@/api/types";
import { ErrorState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useScope } from "@/features/shell/scope";
import { dayLabel, formatMinutes, usageFor } from "@/lib/sandbox";
import { useAsync } from "@/lib/use-async";

const RANGES = [7, 30] as const;
const CHART_H = 160;

/** Bars of sandbox minutes per UTC day, with the org's per-day quota as a dashed line. */
export function UsageChart({
  usage,
}: {
  usage: Pick<SandboxUsage, "days" | "totalMinutes" | "limitMinutesPerDay">;
}) {
  const { days, limitMinutesPerDay: limit } = usage;
  const peak = Math.max(1, limit ?? 0, ...days.map((d) => d.minutes));
  const top = Math.ceil(peak / 10) * 10;
  const summary =
    `Sandbox minutes per UTC day, ${days.length} days, ${formatMinutes(usage.totalMinutes)} in total.` +
    (limit === null ? "" : ` The daily limit is ${formatMinutes(limit)}.`);
  const every = days.length > 14 ? 5 : 1;
  return (
    <figure className="m-0">
      <div role="img" aria-label={summary} className="relative" style={{ height: CHART_H }}>
        <div className="absolute inset-0 border-b border-line" aria-hidden="true" />
        {limit !== null ? (
          <div
            className="absolute inset-x-0 border-t border-dashed border-st-approval"
            style={{ bottom: `${(limit / top) * 100}%` }}
            aria-hidden="true"
          >
            <span className="absolute right-0 -top-5 text-xs text-st-approval">
              Limit {formatMinutes(limit)}
            </span>
          </div>
        ) : null}
        <ol className="absolute inset-0 m-0 flex list-none items-end gap-[3px] p-0">
          {days.map((d) => {
            const over = limit !== null && d.minutes > limit;
            return (
              <li
                key={d.day}
                className="flex h-full min-w-0 flex-1 items-end"
                title={`${dayLabel(d.day)}: ${formatMinutes(d.minutes)}, ${d.attempts} attempts${d.estimatedAttempts > 0 ? `, ${d.estimatedAttempts} estimated` : ""}`}
              >
                <div
                  className={`w-full rounded-t-sm ${over ? "bg-st-failure" : "bg-foreground"} ${d.estimatedAttempts > 0 ? "opacity-60" : "opacity-90"}`}
                  style={{
                    height: `${(d.minutes / top) * 100}%`,
                    minHeight: d.minutes > 0 ? 2 : 0,
                  }}
                />
              </li>
            );
          })}
        </ol>
      </div>
      <div className="mt-1 flex gap-[3px] text-[11px] text-dim" aria-hidden="true">
        {days.map((d, i) => (
          <span key={d.day} className="min-w-0 flex-1 truncate text-center">
            {i % every === 0 || i === days.length - 1 ? dayLabel(d.day).replace(" ", " ") : ""}
          </span>
        ))}
      </div>
      <figcaption className="mt-3 text-xs text-dim">
        Lighter bars include an attempt whose sandbox destroy was never confirmed, so that time is
        an estimate. Days are UTC.
      </figcaption>
    </figure>
  );
}

/** Sandbox minutes per UTC day for the org. */
export function UsagePage() {
  const scope = useScope();
  const { api } = getBackend();
  const [days, setDays] = useState<number>(7);
  const [project, setProject] = useState<string | null>(null);
  const q = useAsync(() => api.sandboxUsage({ days, byProject: true }), [scope.orgSlug, days]);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Usage</h1>
        <div role="group" aria-label="Range" className="flex gap-1">
          {RANGES.map((r) => (
            <Button
              key={r}
              size="sm"
              variant={days === r ? "default" : "ghost"}
              aria-pressed={days === r}
              onClick={() => setDays(r)}
            >
              {r} days
            </Button>
          ))}
        </div>
      </div>
      {q.error && !q.data ? (
        <ErrorState title="Could not load usage" message={q.error} onRetry={q.reload} />
      ) : !q.data ? (
        <div role="status" aria-label="Loading" className="space-y-3">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-44 w-full" />
        </div>
      ) : (
        <section className="rounded-xl border border-line bg-surface p-4">
          <h2 className="mb-1 text-sm font-medium">Sandbox minutes per day</h2>
          {q.data.projects.length > 0 ? (
            <div role="group" aria-label="Project" className="mb-3 flex flex-wrap gap-1">
              <Button
                size="sm"
                variant={project === null ? "default" : "ghost"}
                aria-pressed={project === null}
                onClick={() => setProject(null)}
              >
                All projects
              </Button>
              {q.data.projects.map((p) => (
                <Button
                  key={p.id}
                  size="sm"
                  variant={project === p.slug ? "default" : "ghost"}
                  aria-pressed={project === p.slug}
                  onClick={() => setProject(p.slug)}
                >
                  {p.name} ({formatMinutes(p.totalMinutes)})
                </Button>
              ))}
            </div>
          ) : null}
          {(() => {
            const shown = usageFor(q.data, project);
            const name = q.data.projects.find((p) => p.slug === project)?.name;
            return (
              <>
                <p className="mb-6 text-sm text-dim">
                  {formatMinutes(shown.totalMinutes)} in the last {days} days
                  {name ? ` in ${name}` : ""}, counted from the provider's create to its confirmed
                  destroy.
                </p>
                <UsageChart
                  usage={{
                    ...shown,
                    // The quota is the org's: a project's bars are not measured against it.
                    limitMinutesPerDay: project === null ? q.data.limitMinutesPerDay : null,
                  }}
                />
              </>
            );
          })()}
        </section>
      )}
    </div>
  );
}
