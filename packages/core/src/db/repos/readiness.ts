// When may a queued job run, and what happens to dependents of a job that did not succeed. The
// verdict comes from a `Readiness` function the engine supplies; the default covers plain
// `needs`. Dependents are resolved the moment a dependency ends, in the same transaction, so a
// job that can never run does not sit in the queue.
import type { Db } from "..";
import { aggregateRunStatus } from "../job-state";
import type { JobState } from "../schema";
import { listRunAttempts } from "./api";
import {
  type Job,
  listAttempts,
  listJobs,
  setRunStatus,
  transitionJob,
  updateAttempt,
} from "./index";
import type { Scope } from "./scope";

/**
 * A dependency as the readiness function sees it. `missing` means the key names no job.
 * `reason` is the latest attempt's error class: a job skipped because ITS dependency failed
 * carries `dependency:<state>`, which tells it apart from one a filter skipped.
 */
export type DepState = { key: string; state: JobState | "missing"; reason: string | null };

/**
 * What the engine decides about a queued job. The shape matches `jobReadiness` of
 * `@longshore/act-runner`, so plugging the multi-job engine in is one adapter (turn `deps` into
 * its `needs` record, pass the planned job).
 *
 * - `ready`: may be claimed now.
 * - `wait`: not yet; a dependency is still going.
 * - `skip`: can never run (a dependency failed); becomes `skipped`. `reason` is for humans.
 * - `cancel`: can never run and the engine wants it `cancelled` (for example a `cancel` policy).
 */
export type Decision =
  | { decision: "ready" }
  | { decision: "wait" }
  | { decision: "skip"; reason: string }
  | { decision: "cancel"; reason: string };

export type Readiness = (job: Job, deps: readonly DepState[]) => Decision;

/** A dependency in the `needs` record shape of `jobReadiness` from `@longshore/act-runner`. */
export type NeedStatus = {
  state: string;
  outputs?: Record<string, string>;
  continueOnError?: boolean;
};

/**
 * Adapts a function in the shape of `jobReadiness(plannedJob, needs)` to a `Readiness`: `toPlanned`
 * builds the planned job from the stored one, and `deps` become the `needs` record (keyed by job
 * key). One adapter is all it takes to plug the multi-job engine in.
 */
export function adaptNeedsReadiness<P>(
  fn: (planned: P, needs: Record<string, NeedStatus>) => Decision,
  toPlanned: (job: Job) => P,
): Readiness {
  return (job, deps) =>
    fn(
      toPlanned(job),
      Object.fromEntries(deps.map((d) => [d.key, { state: d.state } satisfies NeedStatus])),
    );
}

/** The attempt error class recorded on a job skipped for a dependency, so a rerun can undo it. */
export const DEPENDENCY_SKIP_PREFIX = "dependency:";

/**
 * Default: ready when every need succeeded or was skipped by a filter (nothing to do, so it is
 * satisfied); skip when any need ended failure, cancelled or infra_error, was itself skipped
 * for a failed dependency, or does not exist; wait otherwise. A multi-job engine replaces this
 * to add `if: always()` and `failure()`.
 */
export const defaultReadiness: Readiness = (_job, deps) => {
  const missing = deps.find((d) => d.state === "missing");
  if (missing) return { decision: "skip", reason: `needs unknown job ${missing.key}` };
  const bad = deps.find(
    (d) =>
      d.state === "failure" ||
      d.state === "cancelled" ||
      d.state === "infra_error" ||
      (d.state === "skipped" && d.reason?.startsWith(DEPENDENCY_SKIP_PREFIX)),
  );
  if (bad) return { decision: "skip", reason: `${bad.key} ${bad.state}` };
  return deps.every((d) => d.state === "success" || d.state === "skipped")
    ? { decision: "ready" }
    : { decision: "wait" };
};

/** Dependencies of a job with their states, given the run's jobs and each job's latest error class. */
export function depStates(
  job: Job,
  siblings: readonly Job[],
  reasons: ReadonlyMap<string, string | null>,
): DepState[] {
  const needs = JSON.parse(job.needs) as string[];
  return needs.map((key) => {
    const dep = siblings.find((j) => j.jobKey === key);
    return {
      key,
      state: (dep?.state as JobState | undefined) ?? "missing",
      reason: dep ? (reasons.get(dep.id) ?? null) : null,
    };
  });
}

/** Latest attempt error class per job of a run. */
export async function latestReasons(
  db: Db,
  scope: Scope,
  runId: string,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const a of await listRunAttempts(db, scope, runId)) out.set(a.jobId, a.errorClass);
  return out;
}

/**
 * Moves queued jobs of a run that can never run out of the queue, repeatedly (a skipped job's own
 * dependents are resolved too), then refreshes the run status. Call inside the transaction of
 * the change that ended a dependency. Returns how many jobs it resolved.
 */
export async function resolveDependents(
  db: Db,
  scope: Scope,
  runId: string,
  readiness: Readiness = defaultReadiness,
): Promise<number> {
  let resolved = 0;
  for (;;) {
    const jobs = await listJobs(db, scope, runId);
    const reasons = await latestReasons(db, scope, runId);
    let changed = false;
    for (const job of jobs) {
      if (job.state !== "queued" || job.needs === "[]") continue;
      const deps = depStates(job, jobs, reasons);
      const verdict = readiness(job, deps).decision;
      if (verdict !== "skip" && verdict !== "cancel") continue;
      const to = verdict === "skip" ? "skipped" : "cancelled";
      const culprit = deps.find(
        (d) => d.state !== "success" && (d.state !== "skipped" || d.reason !== null),
      );
      await transitionJob(db, scope, job.id, to);
      const live = (await listAttempts(db, scope, job.id)).findLast((a) => a.state === "queued");
      if (live) {
        await updateAttempt(db, scope, live.id, {
          state: to,
          errorClass: `${DEPENDENCY_SKIP_PREFIX}${culprit?.state ?? "unknown"}`,
        });
      }
      resolved++;
      changed = true;
    }
    if (!changed) break;
  }
  if (resolved > 0) {
    const states = (await listJobs(db, scope, runId)).map((j) => j.state as JobState);
    await setRunStatus(db, scope, runId, aggregateRunStatus(states));
  }
  return resolved;
}
