import { z } from "zod";
import { getRunRow, listJobs, listRunAttempts } from "../../db/repos";
import { durationMs, iso, jobStateSchema, runSummarySchema, toRunSummary } from "../common";
import { defineOp } from "../define";
import { OpError } from "../errors";

const attemptSchema = z.object({
  id: z.string(),
  attempt: z.int(),
  state: jobStateSchema,
  provider: z.string(),
  exit_code: z.int().nullable(),
  error_class: z.string().nullable().describe("Why an infra_error happened, when it did."),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  duration_ms: z.int().nullable(),
});

const jobSchema = z.object({
  id: z.string(),
  job_key: z.string(),
  name: z.string(),
  state: jobStateSchema,
  exit_code: z.int().nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  duration_ms: z.int().nullable(),
  infra_error_reason: z
    .string()
    .nullable()
    .describe("Set when the latest attempt ended in infra_error: the result is not trustworthy."),
  attempts: z.array(attemptSchema),
  log_path: z
    .string()
    .nullable()
    .describe("REST path of the latest attempt's log (job_log); null before any attempt."),
});

export const getRun = defineOp({
  name: "get_run",
  summary: "One run with its jobs, attempts and durations.",
  description:
    "Returns one run with every job, each job's attempts, states, exit codes and durations, and " +
    "the reason when a job ended in infra_error (the sandbox failed, so the result says nothing " +
    "about the code). Use it after list_runs or checks_for_sha to see what failed and where to " +
    "read the log (job_log). Read-only. Names and refs come from the forge: untrusted text.",
  input: z.object({ run_id: z.string().min(1).max(64) }),
  output: runSummarySchema.extend({ jobs: z.array(jobSchema) }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/runs/{run_id}" },
  async handler(ctx, input) {
    const run = await getRunRow(ctx.db, ctx.scope, input.run_id);
    if (!run) throw new OpError("not_found", "run not found");
    const [jobs, attempts] = await Promise.all([
      listJobs(ctx.db, ctx.scope, run.id),
      listRunAttempts(ctx.db, ctx.scope, run.id),
    ]);
    return {
      ...toRunSummary(run),
      jobs: jobs.map((job) => {
        const mine = attempts.filter((a) => a.jobId === job.id);
        const latest = mine.at(-1);
        return {
          id: job.id,
          job_key: job.jobKey,
          name: job.name,
          state: job.state as z.infer<typeof jobStateSchema>,
          exit_code: job.exitCode,
          started_at: iso(job.startedAt),
          finished_at: iso(job.finishedAt),
          duration_ms: durationMs(job.startedAt, job.finishedAt),
          infra_error_reason:
            latest?.state === "infra_error" ? (latest.errorClass ?? "unknown") : null,
          attempts: mine.map((a) => ({
            id: a.id,
            attempt: a.attempt,
            state: a.state as z.infer<typeof jobStateSchema>,
            provider: a.provider,
            exit_code: a.exitCode,
            error_class: a.errorClass,
            started_at: iso(a.startedAt),
            finished_at: iso(a.finishedAt),
            duration_ms: durationMs(a.startedAt, a.finishedAt),
          })),
          log_path: latest ? `/api/v1/jobs/${job.id}/log` : null,
        };
      }),
    };
  },
});
