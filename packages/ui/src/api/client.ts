import type { ChangeEvent } from "./realtime";
import type {
  CheckSummary,
  LogSlice,
  Org,
  Project,
  Run,
  RunDetail,
  RunFilter,
  StepEvent,
  CutRecord,
  ApproveResult,
  GrepResult,
  IngestStatus,
  JobDigest,
  RerunResult,
  Whoami,
} from "./types";

/**
 * Typed client aligned with the planned operations registry (#22): `listRuns`, `getRun`,
 * `jobLog`, `checksForSha`, `rerun`, `cancel` and `events` map one-to-one onto the MCP/REST
 * operations `list_runs`, `get_run`, `job_log`, `checks_for_sha`, `rerun`, `cancel` and `events`.
 * `listOrgs` and `listProjects` are navigation helpers the registry will need to expose.
 */
export type ApiCapabilities = {
  /** The API can rerun jobs of a run (`rerun`). */
  rerun: boolean;
  /** The API can approve a held run (`approve_run`). */
  approve: boolean;
};

export interface LongshoreApi {
  readonly capabilities: ApiCapabilities;
  listOrgs(): Promise<Org[]>;
  listProjects(orgId: string): Promise<Project[]>;
  listRuns(filter: RunFilter): Promise<{ runs: Run[]; nextCursor: string | null }>;
  getRun(runId: string): Promise<RunDetail>;
  /** Read log bytes by offset. Used for the initial window, load-more and raw download. */
  jobLog(args: { attemptId: string; offset: number; limit: number }): Promise<LogSlice>;
  /** Step boundaries for an attempt that have occurred so far (out of band from the log bytes). */
  jobSteps(args: { attemptId: string }): Promise<StepEvent[]>;
  /** Output-cap cuts for an attempt, as metadata (never text in the log). */
  jobCuts(args: { attemptId: string }): Promise<CutRecord[]>;
  checksForSha(args: { projectId: string; sha: string }): Promise<CheckSummary>;
  /** Reruns jobs of a run (by job key; omit for the failed ones) with a reason that is audited. */
  rerun(args: { runId: string; jobKeys?: string[]; reason: string }): Promise<RerunResult>;
  /** The caller's role and scope. */
  whoami(): Promise<Whoami>;
  /** Releases a run held for an untrusted author, bound to the sha and workflow hash read. */
  approveRun(args: {
    runId: string;
    headSha: string;
    workflowHash: string;
  }): Promise<ApproveResult>;
  /** Why failing jobs failed: step, basis and an excerpt (plain text). */
  failureDigest(args: {
    runId?: string;
    jobId?: string;
  }): Promise<{ failingJobs: number; digests: JobDigest[] }>;
  /** Server-side search of a job's whole log, for hits beyond the part loaded in the viewer. */
  grepLog(args: {
    attemptId: string;
    pattern: string;
    regex?: boolean;
    ignoreCase?: boolean;
    context?: number;
    maxMatches?: number;
    fromOffset?: number;
  }): Promise<GrepResult>;
  /** Per-repo poll ingest status and the forge rate budget. */
  ingestStatus(): Promise<IngestStatus>;
  cancel(args: { runId: string }): Promise<void>;
  /** Event feed from a cursor (the same events the realtime transport pushes). */
  events(args: {
    cursor: string | null;
    limit?: number;
  }): Promise<{ events: ChangeEvent[]; cursor: string }>;
}
