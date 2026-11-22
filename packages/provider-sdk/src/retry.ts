// Retrying provider calls that fail for a moment. A control plane that answers one request in a
// hundred with a timeout must not end a twenty-minute job: only a call that stays broken for the
// whole budget becomes an InfraError.
import { InfraError, TransientError } from "./errors";

export interface RetryOptions {
  /** Total time to keep trying one call. Default 3 minutes. */
  budgetMs?: number;
  /** First backoff; doubles each attempt, with jitter. Default 500 ms. */
  baseMs?: number;
  /** Longest single backoff. Default 15 s. */
  maxMs?: number;
  /** Called once per retry, with the call label and attempt number. No secrets in either. */
  log?: (message: string) => void;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export const DEFAULT_RETRY_BUDGET_MS = 180_000;

/**
 * Runs `fn`, retrying only TransientError with jittered exponential backoff until the budget is
 * spent. Anything else (a missing sandbox, a bad request, an auth failure) passes straight
 * through. When the budget runs out, the error says how many attempts and what the last one was.
 * `fn` must be safe to run again: never pass a call that starts something.
 */
export async function retryTransient<T>(
  label: string,
  fn: () => Promise<T>,
  o: RetryOptions = {},
): Promise<T> {
  const budget = o.budgetMs ?? DEFAULT_RETRY_BUDGET_MS;
  const base = o.baseMs ?? 500;
  const max = o.maxMs ?? 15_000;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = o.now ?? Date.now;
  const random = o.random ?? Math.random;
  const start = now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof TransientError)) throw e;
      const delay = Math.min(max, base * 2 ** (attempt - 1)) * (0.5 + random() * 0.5);
      if (now() - start + delay > budget) {
        throw new InfraError(
          `${label}: still failing after ${attempt} attempts over ${Math.round((now() - start) / 1000)}s; last error: ${e.message}`,
          e,
        );
      }
      o.log?.(
        `${label}: attempt ${attempt} failed (${e.message}); retrying in ${Math.round(delay)}ms`,
      );
      await sleep(delay);
    }
  }
}
