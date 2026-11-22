// Backing off from a forge's rate limit instead of failing a job at once. GitHub says when to
// come back: `retry-after` for a secondary limit, `x-ratelimit-reset` (epoch seconds) once the
// primary budget is gone. A bounded total wait keeps a stuck limit from holding a job forever.
import type { SafeFetch } from "./client";

export class RateLimitedError extends Error {
  /** How long the forge asked us to wait, in ms, when it said. */
  readonly waitMs: number | undefined;
  constructor(message: string, waitMs: number | undefined) {
    super(message);
    this.name = "RateLimitedError";
    this.waitMs = waitMs;
  }
}

export interface Backoff {
  /** Total time this budget may spend waiting. */
  readonly budgetMs: number;
  /** Time spent waiting so far. */
  waitedMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly onWait?: ((ms: number, why: string) => void) | undefined;
}

/** A shared wait budget: pass one to everything a job fetches, so the total stays bounded. */
export function createBackoff(
  o: {
    budgetMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    onWait?: (ms: number, why: string) => void;
  } = {},
): Backoff {
  return {
    budgetMs: o.budgetMs ?? 120_000,
    waitedMs: 0,
    sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: o.now ?? Date.now,
    onWait: o.onWait,
  };
}

const DEFAULT_WAIT_MS = 10_000;
const PADDING_MS = 1000;

/**
 * How long to wait if `res` is a rate-limit response, else undefined (a 403 that is a real
 * refusal has neither header and is not retried). 429, or 403 with `retry-after` (secondary
 * limit) or `x-ratelimit-remaining: 0` (primary limit).
 */
export function rateLimitDelayMs(res: Response, nowMs: number): number | undefined {
  if (res.status !== 403 && res.status !== 429) return undefined;
  const retryAfter = Number(res.headers.get("retry-after"));
  if (res.headers.get("retry-after") !== null && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return retryAfter * 1000 + PADDING_MS;
  }
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (res.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1000 - nowMs) + PADDING_MS;
  }
  return res.status === 429 ? DEFAULT_WAIT_MS : undefined;
}

/**
 * Fetches with `f`; on a rate limit waits as the forge asked (within the shared budget) and tries
 * again. When the wait would overspend the budget it throws RateLimitedError, naming when the
 * limit resets, so the caller can fail the job with a clear reason.
 */
export async function fetchWithBackoff(
  f: SafeFetch,
  input: string,
  init: Parameters<SafeFetch>[1],
  backoff: Backoff,
): Promise<Response> {
  for (;;) {
    const res = await f(input, init);
    const delay = rateLimitDelayMs(res, backoff.now());
    if (delay === undefined) return res;
    if (backoff.waitedMs + delay > backoff.budgetMs) {
      throw new RateLimitedError(
        `rate limited (HTTP ${res.status}); the limit resets in ${Math.ceil(delay / 1000)}s, past this job's ${Math.round(backoff.budgetMs / 1000)}s wait budget`,
        delay,
      );
    }
    backoff.waitedMs += delay;
    backoff.onWait?.(delay, `HTTP ${res.status}`);
    await backoff.sleep(delay);
  }
}
