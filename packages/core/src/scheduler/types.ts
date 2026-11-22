import type { Provider } from "@turntable/provider-sdk";
import type { Job, JobAttempt, Run, Scope } from "../db/repos";
import type { StepInput } from "../db/repos";

/** What a runner reports when it is done. `exitCode` is 0 for success, non-zero for failure. */
export type AttemptOutcome = {
  state: "success" | "failure" | "skipped" | "infra_error" | "cancelled";
  exitCode?: number | undefined;
  /** Short cause. Stored as the attempt's error class for infra_error. */
  reason: string;
};

/** Persistence a runner may use while running. Every call is fenced by the attempt's lease. */
export interface AttemptStore {
  /** Records the sandbox (and exec) so a restarted controller can find and probe them. */
  setExec(where: { sandboxId?: string; execId?: string }): Promise<void>;
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
