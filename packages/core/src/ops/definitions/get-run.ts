import { z } from "zod";
import { getRunRow, listJobs, listRunAttempts } from "../../db/repos";
import { APPROVAL_KINDS } from "../../db/schema";
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
  sandbox_created_at: z
    .string()
    .nullable()
    .describe("When the provider's create returned: the sandbox is billed from here."),
  sandbox_destroyed_at: z
    .string()
    .nullable()
    .describe("When the provider confirmed the destroy; null if never confirmed."),
  sandbox_seconds: z
    .number()
    .nullable()
    .describe(
      "Exact sandbox time (create to confirmed destroy); null until both are known. Unlike duration_ms it excludes time waiting for provider capacity.",
    ),
});

const jobSchema = z.object({
  id: z.string(),
  job_key: z.string(),
  name: z.string(),
  state: jobStateSchema,
  needs: z.array(z.string()).describe("Keys of the jobs this job waits for."),
  matrix: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe("This leg's matrix values; null when the job has no matrix."),
  approval_kind: z
    .enum(APPROVAL_KINDS)
    .nullable()
    .describe("Why the job waits for a human, if it does."),
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
  output: runSummarySchema.extend({
    trust: z
      .object({
        class: z.enum(["protected", "release", "trusted_pr", "untrusted_pr"]),
        reasons: z.array(z.string()).describe("Why the run got this class, in plain words."),
        facts: z
          .record(z.string(), z.unknown())
          .describe("The forge facts the class was decided from (repo match, permission)."),
        workflow_hash: z
          .string()
          .describe("sha256 of the workflow file; pass it to approve_run with the head sha."),
        decided_at: z.string(),
      })
      .nullable(),
    approval: z
      .object({
        by: z.string(),
        at: z.string(),
        head_sha: z.string(),
        workflow_hash: z.string(),
      })
      .nullable()
      .describe("Who approved the run and what they approved; null until approved."),
    jobs: z.array(jobSchema),
  }),
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
    const decision = run.trust ? (JSON.parse(run.trust) as Record<string, unknown>) : undefined;
    const approval = run.approval
      ? (JSON.parse(run.approval) as {
          by: string;
          at: number;
          head_sha: string;
          workflow_hash: string;
        })
      : undefined;
    return {
      ...toRunSummary(run),
      trust: decision
        ? {
            class: decision.class as "protected",
            reasons: decision.reasons as string[],
            facts: decision.facts as Record<string, unknown>,
            workflow_hash: decision.workflowHash as string,
            decided_at: iso(decision.decidedAt as number)!,
          }
        : null,
      approval: approval ? { ...approval, at: iso(approval.at)! } : null,
      jobs: jobs.map((job) => {
        const mine = attempts.filter((a) => a.jobId === job.id);
        const latest = mine.at(-1);
        return {
          id: job.id,
          job_key: job.jobKey,
          name: job.name,
          state: job.state as z.infer<typeof jobStateSchema>,
          needs: JSON.parse(job.needs) as string[],
          matrix: job.matrix === null ? null : (JSON.parse(job.matrix) as Record<string, unknown>),
          approval_kind: job.approvalKind as (typeof APPROVAL_KINDS)[number] | null,
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
            sandbox_created_at: iso(a.sandboxCreatedAt),
            sandbox_destroyed_at: iso(a.sandboxDestroyedAt),
            sandbox_seconds:
              a.sandboxCreatedAt !== null && a.sandboxDestroyedAt !== null
                ? Math.round(Math.max(0, a.sandboxDestroyedAt - a.sandboxCreatedAt)) / 1000
                : null,
          })),
          log_path: latest ? `/api/v1/jobs/${job.id}/log` : null,
        };
      }),
    };
  },
});
