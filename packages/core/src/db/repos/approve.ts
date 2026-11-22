// Approving a run held for a human (untrusted author). Part of the only code that names tenant
// tables. An approval is bound to the run's head sha and workflow hash, it releases jobs and
// records who approved what, and it never touches the run's trust class.
import { eq } from "drizzle-orm";
import type { Db } from "..";
import { aggregateRunStatus } from "../job-state";
import * as s from "../schema";
import {
  getRun,
  listAttempts,
  listJobs,
  setRunStatus,
  transitionJob,
  updateAttempt,
} from "./index";
import { effectiveStates } from "./readiness";
import { type Scope, scoped } from "./scope";

export type RunApproval = { by: string; at: number; head_sha: string; workflow_hash: string };

export class ApproveError extends Error {
  readonly code: "conflict";
  constructor(message: string) {
    super(message);
    this.code = "conflict";
  }
}

/** The stored trust decision of a run, or undefined when it has none or it does not parse. */
export function parseTrust(run: {
  trust: string | null;
}): { class: string; workflowHash: string } | undefined {
  if (run.trust === null) return undefined;
  try {
    const t = JSON.parse(run.trust) as { class?: unknown; workflowHash?: unknown };
    return typeof t.class === "string" && typeof t.workflowHash === "string"
      ? { class: t.class, workflowHash: t.workflowHash }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Releases the jobs of a run that wait for an untrusted author. `headSha` and `workflowHash` must
 * equal what the run was decided on: approving is "I read this commit and this workflow", and
 * anything else (a newer push is a different run) is refused. Works again on a run that already
 * holds an approval (a rerun sends jobs back to waiting). Returns undefined when the run is not
 * in scope.
 */
export function approveRun(
  db: Db,
  scope: Scope,
  runId: string,
  input: { headSha: string; workflowHash: string; by: string; now?: number },
): Promise<{ released: number; approval: RunApproval; state: string } | undefined> {
  return db.transaction(async (tx) => {
    const run = await getRun(tx, scope, runId);
    if (!run) return undefined;
    const trust = parseTrust(run);
    if (!trust) throw new ApproveError("the run has no recorded trust decision");
    if (run.sha === null || run.sha.toLowerCase() !== input.headSha.toLowerCase()) {
      throw new ApproveError("head_sha is not the sha of this run");
    }
    if (trust.workflowHash !== input.workflowHash.toLowerCase()) {
      throw new ApproveError("workflow_hash is not the hash of this run's workflow");
    }
    const jobs = (await listJobs(tx, scope, runId)).filter(
      (j) => j.state === "awaiting_approval" && j.approvalKind === "untrusted_author",
    );
    if (jobs.length === 0) throw new ApproveError("no job of this run is waiting for approval");
    for (const job of jobs) {
      await transitionJob(tx, scope, job.id, "queued");
      const waiting = (await listAttempts(tx, scope, job.id)).findLast(
        (a) => a.state === "awaiting_approval",
      );
      if (waiting) await updateAttempt(tx, scope, waiting.id, { state: "queued" });
    }
    const approval: RunApproval = {
      by: input.by,
      at: input.now ?? Date.now(),
      head_sha: run.sha.toLowerCase(),
      workflow_hash: trust.workflowHash,
    };
    // Only the approval is written: the trust column (the class) is left exactly as decided.
    await tx.orm
      .update(s.runs)
      .set({ approval: JSON.stringify(approval) })
      .where(
        scoped(scope, { orgId: s.runs.orgId, projectId: s.runs.projectId }, eq(s.runs.id, runId)),
      );
    const all = await listJobs(tx, scope, runId);
    const status = aggregateRunStatus(effectiveStates(all));
    await setRunStatus(tx, scope, runId, status);
    return { released: jobs.length, approval, state: status };
  });
}
