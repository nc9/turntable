// Presentation helpers for per-org quotas: names, units and how full a limit is.
import type { QuotaLimits, QuotaMetric, QuotaUsage } from "@/api/types";

export const QUOTA_ROWS: {
  metric: QuotaMetric;
  /** The field of the limits this metric is set through. */
  field: keyof QuotaLimits;
  label: string;
  unit: "count" | "minutes" | "bytes";
  note: string;
}[] = [
  {
    metric: "concurrent",
    field: "maxConcurrent",
    label: "Concurrent attempts",
    unit: "count",
    note: "Running at once. Replaces the instance's per-org cap for this org.",
  },
  {
    metric: "runs_per_hour",
    field: "maxRunsPerHour",
    label: "Runs per hour",
    unit: "count",
    note: "Runs that start in a rolling hour. A run that has started finishes its jobs.",
  },
  {
    metric: "sandbox_minutes",
    field: "maxSandboxMinutesPerDay",
    label: "Sandbox minutes per day",
    unit: "minutes",
    note: "From attempt start and finish times over the last 24 hours.",
  },
  {
    metric: "log_bytes",
    field: "maxLogBytes",
    label: "Log storage",
    unit: "bytes",
    note: "Stored job log bytes.",
  },
  {
    metric: "stored_bytes",
    field: "maxStoredBytes",
    label: "Artifact storage",
    unit: "bytes",
    note: "Recorded artifact bytes.",
  },
];

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** `1.5 GB`; decimal units, as storage is usually sold. */
export function formatBytes(n: number): string {
  let v = n;
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 || v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${UNITS[i]}`;
}

export function formatQuotaValue(n: number, unit: "count" | "minutes" | "bytes"): string {
  if (unit === "bytes") return formatBytes(n);
  if (unit === "minutes") return `${n.toLocaleString("en-US")} min`;
  return n.toLocaleString("en-US");
}

export type QuotaLevel = "ok" | "warning" | "reached" | "none";

/** `warning` from 80%, `reached` from 100%: the same thresholds the events fire at. */
export function quotaLevel(u: Pick<QuotaUsage, "limit" | "percent">): QuotaLevel {
  if (u.limit === null || u.percent === null) return "none";
  if (u.percent >= 100) return "reached";
  if (u.percent >= 80) return "warning";
  return "ok";
}
