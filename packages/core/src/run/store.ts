import {
  type Db,
  type Scope,
  appendAudit,
  appendLog,
  type StepInput,
  createAttempt,
  createJob,
  createRun,
  setRunStatus,
  transitionJob,
  updateAttempt,
  upsertStep,
} from "../db";
import { aggregateRunStatus } from "../db/job-state";
import type { JobState, StepResult, StepStage } from "../db/schema";

export type FinalState = "success" | "failure" | "infra_error" | "cancelled" | "skipped";

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

export interface JobIds {
  runId: string;
  jobId: string;
  attemptId: string;
}

export interface RunMeta {
  workflowPath: string;
  event: string;
  ref: string;
  sha?: string;
  workflowName?: string;
  commitMessage?: string;
  actor?: string;
  headBranch?: string;
}

/** What the orchestration needs from persistence. `dbRunStore` is the real one. */
export interface RunStore {
  beginRun(meta: RunMeta): Promise<{ runId: string }>;
  /** Creates a queued job row. */
  createJob(
    runId: string,
    job: {
      jobKey: string;
      jobName: string;
      needs: readonly string[];
      matrix?: Record<string, unknown>;
    },
  ): Promise<{ jobId: string }>;
  /** Creates an attempt and marks job, attempt and run running. */
  startAttempt(runId: string, jobId: string, provider: string): Promise<JobIds>;
  /** `createdAt`: epoch ms the provider's create returned (the sandbox is billed from here). */
  setSandbox(attemptId: string, sandboxId: string, createdAt?: number): Promise<void>;
  /** The provider confirmed the sandbox is destroyed, at `at` (epoch ms). */
  setSandboxDestroyed?(attemptId: string, at: number): Promise<void>;
  /** Records act's exec id as soon as it starts, so a controller restarted mid-run can re-attach. */
  setExec?(attemptId: string, execId: string): Promise<void>;
  /** Clears stored log, steps and cuts before a re-attached run replays the whole exec log. */
  resetOutput?(attemptId: string): Promise<void>;
  appendLog(attemptId: string, offset: number, bytes: Uint8Array): Promise<void>;
  recordStep(attemptId: string, step: StepRecord): Promise<void>;
  /** A job that never ran (skipped, unsupported): state skipped, the reason kept as its log. */
  skipJob(runId: string, jobId: string, provider: string, reason: string): Promise<void>;
  /** A queued job that will not start (cancelled run, fail-fast). */
  cancelQueuedJob(jobId: string): Promise<void>;
  /** `exitCode`: required non-zero for failure, 0 for success, absent otherwise. */
  finishJob(
    ids: JobIds,
    state: FinalState,
    opts: { exitCode?: number; errorClass?: string },
  ): Promise<void>;
  /** Sets the run status from the job states (continue-on-error failures count as success). */
  finishRun(runId: string, states: readonly FinalState[]): Promise<void>;
  /** Free-form record of how a run was launched (egress, provider, image). */
  recordLaunch(info: Record<string, unknown>): Promise<void>;
}

export function dbRunStore(db: Db, scope: Required<Scope>): RunStore {
  return {
    async beginRun(m) {
      const run = await createRun(db, scope, {
        workflowPath: m.workflowPath,
        event: m.event,
        ref: m.ref,
        ...(m.sha ? { sha: m.sha } : {}),
        workflowName: m.workflowName,
        commitMessage: m.commitMessage,
        actor: m.actor,
        headBranch: m.headBranch,
      });
      return { runId: run.id };
    },
    async createJob(runId, j) {
      const job = await createJob(db, scope, {
        runId,
        jobKey: j.jobKey,
        name: j.jobName,
        needs: j.needs,
        ...(j.matrix ? { matrix: j.matrix } : {}),
      });
      if (!job) throw new Error("job creation failed");
      return { jobId: job.id };
    },
    async startAttempt(runId, jobId, provider) {
      const attempt = await createAttempt(db, scope, { jobId, provider });
      if (!attempt) throw new Error("attempt creation failed");
      const ids = { runId, jobId, attemptId: attempt.id };
      await transitionJob(db, scope, jobId, "running");
      await updateAttempt(db, scope, attempt.id, { state: "running" });
      await setRunStatus(db, scope, runId, "running");
      return ids;
    },
    async setSandbox(attemptId, sandboxId, createdAt) {
      await updateAttempt(db, scope, attemptId, {
        sandboxId,
        ...(createdAt === undefined ? {} : { sandboxCreatedAt: createdAt }),
      });
    },
    async setSandboxDestroyed(attemptId, at) {
      await updateAttempt(db, scope, attemptId, { sandboxDestroyedAt: at });
    },
    async setExec(attemptId, execId) {
      await updateAttempt(db, scope, attemptId, { execId });
    },
    async appendLog(attemptId, offset, bytes) {
      await appendLog(db, scope, attemptId, offset, bytes);
    },
    async recordStep(attemptId, step) {
      await upsertStep(db, scope, stepInputOf(attemptId, step));
    },
    async skipJob(_runId, jobId, provider, reason) {
      const attempt = await createAttempt(db, scope, { jobId, provider });
      if (attempt) {
        await appendLog(db, scope, attempt.id, 0, new TextEncoder().encode(`${reason}\n`));
        await updateAttempt(db, scope, attempt.id, { state: "skipped" });
      }
      await transitionJob(db, scope, jobId, "skipped");
    },
    async cancelQueuedJob(jobId) {
      await transitionJob(db, scope, jobId, "cancelled");
    },
    async finishJob(ids, state, opts) {
      const code = opts.exitCode ?? null;
      await transitionJob(db, scope, ids.jobId, state, { exitCode: code });
      await updateAttempt(db, scope, ids.attemptId, {
        state,
        exitCode: code,
        ...(opts.errorClass ? { errorClass: opts.errorClass } : {}),
      });
    },
    async finishRun(runId, states) {
      await setRunStatus(db, scope, runId, aggregateRunStatus(states as readonly JobState[]));
    },
    async recordLaunch(info) {
      await appendAudit(db, scope, {
        principalKind: "cli",
        principalId: "local",
        op: "run_local",
        effect: "write",
        outcome: "ok",
        input: info,
      });
    },
  };
}

/** The persisted shape of a step the runner reported. Shared by the CLI and the worker. */
export function stepInputOf(attemptId: string, step: StepRecord): StepInput {
  return {
    attemptId,
    stepKey: step.stepKey,
    stage: stageOf(step.stage),
    index: step.index,
    name: step.name,
    result: resultOf(step.result),
    startedAt: step.startedAt ?? null,
    finishedAt: step.endedAt ?? null,
    logOffset: step.logOffset,
  };
}

/** act's Pre, Main and Post map to pre, main and post; set up and complete job are main. */
function stageOf(stage: string): StepStage {
  return stage === "Pre" ? "pre" : stage === "Post" ? "post" : "main";
}

function resultOf(result: string | undefined): StepResult | null {
  if (result === undefined) return null;
  return result === "success" || result === "skipped" || result === "cancelled"
    ? result
    : "failure";
}
