/**
 * Exponential backoff for a failing poll, never shorter than what the server asked for.
 * `failures` counts consecutive failures including this one (>= 1).
 */
export function backoffMs(o: {
  intervalMs: number;
  failures: number;
  /** Longest delay from the exponential part. */
  capMs?: number;
  /** `Retry-After`, in ms, when the server sent one. */
  retryAfterMs?: number | undefined;
  /** When the rate limit resets (epoch ms), when the server said. */
  resetAt?: number | undefined;
  now: number;
}): number {
  const cap = o.capMs ?? 3_600_000;
  const exponential = Math.min(o.intervalMs * 2 ** Math.max(0, o.failures - 1), cap);
  const untilReset = o.resetAt === undefined ? 0 : Math.max(0, o.resetAt - o.now);
  return Math.max(exponential, o.retryAfterMs ?? 0, untilReset, o.intervalMs);
}
