// Cancelling a run: the one implementation behind the `cancel` operation, concurrency
// supersession and the local runner's Ctrl-C. Part of the only code that names tenant tables.
import { eq } from "drizzle-orm";
import type { Db } from "..";
import { announceCancelled, type CancelledAttempt } from "../abort-bus";
import { aggregateRunStatus } from "../job-state";
import * as s from "../schema";
import type { JobState } from "../schema";
import {
  getRun,
  listAttempts,
  listJobs,
  setRunStatus,
  transitionJob,
  updateAttempt,
} from "./index";
import { effectiveStates } from "./readiness";
import type { Scope } from "./scope";

const CANCELLABLE: readonly JobState[] = ["queued", "running", "awaiting_approval"];

export type CancelRunResult = {
  /** Jobs moved to cancelled. */
  cancelled: number;
  /** Jobs already finished, left as they were. */
  unchanged: number;
  /** Attempts that were running: their workers are told to stop and sandboxes destroyed. */
  running: CancelledAttempt[];
  /** The run's state afterwards. */
  state: JobState;
};

/**
 * Cancels every queued, running and waiting job of a run, and their attempts, in one transaction.
 * Finished jobs are left alone. Idempotent. Running attempts are announced on the abort bus after
 * commit, so a worker in this process stops them at once; the lease is cleared so a worker
 * elsewhere finds it gone at its next heartbeat and its late result cannot overwrite the cancel.
 * Returns undefined when the run is not in scope.
 */
export function cancelRunJobs(
  db: Db,
  scope: Scope,
  runId: string,
  opts: { errorClass?: string } = {},
): Promise<CancelRunResult | undefined> {
  return db.transaction(async (tx) => {
    const run = await getRun(tx, scope, runId);
    if (!run) return undefined;
    const runScope = { orgId: run.orgId, projectId: run.projectId };
    const out: CancelRunResult = { cancelled: 0, unchanged: 0, running: [], state: "queued" };
    for (const job of await listJobs(tx, runScope, run.id)) {
      if (!CANCELLABLE.includes(job.state as JobState)) {
        out.unchanged++;
        continue;
      }
      for (const a of await listAttempts(tx, runScope, job.id)) {
        if (a.state !== "queued" && a.state !== "running" && a.state !== "awaiting_approval")
          continue;
        if (a.state === "running") {
          out.running.push({ attemptId: a.id, sandboxId: a.sandboxId, provider: a.provider });
        }
        await updateAttempt(tx, runScope, a.id, {
          state: "cancelled",
          ...(opts.errorClass ? { errorClass: opts.errorClass } : {}),
        });
        await tx.orm
          .update(s.jobAttempts)
          .set({ leaseOwner: null, leaseExpiresAt: null })
          .where(eq(s.jobAttempts.id, a.id));
      }
      await transitionJob(tx, runScope, job.id, "cancelled");
      out.cancelled++;
    }
    const jobs = await listJobs(tx, runScope, run.id);
    out.state = jobs.length === 0 ? "cancelled" : aggregateRunStatus(effectiveStates(jobs));
    await setRunStatus(tx, runScope, run.id, out.state);
    announceCancelled(tx, out.running);
    return out;
  });
}
