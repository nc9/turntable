import type { Provider } from "@turntable/provider-sdk";
import type { Job, JobAttempt, Run, Scope } from "../db/repos";
import type { StepInput } from "../db/repos";

/** What a runner reports when it is done. `exitCode` is 0 for success, non-zero for failure. */
export type AttemptOutcome = {
  state: "success" | "failure" | "skipped" | "infra_error" | "cancelled";
  exitCode?: number | undefined;
  /** Short cause. Stored as the attempt's error class for infra_error. */
  reason: string;
  /** The job's declared outputs, kept for its dependents. */
  outputs?: Record<string, string> | undefined;
};

/** Persistence a runner may use while running. Every call is fenced by the attempt's lease. */
export interface AttemptStore {
  /** Records the sandbox (and exec) so a restarted controller can find and probe them. */
  setExec(where: { sandboxId?: string; execId?: string }): Promise<void>;
  /** Stores the resolved job plan (JSON), so a restarted controller can re-attach without the repo. */
  setPlan(planJson: string): Promise<void>;
  /** Clears stored log, steps and cuts, before a re-attached run replays the whole exec log. */
  reset(): Promise<void>;
  appendLog(offset: number, bytes: Uint8Array): Promise<void>;
  recordStep(step: Omit<StepInput, "attemptId">): Promise<void>;
  addCut(cut: { atOffset: number; omittedBytes: number; reason: string }): Promise<void>;
}

export interface AttemptContext {
  attempt: JobAttempt;
  job: Job;
  run: Run;
  scope: Required<Scope>;
  provider: Provider;
  /**
   * Set when this attempt was started by a worker that died and is being re-attached to: the
   * sandbox and exec it left. A runner that can re-attach replays the exec and returns the real
   * outcome; one that cannot should end the attempt as infra_error.
   */
  resume?: { sandboxId: string; execId: string };
  /** Aborted when the lease is lost (cancelled, reconciled) or the scheduler stops hard. */
  signal: AbortSignal;
  store: AttemptStore;
}

/**
 * Runs one claimed attempt to completion and says how it ended. A runner never touches attempt,
 * job or run state itself: the scheduler records the outcome, fenced by the lease. Throwing is an
 * infra_error. Must stop promptly when `signal` aborts (destroy the sandbox).
 */
export type AttemptRunner = (ctx: AttemptContext) => Promise<AttemptOutcome>;

/** Picks the provider for an attempt by the name stored on it. */
export type ProviderResolver = (name: string) => Provider | undefined;
