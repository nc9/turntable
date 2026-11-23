import { jobReadiness, type PlannedJob } from "@turntable/act-runner";
import { defaultReadiness, type Readiness } from "../db/repos";

/**
 * The scheduler's readiness: `jobReadiness` of the multi-job engine, fed the planned job stored
 * on the job row, the states and outputs of its needs, and the run's `if:` contexts. It knows
 * `if: always()` / `failure()`, a false `if:`, unsupported jobs, `continue-on-error` and
 * outputs. A job with no stored plan (a legacy or hand-made one) falls back to plain `needs`.
 */
export const workflowReadiness: Readiness = (job, deps, run) => {
  if (job.planned === null) return defaultReadiness(job, deps, run);
  const planned = JSON.parse(job.planned) as PlannedJob;
  const ctx = run?.plan
    ? (JSON.parse(run.plan) as {
        github?: Record<string, never>;
        vars?: Record<string, never>;
        env?: Record<string, never>;
      })
    : {};
  const needs = Object.fromEntries(
    deps.map((d) => [
      d.key,
      {
        // A key that names no job reads as still queued, so the job waits rather than runs.
        state: d.state === "missing" ? ("queued" as const) : d.state,
        ...(d.outputs ? { outputs: d.outputs } : {}),
        ...(d.continueOnError ? { continueOnError: true } : {}),
      },
    ]),
  );
  return jobReadiness(planned, needs, {
    contexts: {
      github: ctx.github ?? {},
      vars: ctx.vars ?? {},
      inputs: {},
      env: ctx.env ?? {},
      secrets: {},
    },
    cancelled: run?.status === "cancelled",
  });
};
