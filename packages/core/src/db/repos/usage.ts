// Sandbox usage: the one definition behind the Usage page, quotas and `instance_run_summary`, so
// what is shown and what is limited cannot differ (#598). Only an attempt with a recorded
// `sandbox_created_at` counts (one that never made a sandbox counts 0). It runs from there to
// `sandbox_destroyed_at`, else to the attempt's `finished_at`, and only a still-running attempt
// runs to now. An estimated end (no confirmed destroy) never exceeds the attempt's recorded
// sandbox TTL. The interval is clipped to the window. An attempt's own duration also covers
// waiting for provider capacity, so it is not used.
import { and, eq, gt, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
import { PREEMPTED } from "./lease";
import { yieldProjects } from "./project-settings";
import type { Scope } from "./scope";

const DAY_MS = 86_400_000;

export interface SandboxDay {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  /** Sandbox time that fell on this day, in seconds (to the millisecond). */
  seconds: number;
  minutes: number;
  /** Attempts whose sandbox was alive at some point of this day. */
  attempts: number;
  /** Of those, how many are still running: their end is now, so the figure is an estimate. */
  estimated: number;
}

export interface SandboxUsageWindow {
  /** Epoch ms, inclusive. */
  from: number;
  /** Epoch ms, exclusive. */
  to: number;
  /** The clock: where a sandbox still alive ends. */
  now: number;
}

/** The start of the UTC day containing `ms`. */
export const utcDayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
const dayName = (start: number): string => new Date(start).toISOString().slice(0, 10);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export interface Span {
  orgId: string;
  projectId: string;
  jobId: string;
  /** The attempt was preempted (#355): its time is reported apart from useful time. */
  preempted: boolean;
  start: number;
  end: number;
  confirmed: boolean;
}

/**
 * The sandbox lives of attempts that overlap the window, for an org, a project or (no org) the
 * whole instance. Only attempts with a recorded sandbox create time have one.
 */
export async function sandboxSpans(
  db: Db,
  scope: Partial<Scope>,
  w: SandboxUsageWindow,
): Promise<Span[]> {
  const rows = await db.run((h) =>
    h.orm
      .select({
        created: s.jobAttempts.sandboxCreatedAt,
        destroyed: s.jobAttempts.sandboxDestroyedAt,
        finished: s.jobAttempts.finishedAt,
        state: s.jobAttempts.state,
        ttl: s.jobAttempts.sandboxTtlSeconds,
        orgId: s.jobAttempts.orgId,
        projectId: s.jobAttempts.projectId,
        jobId: s.jobAttempts.jobId,
        errorClass: s.jobAttempts.errorClass,
      })
      .from(s.jobAttempts)
      .where(
        and(
          scope.orgId === undefined ? undefined : eq(s.jobAttempts.orgId, scope.orgId),
          scope.projectId === undefined ? undefined : eq(s.jobAttempts.projectId, scope.projectId),
          isNotNull(s.jobAttempts.sandboxCreatedAt),
          lt(s.jobAttempts.sandboxCreatedAt, w.to),
          // Alive during the window: a destroy after its start; or no destroy and a finish after
          // it; or neither (still running, or lost).
          or(
            gt(s.jobAttempts.sandboxDestroyedAt, w.from),
            and(
              isNull(s.jobAttempts.sandboxDestroyedAt),
              or(isNull(s.jobAttempts.finishedAt), gt(s.jobAttempts.finishedAt, w.from)),
            ),
          ),
        ),
      ),
  );
  return rows.flatMap((r) => {
    const begin = r.created as number;
    let end: number;
    let live = false;
    if (r.destroyed !== null) end = r.destroyed;
    else {
      live = r.finished === null && r.state === "running";
      // A finished attempt ends at its finish; a running one at now; one that is neither (lost,
      // never finished) has no known end and counts 0. An estimate never outlives the TTL.
      end = r.finished ?? (live ? w.now : begin);
      if (r.ttl !== null && r.ttl > 0) end = Math.min(end, begin + r.ttl * 1000);
    }
    end = Math.max(begin, end);
    return [
      {
        orgId: r.orgId,
        projectId: r.projectId,
        jobId: r.jobId,
        preempted: r.errorClass === PREEMPTED,
        start: begin,
        end,
        confirmed: !live,
      },
    ];
  });
}

const overlap = (a: Span, from: number, to: number): number =>
  Math.max(0, Math.min(a.end, to) - Math.max(a.start, from));

/** Sandbox ms inside [from, to) over a set of spans. */
export const spanMs = (all: Span[], from: number, to: number): number =>
  all.reduce((n, sp) => n + overlap(sp, from, to), 0);

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
  return dayRows(await sandboxSpans(db, scope, w), w);
}

export interface ProjectSandboxUsage {
  projectId: string;
  slug: string;
  name: string;
  /** The project's `scheduling_class`. Minutes of preempted attempts count to the project. */
  schedulingClass: "normal" | "yield";
  days: SandboxDay[];
  /** Attempts of the project preempted in the window (a yield project only; #355). */
  preemptions: number;
  /** Sandbox seconds of those attempts: counted in `days`, and reported apart here as waste. */
  preemptedSeconds: number;
  /** The jobs preempted most, with their counts (at most `TOP_PREEMPTED_JOBS`). */
  preemptedJobs: { jobId: string; jobKey: string; runId: string; preemptions: number }[];
}

const TOP_PREEMPTED_JOBS = 10;

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
  const all = await sandboxSpans(db, scope, w);
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
  const preemptedIds = [...new Set(all.filter((sp) => sp.preempted).map((sp) => sp.jobId))];
  const jobRows =
    preemptedIds.length === 0
      ? []
      : await db.run((h) =>
          h.orm
            .select({ id: s.jobs.id, jobKey: s.jobs.jobKey, runId: s.jobs.runId })
            .from(s.jobs)
            .where(and(eq(s.jobs.orgId, scope.orgId), inArray(s.jobs.id, preemptedIds))),
        );
  const jobMeta = new Map(jobRows.map((j) => [j.id, j]));
  return [...byProject.entries()]
    .map(([projectId, list]) => {
      const lost = list.filter((sp) => sp.preempted);
      const perJob = new Map<string, number>();
      for (const sp of lost) perJob.set(sp.jobId, (perJob.get(sp.jobId) ?? 0) + 1);
      return {
        projectId,
        slug: meta.get(projectId)?.slug ?? projectId,
        name: meta.get(projectId)?.name ?? projectId,
        schedulingClass: yielding.has(projectId) ? ("yield" as const) : ("normal" as const),
        days: dayRows(list, w),
        preemptions: lost.length,
        preemptedSeconds: round3(lost.reduce((n, sp) => n + overlap(sp, w.from, w.to), 0) / 1000),
        preemptedJobs: [...perJob.entries()]
          .filter(([id]) => jobMeta.has(id))
          .map(([id, n]) => ({
            jobId: id,
            jobKey: jobMeta.get(id)!.jobKey,
            runId: jobMeta.get(id)!.runId,
            preemptions: n,
          }))
          .sort((a, b) => b.preemptions - a.preemptions || a.jobId.localeCompare(b.jobId))
          .slice(0, TOP_PREEMPTED_JOBS),
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Total sandbox seconds in a window, for a quota that limits a rolling period. */
export async function sandboxSeconds(
  db: Db,
  scope: Scope,
  w: SandboxUsageWindow,
): Promise<{ seconds: number; estimated: number }> {
  const all = await sandboxSpans(db, scope, w);
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
