// Concurrency limit for job_log grep: it is CPU work on the single server thread, so one reader
// must not be able to start many at once. In-memory, per process.
import { OpError } from "./errors";

export const GREP_MAX_PER_PRINCIPAL = 2;
export const GREP_MAX_INSTANCE = 8;

export type GrepSlots = {
  /** Takes a slot or throws rate_limited. Call the returned function once to release it. */
  acquire(principal: string): () => void;
};

export function createGrepSlots(
  perPrincipal: number = GREP_MAX_PER_PRINCIPAL,
  instance: number = GREP_MAX_INSTANCE,
): GrepSlots {
  const held = new Map<string, number>();
  let total = 0;
  return {
    acquire(principal) {
      const mine = held.get(principal) ?? 0;
      if (mine >= perPrincipal || total >= instance) {
        throw new OpError(
          "rate_limited",
          mine >= perPrincipal
            ? `busy: ${perPrincipal} greps already running for this caller; retry in a few seconds`
            : "busy: the server is running its limit of greps; retry in a few seconds",
          { retry_after_seconds: 2 },
        );
      }
      held.set(principal, mine + 1);
      total++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        total--;
        const n = (held.get(principal) ?? 1) - 1;
        if (n <= 0) held.delete(principal);
        else held.set(principal, n);
      };
    },
  };
}

/** The process-wide limiter job_log uses. */
export const grepSlots: GrepSlots = createGrepSlots();
