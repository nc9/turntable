import { Gauge } from "lucide-react";
import { useEffect, useRef } from "react";
import { getBackend } from "@/api";
import type { QuotaUsage } from "@/api/types";
import { ErrorState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useScope } from "@/features/shell/scope";
import { formatQuotaValue, QUOTA_ROWS, quotaLevel, type QuotaLevel } from "@/lib/quota";
import { useAsync } from "@/lib/use-async";
import { sanitize } from "@/log/parser";

/** Usage moves as attempts start and finish: re-read at most this often after a live change. */
const LIVE_REFRESH_MS = 1500;
const POLL_MS = 30_000;

const BAR: Record<QuotaLevel, string> = {
  none: "bg-faint",
  ok: "bg-st-success",
  warning: "bg-st-approval",
  reached: "bg-st-failure",
};

function Row({ u, row }: { u: QuotaUsage; row: (typeof QUOTA_ROWS)[number] }) {
  const level = quotaLevel(u);
  const pct = u.percent === null ? 0 : Math.min(100, u.percent);
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-medium">{row.label}</span>
        <span className="tabular ml-auto text-dim">
          {formatQuotaValue(u.used, row.unit)}
          {u.limit === null ? " used, no limit" : ` of ${formatQuotaValue(u.limit, row.unit)}`}
          {u.percent === null ? "" : ` (${u.percent}%)`}
        </span>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-subtle"
        role="progressbar"
        aria-label={`${row.label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={u.percent === null ? 0 : Math.min(100, u.percent)}
        aria-valuetext={u.limit === null ? "no limit" : `${u.percent ?? 0} percent`}
      >
        <div className={`h-full rounded-full ${BAR[level]}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-dim">{row.note}</p>
      {u.held ? (
        <p role="status" className="mt-1.5 text-[13px] font-medium text-st-failure">
          {sanitize(u.held)}
        </p>
      ) : level === "warning" ? (
        <p className="mt-1.5 text-[13px] text-st-approval">Over 80% of the limit.</p>
      ) : null}
    </li>
  );
}

/**
 * Per-org quotas, read-only: each limit with its usage and percent, and why new work is held.
 * Usage refreshes when the org's runs and jobs change live.
 */
export function QuotasPage() {
  const scope = useScope();
  const { api, realtime } = getBackend();
  const q = useAsync(() => api.getQuotas(), [scope.orgSlug]);
  const reload = q.reload;

  // Live: an attempt starting or finishing changes usage. Re-read, but not on every event.
  const orgId = scope.org?.id ?? null;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!orgId) return;
    const off = realtime.subscribe({ kind: "org", orgId }, {}, (m) => {
      if (m.type !== "change" || timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        reload();
      }, LIVE_REFRESH_MS);
    });
    const poll = setInterval(reload, POLL_MS);
    return () => {
      off();
      clearInterval(poll);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [orgId, realtime, reload]);

  if (q.error && !q.data)
    return <ErrorState title="Could not load quotas" message={q.error} onRetry={q.reload} />;
  if (!q.data)
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 p-5" role="status" aria-label="Loading">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  const d = q.data;

  const held = d.usage.filter((u) => u.held);
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6 sm:px-5">
      <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <Gauge className="size-5 text-dim" aria-hidden="true" />
        Quotas
      </h1>
      <p className="mt-0.5 text-sm text-dim">
        Limits for this org. A reached limit holds new work; running attempts finish.
      </p>

      {held.length > 0 ? (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-st-failure/40 bg-st-failure-bg px-4 py-3 text-sm"
        >
          <p className="font-medium">New work is being held</p>
          <ul className="mt-1 list-inside list-disc text-[13px]">
            {held.map((u) => (
              <li key={u.metric}>{sanitize(u.held ?? "")}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <ul className="mt-6 divide-y divide-line overflow-hidden rounded-xl border border-line">
        {QUOTA_ROWS.map((row) => {
          const u = d.usage.find((x) => x.metric === row.metric);
          return u ? <Row key={row.metric} u={u} row={row} /> : null;
        })}
      </ul>

      <p className="mt-6 text-sm text-dim">
        Limits are set by the instance operator on the server, never from here or over the API, so
        an org cannot raise its own:{" "}
        <code className="font-mono text-xs">
          turntable quotas set --org {scope.orgSlug ?? "&lt;org&gt;"} ...
        </code>
        . The concurrency limit can only lower the instance's per-org cap.
      </p>
    </div>
  );
}
