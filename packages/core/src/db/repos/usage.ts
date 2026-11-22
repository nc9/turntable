// Sandbox usage, counted exactly: from when the provider's create returned to when its destroy was
// confirmed (`job_attempts.sandbox_created_at` and `sandbox_destroyed_at`). An attempt's own
// duration also covers waiting for provider capacity, so it is not used. Quotas read the same
// numbers, so what is shown and what is limited cannot differ.
import { gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { Db } from "..";
import * as s from "../schema";
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
}

/** The start of the UTC day containing `ms`. */
export const utcDayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
const dayName = (start: number): string => new Date(start).toISOString().slice(0, 10);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

interface Span {
  start: number;
  end: number;
  confirmed: boolean;
}

/** The sandbox lives of an org's (or project's) attempts that overlap the window. */
async function spans(db: Db, scope: Scope, w: SandboxUsageWindow): Promise<Span[]> {
  const rows = await db.run((h) =>
    h.orm
      .select({
        created: s.jobAttempts.sandboxCreatedAt,
        destroyed: s.jobAttempts.sandboxDestroyedAt,
        finished: s.jobAttempts.finishedAt,
      })
      .from(s.jobAttempts)
      .where(
        scoped(
          scope,
          { orgId: s.jobAttempts.orgId, projectId: s.jobAttempts.projectId },
          isNotNull(s.jobAttempts.sandboxCreatedAt),
          lt(s.jobAttempts.sandboxCreatedAt, w.to),
          // Alive during the window: no confirmed destroy yet, or one after its start.
          or(
            isNull(s.jobAttempts.sandboxDestroyedAt),
            gt(s.jobAttempts.sandboxDestroyedAt, w.from),
          ),
        ),
      ),
  );
  return rows.flatMap((r) => {
    const start = r.created as number;
    // Confirmed destroy; else the attempt's finish; else (still running) now. Never before the start.
    const end = Math.max(start, r.destroyed ?? r.finished ?? w.now);
    return [{ start, end, confirmed: r.destroyed !== null }];
  });
}

const overlap = (a: Span, from: number, to: number): number =>
  Math.max(0, Math.min(a.end, to) - Math.max(a.start, from));

/** Sandbox time, per UTC day, for the days the window covers. Days with no usage are still listed. */
export async function sandboxUsage(
  db: Db,
  scope: Scope,
  w: SandboxUsageWindow,
): Promise<SandboxDay[]> {
  const all = await spans(db, scope, w);
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
