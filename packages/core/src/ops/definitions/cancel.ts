import { z } from "zod";
import { cancelRunJobs } from "../../db/repos";
import { JOB_STATES } from "../../db/schema";
import { defineOp } from "../define";
import { OpError } from "../errors";

export const cancel = defineOp({
  name: "cancel",
  summary: "Cancel a run: queued, running and waiting jobs become cancelled.",
  description:
    "Cancels a run by moving every queued, running or awaiting-approval job to cancelled. Jobs " +
    "that already finished are left as they are. Idempotent: cancelling a finished or already " +
    "cancelled run changes nothing. Destructive and audited; it needs the operator role. A running " +
    "job is stopped at once: its worker is told to abort and its sandbox is destroyed (a worker " +
    "in another process stops at its next heartbeat). An optional reason is recorded in the audit entry.",
  input: z.object({
    run_id: z.string().min(1).max(64),
    reason: z
      .string()
      .max(500)
      .optional()
      .describe(
        "Why (optional, up to 500 characters). Trimmed; blank counts as absent. Recorded in the audit entry.",
      ),
  }),
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
    // One implementation (shared with supersession and Ctrl-C of a local run). Running attempts
    // are announced after commit, so a worker in this process aborts and destroys the sandbox at
    // once; another process's worker stops at its next heartbeat.
    const res = await cancelRunJobs(ctx.db, ctx.scope, input.run_id);
    if (!res) throw new OpError("not_found", "run not found");
    return {
      run_id: input.run_id,
      state: res.state,
      cancelled_jobs: res.cancelled,
      unchanged_jobs: res.unchanged,
    };
  },
});
