const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "narrow" });
const dtf = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "2m 14s", "1h 05m", "48s". Missing values render as a plain hyphen. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function formatRelative(ts: number, now: number = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return diff <= 0 ? "just now" : "in a moment";
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  if (abs < 7 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), "day");
  return dtf.format(ts);
}

export function formatDateTime(ts: number): string {
  return dtf.format(ts);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** `18.4 MB`; decimal units, as storage is usually sold. Log offsets use `formatBytes` (binary). */
export function formatSize(n: number): string {
  let v = n;
  let i = 0;
  while (v >= 1000 && i < SIZE_UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 || v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${SIZE_UNITS[i]}`;
}

export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "-";
}

export function branchFromRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, "").replace(/^refs\/pull\/(\d+)\/merge$/, "pull/$1");
}
