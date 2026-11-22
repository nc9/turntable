import { z } from "zod";
import {
  getRunRow,
  listAttempts,
  listJobs,
  setRunStatus,
  transitionJob,
  updateAttempt,
} from "../../db/repos";
import { aggregateRunStatus } from "../../db/job-state";
import type { JobState } from "../../db/schema";
import { JOB_STATES } from "../../db/schema";
import { defineOp } from "../define";
import { OpError } from "../errors";

const CANCELLABLE: readonly JobState[] = ["queued", "running", "awaiting_approval"];

export const cancel = defineOp({
  name: "cancel",
  summary: "Cancel a run: queued, running and waiting jobs become cancelled.",
  description:
    "Cancels a run by moving every queued, running or awaiting-approval job to cancelled. Jobs " +
    "that already finished are left as they are. Idempotent: cancelling a finished or already " +
    "cancelled run changes nothing. Destructive and audited; it needs the operator role. Today " +
    "this updates state only; a running sandbox is stopped by the controller in a later change.",
  input: z.object({ run_id: z.string().min(1).max(64) }),
  output: z.object({
    run_id: z.string(),
    state: z.enum(JOB_STATES).describe("The run's state after cancelling."),
    cancelled_jobs: z.int(),
    unchanged_jobs: z.int().describe("Jobs already finished, left as they were."),
  }),
  effect: "destructive",
  auth: { type: "token", minRole: "operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/runs/{run_id}/cancel" },
  async handler(ctx, input) {
    const run = await getRunRow(ctx.db, ctx.scope, input.run_id);
    if (!run) throw new OpError("not_found", "run not found");
    // TODO: ask the provider to kill the sandbox of each running attempt.
    let cancelled = 0;
    let unchanged = 0;
    for (const job of await listJobs(ctx.db, ctx.scope, run.id)) {
      if (!CANCELLABLE.includes(job.state as JobState)) {
        unchanged++;
        continue;
      }
      await transitionJob(ctx.db, ctx.scope, job.id, "cancelled");
      const live = (await listAttempts(ctx.db, ctx.scope, job.id)).findLast(
        (a) => a.state === "queued" || a.state === "running",
      );
      if (live) await updateAttempt(ctx.db, ctx.scope, live.id, { state: "cancelled" });
      cancelled++;
    }
    const states = (await listJobs(ctx.db, ctx.scope, run.id)).map((j) => j.state as JobState);
    const state = states.length === 0 ? "cancelled" : aggregateRunStatus(states);
    await setRunStatus(ctx.db, ctx.scope, run.id, state);
    return { run_id: run.id, state, cancelled_jobs: cancelled, unchanged_jobs: unchanged };
  },
});
