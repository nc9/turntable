// Sandbox usage, counted exactly: from when the provider's create returned to when its destroy was
// confirmed (`job_attempts.sandbox_created_at` and `sandbox_destroyed_at`). An attempt's own
// duration also covers waiting for provider capacity, so it is not used. Quotas read the same
// numbers, so what is shown and what is limited cannot differ.
import { and, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { yieldProjects } from "./project-settings";
import { type Scope, scoped } from "./scope";

const DAY_MS = 86_400_000;

export interface SandboxDay {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  /** Sandbox time that fell on this day, in seconds (to the millisecond). */
  seconds: number;
  minutes: number;
  /** Attempts whose sandbox was alive at some point of this day. */
  attempts: number;
  /** Of those, how many had no confirmed destroy: their end is the attempt's finish, or now while it runs. */
  estimated: number;
}

export interface SandboxUsageWindow {
  /** Epoch ms, inclusive. */
  from: number;
  /** Epoch ms, exclusive. */
  to: number;
  /** The clock: where a sandbox still alive ends. */
  now: number;
  /**
   * For a limit, where an attempt that finished with no confirmed destroy ends: its finish plus
   * this long, never past `now`. A sandbox the provider never confirmed destroying may still be
   * alive (and billing) until its TTL, so a quota counts to there. The attempt's own recorded
   * sandbox TTL is the grace; this is the fallback for one with none (a legacy row, a provider
   * that reports no TTL). Absent (the Usage page): the attempt's finish.
   */
  graceMs?: number;
}

/** The grace for an unconfirmed destroy when the attempt recorded no TTL: Daytona's longest. */
export const DEFAULT_SANDBOX_GRACE_MS = 30 * 60_000;

/** The start of the UTC day containing `ms`. */
export const utcDayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
const dayName = (start: number): string => new Date(start).toISOString().slice(0, 10);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

interface Span {
  projectId: string;
  start: number;
  end: number;
  confirmed: boolean;
}

/** The sandbox lives of an org's (or project's) attempts that overlap the window. */
async function spans(db: Db, scope: Scope, w: SandboxUsageWindow): Promise<Span[]> {
  // A NULL create time (an attempt that never recorded it, a row from before the column existed,
  // a crash between create and record) falls back to when the attempt started: it holds or held
  // a sandbox, and counting it from the start over-counts rather than counting nothing.
  const start = sql<number>`coalesce(${s.jobAttempts.sandboxCreatedAt}, ${s.jobAttempts.startedAt})`;
  const fallback = w.graceMs ?? 0;
  // Where an unconfirmed attempt's sandbox may last to: its finish plus its own recorded TTL, or
  // the fallback when it has none. Without a limit's grace it is the finish alone.
  const graceExpr = sql<number>`case when ${s.jobAttempts.sandboxTtlSeconds} is null then ${fallback} when ${s.jobAttempts.sandboxTtlSeconds} > 0 then ${s.jobAttempts.sandboxTtlSeconds} * 1000 else 0 end`;
  const rows = await db.run((h) =>
    h.orm
      .select({
        created: s.jobAttempts.sandboxCreatedAt,
        started: s.jobAttempts.startedAt,
        destroyed: s.jobAttempts.sandboxDestroyedAt,
        finished: s.jobAttempts.finishedAt,
        ttl: s.jobAttempts.sandboxTtlSeconds,
        projectId: s.jobAttempts.projectId,
      })
      .from(s.jobAttempts)
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          or(isNotNull(s.jobAttempts.sandboxCreatedAt), isNotNull(s.jobAttempts.startedAt)),
          lt(start, w.to),
          // Alive during the window: a destroy after its start; or no confirmed destroy and a
          // finish (plus the grace) after it; or neither (still running, or lost).
          or(
            gt(s.jobAttempts.sandboxDestroyedAt, w.from),
            and(
              isNull(s.jobAttempts.sandboxDestroyedAt),
              isNotNull(s.jobAttempts.finishedAt),
              fallback > 0
                ? gt(sql`${s.jobAttempts.finishedAt} + ${graceExpr}`, w.from)
                : gt(s.jobAttempts.finishedAt, w.from),
            ),
            and(isNull(s.jobAttempts.sandboxDestroyedAt), isNull(s.jobAttempts.finishedAt)),
          ),
        ),
      ),
  );
  return rows.flatMap((r) => {
    const begin = (r.created ?? r.started) as number;
    // Confirmed destroy; else the attempt's finish (plus the grace for a limit, never past now);
    // else (still running) now. Never before the start.
    const grace = fallback > 0 ? Math.max(0, r.ttl === null ? fallback : r.ttl * 1000) : 0;
    const unconfirmedEnd =
      r.finished === null ? w.now : grace > 0 ? Math.min(w.now, r.finished + grace) : r.finished;
    const end = Math.max(begin, r.destroyed ?? unconfirmedEnd);
    // Estimated: no confirmed destroy, or no recorded create time.
    return [
      {
        projectId: r.projectId,
        start: begin,
        end,
        confirmed: r.destroyed !== null && r.created !== null,
      },
    ];
  });
}

const overlap = (a: Span, from: number, to: number): number =>
  Math.max(0, Math.min(a.end, to) - Math.max(a.start, from));

/** Per-day figures for a set of spans. Days with no usage are still listed. */
function dayRows(all: Span[], w: SandboxUsageWindow): SandboxDay[] {
  const out: SandboxDay[] = [];
  for (let d = utcDayStart(w.from); d < w.to; d += DAY_MS) {
    const from = Math.max(d, w.from);
    const to = Math.min(d + DAY_MS, w.to);
    let ms = 0;
    let attempts = 0;
    let estimated = 0;
    for (const sp of all) {
      const o = overlap(sp, from, to);
      if (o === 0 && !(sp.start >= from && sp.start < to)) continue;
      ms += o;
      attempts += 1;
      if (!sp.confirmed) estimated += 1;
    }
    const seconds = round3(ms / 1000);
    out.push({ day: dayName(d), seconds, minutes: round3(seconds / 60), attempts, estimated });
  }
  return out;
}

/** Sandbox time, per UTC day, for the days the window covers. Days with no usage are still listed. */
export async function sandboxUsage(
  db: Db,
  scope: Scope,
  w: SandboxUsageWindow,
): Promise<SandboxDay[]> {
  return dayRows(await spans(db, scope, w), w);
}

export interface ProjectSandboxUsage {
  projectId: string;
  slug: string;
  name: string;
  /** The project's `scheduling_class`. Minutes of preempted attempts count to the project. */
  schedulingClass: "normal" | "yield";
  days: SandboxDay[];
}

/**
 * The same figures per project, for the projects that had a sandbox alive in the window (a project
 * with no usage is left out). The scope narrows it exactly as it does `sandboxUsage`, so a project
 * token sees only its own project, and each day's rows across projects add up to the org's day.
 */
export async function sandboxUsageByProject(
  db: Db,
  scope: Scope,
  w: SandboxUsageWindow,
): Promise<ProjectSandboxUsage[]> {
  const all = await spans(db, scope, w);
  const byProject = new Map<string, Span[]>();
  for (const sp of all) {
    const list = byProject.get(sp.projectId);
    if (list) list.push(sp);
    else byProject.set(sp.projectId, [sp]);
  }
  if (byProject.size === 0) return [];
  const projects = await db.run((h) =>
    h.orm
      .select({ id: s.projects.id, slug: s.projects.slug, name: s.projects.name })
      .from(s.projects)
      .where(eq(s.projects.orgId, scope.orgId)),
  );
  const meta = new Map(projects.map((p) => [p.id, p]));
  const yielding = await yieldProjects(db);
  return [...byProject.entries()]
    .map(([projectId, list]) => ({
      projectId,
      slug: meta.get(projectId)?.slug ?? projectId,
      name: meta.get(projectId)?.name ?? projectId,
      schedulingClass: yielding.has(projectId) ? ("yield" as const) : ("normal" as const),
      days: dayRows(list, w),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Total sandbox seconds in a window, for a quota that limits a rolling period. */
export async function sandboxSeconds(
  db: Db,
  scope: Scope,
  w: SandboxUsageWindow,
): Promise<{ seconds: number; estimated: number }> {
  const all = await spans(db, scope, w);
  let ms = 0;
  let estimated = 0;
  for (const sp of all) {
    const o = overlap(sp, w.from, w.to);
    if (o === 0) continue;
    ms += o;
    if (!sp.confirmed) estimated += 1;
  }
  return { seconds: round3(ms / 1000), estimated };
}
