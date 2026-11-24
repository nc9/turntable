// Graceful drain (#446): while draining, the scheduler starts no new attempts. Queued work stays
// queued in the database and running attempts finish. The flag lives in this process only and is
// never persisted, so a restart (a deploy) always boots undrained and the queue resumes.

export type DrainSnapshot = { draining: boolean; since: number | null; reason: string | null };

export class DrainState {
  #since: number | null = null;
  #reason: string | null = null;
  #running: () => number = () => 0;

  /** Attempts this process is running, for `/healthz` (set by the scheduler). */
  trackRunning(count: () => number): void {
    this.#running = count;
  }

  get runningHere(): number {
    return this.#running();
  }

  get draining(): boolean {
    return this.#since !== null;
  }

  /** Turning it on twice keeps the first time and reason. */
  set(on: boolean, reason: string, now: number): DrainSnapshot {
    if (on && this.#since === null) {
      this.#since = now;
      this.#reason = reason;
    } else if (!on) {
      this.#since = null;
      this.#reason = null;
    }
    return this.snapshot();
  }

  snapshot(): DrainSnapshot {
    return { draining: this.#since !== null, since: this.#since, reason: this.#reason };
  }
}

/** The process's own drain state: the scheduler, `instance_drain`, `/healthz` and doctor share it. */
export const processDrain = new DrainState();

/** Resets the process state (tests, and a fresh boot in one process). */
export function resetProcessDrain(): void {
  processDrain.set(false, "", 0);
}
