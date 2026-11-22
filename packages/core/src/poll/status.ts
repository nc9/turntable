import type { RateLimitInfo } from "./github";

export type RepoStatus = {
  repo: string;
  org: string;
  project: string;
  lastPollAt: number | null;
  lastOutcome: "ok" | "rate_limited" | "error" | null;
  /** Short, token-free description of the last failure. */
  lastError: string | null;
  nextPollAt: number | null;
  consecutiveFailures: number;
  runsCreated: number;
};

/**
 * What the poller is doing, for monitoring (the `ingest_status` operation). In-process state: a
 * snapshot of the one poller running in this process, never persisted and never holding secrets.
 */
export const ingestStatus: {
  running: boolean;
  rateLimit: RateLimitInfo | undefined;
  repos: Map<string, RepoStatus>;
} = { running: false, rateLimit: undefined, repos: new Map() };

export function resetIngestStatus(): void {
  ingestStatus.running = false;
  ingestStatus.rateLimit = undefined;
  ingestStatus.repos.clear();
}
