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
} from "./types";

/**
 * Typed client aligned with the planned operations registry (#22): `listRuns`, `getRun`,
 * `jobLog`, `checksForSha`, `rerun`, `cancel` and `events` map one-to-one onto the MCP/REST
 * operations `list_runs`, `get_run`, `job_log`, `checks_for_sha`, `rerun`, `cancel` and `events`.
 * `listOrgs` and `listProjects` are navigation helpers the registry will need to expose.
 */
export interface TurntableApi {
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
  rerun(args: { runId: string; jobId?: string }): Promise<{ runId: string }>;
  cancel(args: { runId: string }): Promise<void>;
  /** Event feed from a cursor (the same events the realtime transport pushes). */
  events(args: {
    cursor: string | null;
    limit?: number;
  }): Promise<{ events: ChangeEvent[]; cursor: string }>;
}
