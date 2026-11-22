import { z } from "zod";
import { MAX_RERUNS_PER_JOB_PER_SHA, RerunError, rerunJobs } from "../../db/repos";
import { JOB_STATES } from "../../db/schema";
import { defineOp } from "../define";
import { OpError } from "../errors";

export const rerun = defineOp({
  name: "rerun",
  summary: "Rerun failed jobs of a run, or named jobs, with a reason. Capped per commit.",
  description:
    "Puts jobs of a finished run back in the queue with a new attempt. jobs='failed' (default) " +
    "reruns every job that failed or hit an infrastructure error; a list of job keys reruns " +
    "exactly those (they must be finished). A reason is required and is recorded with the " +
    "attempt and in the audit log. Each job may be rerun at most 2 times per commit; past that " +
    "the call is refused with a 409, so do not loop on it: look at the failure instead " +
    "(get_run, job_log). All or nothing: if any job is refused, nothing changes. A rerun never " +
    "bypasses approval: a job that needs approval goes back to awaiting_approval (see state in " +
    "the result), and one that never ran and needs approval is refused. This queues " +
    "the work only; the scheduler picks the queued attempts up, so poll get_run or follow " +
    "events to watch it. Operator role. Writes and is audited.",
  input: z.object({
    run_id: z.string().min(1).max(64),
    jobs: z
      .union([z.literal("failed"), z.array(z.string().min(1).max(100)).min(1).max(50)])
      .default("failed")
      .describe("'failed', or a list of job keys."),
    reason: z.string().min(1).max(500).describe("Why. Recorded with the attempt and audited."),
  }),
  output: z.object({
    run_id: z.string(),
    state: z.enum(JOB_STATES).describe("The run's state after queueing."),
    reruns: z.array(
      z.object({
        job_id: z.string(),
        job_key: z.string(),
        attempt: z.int().describe("The new, queued attempt number."),
        previous_state: z.enum(JOB_STATES),
        state: z
          .enum(JOB_STATES)
          .describe("queued, or awaiting_approval when the job needs a human before it may run."),
        reruns_used: z
          .int()
          .describe(`Reruns of this job on this commit so far, of ${MAX_RERUNS_PER_JOB_PER_SHA}.`),
      }),
    ),
  }),
  effect: "write",
  auth: { type: "token", minRole: "operator" },
  untrustedOutput: false,
  scope: "org",
  http: { method: "POST", path: "/runs/{run_id}/rerun" },
  async handler(ctx, input) {
    try {
      const out = await rerunJobs(ctx.db, ctx.scope, {
        runId: input.run_id,
        jobs: input.jobs,
        reason: input.reason,
      });
      if (!out) throw new OpError("not_found", "run not found");
      return {
        run_id: out.run.id,
        state: out.run.status as (typeof JOB_STATES)[number],
        reruns: out.reruns.map((r) => ({
          job_id: r.job.id,
          job_key: r.job.jobKey,
          attempt: r.attempt,
          previous_state: r.previousState,
          state: r.state,
          reruns_used: r.rerunsUsed,
        })),
      };
    } catch (err) {
      if (err instanceof RerunError) {
        throw new OpError(err.code === "unknown_job" ? "invalid_input" : "conflict", err.message);
      }
      throw err;
    }
  },
});
