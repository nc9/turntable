// Domain types for the UI. They mirror packages/core/src/db/schema.ts (ids are ULID strings,
// timestamps are epoch milliseconds) and are meant to be replaced by types generated from the
// operations registry (#22) once it exists. Keep field names identical to the schema.

export const JOB_STATES = [
  "queued",
  "running",
  "success",
  "failure",
  "infra_error",
  "awaiting_approval",
  "cancelled",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export type Org = { id: string; slug: string; name: string };

export type Project = {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  /** "owner/repo" of the bound forge repo. */
  repo: string;
};

export type Run = {
  id: string;
  orgId: string;
  projectId: string;
  workflowPath: string;
  workflowName: string;
  event: string;
  ref: string;
  sha: string | null;
  commitMessage: string;
  actor: string;
  status: JobState;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export type Job = {
  id: string;
  orgId: string;
  projectId: string;
  runId: string;
  jobKey: string;
  name: string;
  state: JobState;
  /** jobKeys this job depends on (the `needs:` edges of the job graph). */
  needs: string[];
  /** Matrix leg values, or null for a plain job. Legs of one matrix share `matrixGroup`. */
  matrix: Record<string, string> | null;
  matrixGroup: string | null;
  exitCode: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export type JobAttempt = {
  id: string;
  orgId: string;
  projectId: string;
  jobId: string;
  attempt: number;
  state: JobState;
  provider: string;
  sandboxId: string | null;
  exitCode: number | null;
  /** Set for infra_error: a short machine class such as "sandbox_create_failed". */
  errorClass: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export type RunDetail = { run: Run; jobs: Job[]; attempts: JobAttempt[] };

export type CheckSummary = {
  sha: string;
  state: JobState | "none";
  runs: { runId: string; workflowName: string; status: JobState }[];
};

export type RunFilter = {
  projectId: string;
  status?: JobState;
  branch?: string;
  event?: string;
  limit?: number;
  cursor?: string;
};

/** Raw log bytes for one attempt. `offset` is a byte position; `size` is the bytes available now. */
export type LogSlice = {
  attemptId: string;
  offset: number;
  bytes: Uint8Array;
  size: number;
  /** True when the attempt is finished and `offset + bytes.length === size`. */
  done: boolean;
};
