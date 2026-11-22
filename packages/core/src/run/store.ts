import {
  type Db,
  type Scope,
  createAttempt,
  createJob,
  createRun,
  setRunStatus,
  transitionJob,
  updateAttempt,
  appendLog,
} from "../db";
import { aggregateRunStatus } from "../db/job-state";

export type FinalState = "success" | "failure" | "infra_error" | "cancelled";

export interface StepRecord {
  stepKey: string;
  /** act stage: Pre, Main, Post or Job (set up and complete). */
  stage: string;
  /** Order of first appearance in the attempt. */
  index: number;
  name: string;
  result?: string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  /** Offset in the stored log where the step's output begins. */
  logOffset: number;
}

/** What the orchestration needs from persistence. `dbRunStore` is the real one. */
export interface RunStore {
  begin(input: {
    workflowPath: string;
    event: string;
    ref: string;
    sha?: string;
    jobKey: string;
    jobName: string;
    provider: string;
  }): Promise<{ runId: string; jobId: string; attemptId: string }>;
  markRunning(ids: { runId: string; jobId: string; attemptId: string }): Promise<void>;
  setSandbox(attemptId: string, sandboxId: string): Promise<void>;
  appendLog(attemptId: string, offset: number, bytes: Uint8Array): Promise<void>;
  recordStep(attemptId: string, step: StepRecord): Promise<void>;
  /** `exitCode`: required non-zero for failure, 0 for success, absent otherwise. */
  finish(
    ids: { runId: string; jobId: string; attemptId: string },
    state: FinalState,
    opts: { exitCode?: number; errorClass?: string },
  ): Promise<void>;
}

export function dbRunStore(db: Db, scope: Required<Scope>): RunStore {
  return {
    async begin(i) {
      const run = await createRun(db, scope, {
        workflowPath: i.workflowPath,
        event: i.event,
        ref: i.ref,
        ...(i.sha ? { sha: i.sha } : {}),
      });
      const job = await createJob(db, scope, { runId: run.id, jobKey: i.jobKey, name: i.jobName });
      if (!job) throw new Error("job creation failed");
      const attempt = await createAttempt(db, scope, { jobId: job.id, provider: i.provider });
      if (!attempt) throw new Error("attempt creation failed");
      return { runId: run.id, jobId: job.id, attemptId: attempt.id };
    },
    async markRunning(ids) {
      await transitionJob(db, scope, ids.jobId, "running");
      await updateAttempt(db, scope, ids.attemptId, { state: "running" });
      await setRunStatus(db, scope, ids.runId, "running");
    },
    async setSandbox(attemptId, sandboxId) {
      await updateAttempt(db, scope, attemptId, { sandboxId });
    },
    async appendLog(attemptId, offset, bytes) {
      await appendLog(db, scope, attemptId, offset, bytes);
    },
    async recordStep() {
      // TODO(schema batch): write attempt_steps rows (step_key, stage, index, name, result,
      // times, log_offset) once that table lands. Until then steps live only in the log text.
    },
    async finish(ids, state, opts) {
      const code = opts.exitCode ?? null;
      await transitionJob(db, scope, ids.jobId, state, { exitCode: code });
      await updateAttempt(db, scope, ids.attemptId, {
        state,
        exitCode: code,
        ...(opts.errorClass ? { errorClass: opts.errorClass } : {}),
      });
      await setRunStatus(db, scope, ids.runId, aggregateRunStatus([state]));
    },
  };
}
