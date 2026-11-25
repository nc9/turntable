// A per-caller sliding-window limit for read ops that reach another process (the release lane),
// so one token cannot hammer it. In-memory, per process. The refusal is the standard one: a
// `rate_limited` OpError carrying `retry_after_seconds`, as `resync_installation` gives.
import { OpError } from "./errors";

export const READ_LIMIT = 30;
export const READ_WINDOW_MS = 60_000;

export type ReadLimiter = { take(key: string, now: number): void };

export function createReadLimiter(
  limit: number = READ_LIMIT,
  windowMs: number = READ_WINDOW_MS,
): ReadLimiter {
  const recent = new Map<string, number[]>();
  return {
    take(key, now) {
      const times = (recent.get(key) ?? []).filter((t) => now - t < windowMs);
      if (times.length >= limit) {
        recent.set(key, times);
        const wait = Math.max(1, Math.ceil((times[0]! + windowMs - now) / 1000));
        throw new OpError("rate_limited", `too many reads: try again in ${wait}s`, {
          retry_after_seconds: wait,
        });
      }
      times.push(now);
      recent.set(key, times);
    },
  };
}

/** The process-wide limiter for release_public_key. */
export const releaseKeyReads: ReadLimiter = createReadLimiter();
