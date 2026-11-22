/**
 * An in-process announcement that attempts were cancelled while running, so a worker in this
 * process can stop them at once (abort signal, sandbox destroyed) instead of at its next
 * heartbeat. Attempts held by a worker in another process still stop at their next heartbeat,
 * which finds the lease gone. Announcements fire only after the cancelling transaction commits.
 */
import type { Db } from ".";

export type CancelledAttempt = { attemptId: string; sandboxId: string | null; provider: string };

type Listener = (attempts: readonly CancelledAttempt[]) => void;
const listeners = new Set<Listener>();

/** Subscribes to cancelled-while-running announcements. Returns the unsubscribe function. */
export function onAttemptsCancelled(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Announces after the surrounding transaction commits (at once outside one). */
export function announceCancelled(db: Db, attempts: readonly CancelledAttempt[]): void {
  if (attempts.length === 0) return;
  db.afterCommit(() => {
    for (const l of listeners) {
      try {
        l(attempts);
      } catch (err) {
        console.error("longshore: a cancel listener failed", err);
      }
    }
  });
}
