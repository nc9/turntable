// Graceful drain (#446): while draining, the scheduler starts no new attempts. Queued work stays
// queued in the database and running attempts finish. The flag lives in this process only and is
// never persisted, so a restart (a deploy) always boots undrained and the queue resumes.

/** What a drain does with running attempts of projects that gate nothing (checks `shadow` or `off`). */
export type ShadowDrainMode = "wait" | "cancel";

export type DrainSnapshot = { draining: boolean; since: number | null; reason: string | null };

export class DrainState {
  #since: number | null = null;
  #reason: string | null = null;
  #running: () => number = () => 0;
  #shadow: ShadowDrainMode = "wait";
  #shadowCut = 0;
  #cutter: () => Promise<number> = async () => 0;

  /** Stops running shadow attempts and returns how many (set by the scheduler, #480). */
  trackShadowCutter(cut: () => Promise<number>): void {
    this.#cutter = cut;
  }

  get shadowMode(): ShadowDrainMode {
    return this.#shadow;
  }

  /** Shadow attempts cut since this drain began. */
  get shadowCut(): number {
    return this.#shadowCut;
  }

  /**
   * Sets what the drain does with shadow attempts. `cancel` stops each running attempt of a
   * non-live project now (once, as an infra cut) and counts it; `wait` leaves them. A no-op when
   * not draining.
   */
  async applyShadow(mode: ShadowDrainMode): Promise<void> {
    if (this.#since === null) return;
    this.#shadow = mode;
    if (mode === "cancel") this.#shadowCut += await this.#cutter();
  }

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
      this.#shadow = "wait";
      this.#shadowCut = 0;
    } else if (!on) {
      this.#since = null;
      this.#reason = null;
      this.#shadow = "wait";
      this.#shadowCut = 0;
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
