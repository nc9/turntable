// Response shapes of the REST API (`/api/v1`), written to match docs/openapi.json. The contract
// test in tests/openapi-contract.test.ts fails when the spec stops matching what is listed here,
// so a server change cannot silently break the adapter.
import type { JobState } from "./types";

export type WireRun = {
  id: string;
  project: string;
  workflow_path: string;
  event: string;
  ref: string;
  sha: string | null;
  state: JobState;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
};

export type WireAttempt = {
  id: string;
  attempt: number;
  state: JobState;
  provider: string;
  exit_code: number | null;
  error_class: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
};

export type WireJob = {
  id: string;
  job_key: string;
  name: string;
  state: JobState;
  exit_code: number | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  infra_error_reason: string | null;
  attempts: WireAttempt[];
  log_path: string | null;
};

export type WireRunDetail = WireRun & { jobs: WireJob[] };
export type WireRunList = { runs: WireRun[]; next_cursor: string | null };

export type WireLog = {
  job_id: string;
  attempt: number | null;
  mode: "head" | "tail" | "range";
  text: string;
  offset: number;
  bytes: number;
  total_bytes: number;
  next_offset: number | null;
  truncated: boolean;
};

export type WireChecks = {
  sha: string;
  state: "GREEN" | "PENDING" | "RED" | "NONE";
  counts: Record<string, unknown>;
  runs: { id: string; project: string; workflow_path: string; state: JobState }[];
};

export type WireCancel = {
  run_id: string;
  state: JobState;
  cancelled_jobs: number;
  unchanged_jobs: number;
};

export type WireError = { error: { code: string; message: string; details?: unknown } };
