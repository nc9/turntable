import { z } from "zod";
import { checkName, checkScopeOf } from "../../checks/mapping";
import { jobsForRuns, listRepos, runsForSha } from "../../db/repos";
import type { RunJobRow } from "../../db/repos";
import type { JobState } from "../../db/schema";
import { JOB_STATES } from "../../db/schema";
import { defineOp } from "../define";
import { OpError } from "../errors";
import { effectiveChecksMode } from "../setting-guard";

const STATES = ["GREEN", "PENDING", "RED", "NONE", "CANCELLED"] as const;
export type CheckState = (typeof STATES)[number];

/** Most jobs listed per run; counts still cover every job. */
export const MAX_JOBS_PER_RUN = 256;

/**
 * Verdict over the latest run of each workflow. A cancelled run (cancelled by a concurrency
 * group, superseded by a newer push, or cancelled by a user) was never tested to a result, so it
 * never makes a sha RED: within a workflow the latest non-cancelled run decides. Across
 * workflows (one entry each): any failure or infra_error is RED; otherwise any queued, running or
 * awaiting-approval run is PENDING; otherwise a workflow whose runs were all cancelled makes it
 * CANCELLED, never GREEN; otherwise GREEN. No runs at all is NONE, which is not the same as queued.
 */
export function verdict(latest: readonly JobState[]): CheckState {
  if (latest.length === 0) return "NONE";
  if (latest.some((s) => s === "failure" || s === "infra_error")) return "RED";
  // A skipped run (nothing to run for this commit) does not block: it counts as passed.
  if (latest.some((s) => s !== "success" && s !== "skipped" && s !== "cancelled")) return "PENDING";
  // One entry per workflow (its deciding run). A workflow whose runs were ALL cancelled never
  // completed, so the sha is not green: a gate must not pass a sha with a workflow that never ran.
  if (latest.some((s) => s === "cancelled")) return "CANCELLED";
  return "GREEN";
}

export const checksForSha = defineOp({
  name: "checks_for_sha",
  summary: "GREEN, PENDING, RED, CANCELLED or NONE for a commit: the merge and deploy gate.",
  description:
    "Answers 'is this commit safe to merge or deploy?'. Looks at the latest NON-cancelled run of " +
    "each workflow for the full commit sha: GREEN if all succeeded, RED if any failed or hit an " +
    "infrastructure error, PENDING if anything is queued, running or waiting for approval, and " +
    "NONE only when no run exists for the sha (a queued run is PENDING, not NONE). A run " +
    "cancelled by a concurrency group, superseded by a newer push or cancelled by a user is " +
    "never RED: it is skipped in favour of the workflow's latest other run. A sha where any " +
    "workflow's runs were ALL cancelled is CANCELLED unless another workflow is red or pending " +
    "(precedence RED, PENDING, CANCELLED, GREEN): that workflow never finished, so re-run it. " +
    "Each run lists its jobs with the exact check name the reporter posts for each " +
    "(`turntable / <job>[ (<matrix leg>)]`, or `shadow / ...` in shadow mode), the job state and " +
    "its newest attempt number, so a required-check gate can match by name; at most 256 jobs " +
    "per run, with jobs_truncated set past that. counts is per JOB, over the same runs. Every " +
    "workflow counts as required until required-check configuration exists. Read-only and cheap. " +
    "workflow_path and check names come from the forge: untrusted text.",
  input: z.object({
    sha: z
      .string()
      .regex(/^[0-9a-fA-F]{40,64}$/, "full commit sha")
      .describe("Full commit sha."),
    repo: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/, "owner/name")
      .optional()
      .describe("owner/name of a bound repo, to narrow to its project."),
  }),
  output: z.object({
    sha: z.string(),
    state: z.enum(STATES),
    counts: z
      .record(z.enum(JOB_STATES), z.int())
      .describe(
        "Jobs per state, over the latest non-cancelled run of each workflow (the latest run when every run was cancelled).",
      ),
    runs: z.array(
      z.object({
        id: z.string(),
        project: z.string(),
        workflow_path: z.string(),
        state: z.enum(JOB_STATES),
        jobs: z.array(
          z.object({
            job_id: z.string(),
            check_name: z.string().describe("The check name as the reporter posts it."),
            conclusion: z.enum(JOB_STATES).describe("The job's state."),
            attempt: z.int().describe("Newest attempt number; 0 when none started."),
          }),
        ),
        jobs_truncated: z.boolean().describe("True when the run has more than 256 jobs."),
      }),
    ),
  }),
  effect: "read",
  auth: { type: "token", minRole: "reader" },
  untrustedOutput: true,
  scope: "org",
  http: { method: "GET", path: "/checks/{sha}" },
  async handler(ctx, input) {
    let scope = ctx.scope;
    if (input.repo !== undefined) {
      const [owner, repo] = input.repo.toLowerCase().split("/");
      const bound = (await listRepos(ctx.db, ctx.scope)).find(
        (r) => r.owner === owner && r.repo === repo,
      );
      if (!bound) throw new OpError("not_found", "repo not found");
      scope = { orgId: bound.orgId, projectId: bound.projectId };
    }
    const sha = input.sha.toLowerCase();
    const rows = await runsForSha(ctx.db, scope, sha);
    // Newest first: per (project, workflow) pick the first non-cancelled run, else the newest.
    const picked = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = `${row.projectId}:${row.workflowPath}`;
      const cur = picked.get(key);
      if (!cur || (cur.status === "cancelled" && row.status !== "cancelled")) picked.set(key, row);
    }
    const chosen = [...picked.values()].sort((x, y) => (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
    const states = chosen.map((r) => r.status as JobState);
    const jobRows = await jobsForRuns(
      ctx.db,
      scope,
      chosen.map((r) => r.id),
    );
    const byRun = new Map<string, RunJobRow[]>();
    for (const j of jobRows) byRun.set(j.runId, [...(byRun.get(j.runId) ?? []), j]);
    const modes = new Map<string, "shadow" | "live">();
    const modeOf = async (r: (typeof rows)[number]): Promise<"shadow" | "live"> => {
      let m = modes.get(r.projectId);
      if (!m) {
        const mode = await effectiveChecksMode(ctx.settings, ctx.db, r.orgId, r.projectId);
        m = mode === "shadow" ? "shadow" : "live";
        modes.set(r.projectId, m);
      }
      return m;
    };
    // Counts follow the verdict: cancelled runs only count when nothing else ran.
    const counted = chosen.filter((r) => r.status !== "cancelled");
    const countRuns = counted.length > 0 ? counted : chosen;
    const counts = Object.fromEntries(JOB_STATES.map((s) => [s, 0])) as Record<JobState, number>;
    for (const r of countRuns) for (const j of byRun.get(r.id) ?? []) counts[j.state]++;
    const runs = [];
    for (const r of chosen) {
      const mode = await modeOf(r);
      const all = byRun.get(r.id) ?? [];
      runs.push({
        id: r.id,
        project: r.projectSlug,
        workflow_path: r.workflowPath,
        state: r.status as JobState,
        jobs: all.slice(0, MAX_JOBS_PER_RUN).map((j) => ({
          job_id: j.id,
          check_name: checkName(mode, j, checkScopeOf(r.plan)),
          conclusion: j.state,
          attempt: j.attempt,
        })),
        jobs_truncated: all.length > MAX_JOBS_PER_RUN,
      });
    }
    return { sha, state: verdict(states), counts, runs };
  },
});
