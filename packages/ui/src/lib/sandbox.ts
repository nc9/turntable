// Display helpers for sandbox time. The server computes the exact figure
// (`sandbox_seconds`); the only thing derived here is the estimate for an attempt whose destroy
// was never confirmed, and it is always labelled as one.
import type { JobAttempt, SandboxUsage, SandboxUsageDay } from "@/api/types";

export type SandboxInfo = {
  createdAt: number;
  destroyedAt: number | null;
  seconds: number;
  /** True when there is no confirmed destroy: `seconds` runs to the attempt's finish, or to now. */
  estimated: boolean;
};

export function sandboxInfo(a: JobAttempt, now: number): SandboxInfo | null {
  if (a.sandboxCreatedAt === null) return null;
  if (a.sandboxDestroyedAt !== null && a.sandboxSeconds !== null) {
    return {
      createdAt: a.sandboxCreatedAt,
      destroyedAt: a.sandboxDestroyedAt,
      seconds: a.sandboxSeconds,
      estimated: false,
    };
  }
  const end = a.finishedAt ?? now;
  return {
    createdAt: a.sandboxCreatedAt,
    destroyedAt: a.sandboxDestroyedAt,
    seconds: Math.max(0, end - a.sandboxCreatedAt) / 1000,
    estimated: true,
  };
}

/** UTC day of a `YYYY-MM-DD` key as a short label, `Nov 22`. */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Whole minutes for large values, one decimal for small ones: `245 min`, `3.5 min`. */
export function formatMinutes(m: number): string {
  const v = m >= 10 ? Math.round(m) : Math.round(m * 10) / 10;
  return `${v.toLocaleString("en-US")} min`;
}

/**
 * The days and total the Usage chart shows: the whole org (`slug` null), or one project's. A
 * project that is not in the answer (no usage in the window) shows as empty days, never as the
 * org's, so a stale filter cannot be mistaken for the whole.
 */
export function usageFor(
  usage: SandboxUsage,
  slug: string | null,
): { days: SandboxUsageDay[]; totalMinutes: number } {
  if (slug === null) return { days: usage.days, totalMinutes: usage.totalMinutes };
  const p = usage.projects.find((x) => x.slug === slug);
  if (p) return { days: p.days, totalMinutes: p.totalMinutes };
  return {
    days: usage.days.map((d) => ({
      day: d.day,
      seconds: 0,
      minutes: 0,
      attempts: 0,
      estimatedAttempts: 0,
    })),
    totalMinutes: 0,
  };
}
