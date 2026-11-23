import type { RateLimitInfo } from "./github";

/** How a repo's requests are authenticated; each mode has its own GitHub budget. */
export type PollAuthMode = "anonymous" | "token" | "installation";

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
  /** The auth mode of the last poll (installation, or the fallback), null before the first. */
  authMode: PollAuthMode | null;
  /** The budget of that mode as last seen for this repo. */
  rateLimit: RateLimitInfo | undefined;
};

/**
 * What the poller is doing, for monitoring (the `ingest_status` operation). In-process state: a
 * snapshot of the one poller running in this process, never persisted and never holding secrets.
 */
export const ingestStatus: {
  running: boolean;
  /** The budget of the fallback client (the poll token, or anonymous). */
  rateLimit: RateLimitInfo | undefined;
  /** Which of those the fallback is. */
  fallbackAuth: Exclude<PollAuthMode, "installation">;
  repos: Map<string, RepoStatus>;
} = {
  running: false,
  rateLimit: undefined,
  fallbackAuth: "anonymous",
  repos: new Map(),
};

export function resetIngestStatus(): void {
  ingestStatus.running = false;
  ingestStatus.rateLimit = undefined;
  ingestStatus.fallbackAuth = "anonymous";
  ingestStatus.repos.clear();
}
