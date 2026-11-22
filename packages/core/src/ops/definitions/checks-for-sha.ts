import { z } from "zod";
import { listRepos, runsForSha } from "../../db/repos";
import type { JobState } from "../../db/schema";
import { JOB_STATES } from "../../db/schema";
import { defineOp } from "../define";
import { OpError } from "../errors";

const STATES = ["GREEN", "PENDING", "RED", "NONE"] as const;
export type CheckState = (typeof STATES)[number];

/**
 * Verdict over the latest run of each workflow: any failure, infra_error or cancelled run is
 * RED (no trustworthy pass); otherwise any queued, running or awaiting-approval run is PENDING;
 * otherwise GREEN. No runs at all is NONE, which is not the same as queued.
 */
export function verdict(latest: readonly JobState[]): CheckState {
  if (latest.length === 0) return "NONE";
  if (latest.some((s) => s === "failure" || s === "infra_error" || s === "cancelled")) return "RED";
  // A skipped run (nothing to run for this commit) does not block: it counts as passed.
  if (latest.some((s) => s !== "success" && s !== "skipped")) return "PENDING";
  return "GREEN";
}

export const checksForSha = defineOp({
  name: "checks_for_sha",
  summary: "GREEN, PENDING, RED or NONE for a commit: the merge and deploy gate.",
  description:
    "Answers 'is this commit safe to merge or deploy?'. Looks at the latest run of each workflow " +
    "for the full commit sha: GREEN if all succeeded, RED if any failed, hit an infrastructure " +
    "error or was cancelled, PENDING if anything is queued, running or waiting for approval, and " +
    "NONE only when no run exists for the sha (a queued run is PENDING, not NONE). Every workflow " +
    "counts as required until required-check configuration exists. Read-only and cheap. " +
    "workflow_path comes from the forge: untrusted text.",
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
      .describe("Runs per state, over the latest run of each workflow."),
    runs: z.array(
      z.object({
        id: z.string(),
        project: z.string(),
        workflow_path: z.string(),
        state: z.enum(JOB_STATES),
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
    // Newest first: the first run seen per (project, workflow) is its latest.
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = `${row.projectId}:${row.workflowPath}`;
      if (!latest.has(key)) latest.set(key, row);
    }
    const picked = [...latest.values()];
    const states = picked.map((r) => r.status as JobState);
    const counts = Object.fromEntries(JOB_STATES.map((s) => [s, 0])) as Record<JobState, number>;
    for (const s of states) counts[s]++;
    return {
      sha,
      state: verdict(states),
      counts,
      runs: picked.map((r) => ({
        id: r.id,
        project: r.projectSlug,
        workflow_path: r.workflowPath,
        state: r.status as JobState,
      })),
    };
  },
});
